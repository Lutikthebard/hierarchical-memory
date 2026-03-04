const {
  extractTextContent,
  hasArtifactTagForLevel,
  sourceTextMatchesCandidate
} = require('../gateway/artifact-extract');

function toTimestampMs(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const ms = new Date(rawValue).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function resolveEventTimestampMs(message, data) {
  const candidates = [
    toTimestampMs(data?.timestamp),
    toTimestampMs(data?.ts),
    toTimestampMs(message?.timestamp)
  ].filter((value) => Number.isFinite(value));

  if (candidates.length === 0) return Date.now();
  return Math.max(...candidates);
}

function createArtifactStreamRuntime({ logger = console } = {}) {
  const waiters = new Set();

  function waitForArtifact({
    agentId,
    sessionKey = null,
    expectedLevel = null,
    startedAtMs = Date.now(),
    timeoutMs = 12000
  }) {
    const startedMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();

    let settled = false;
    let resolvePromise;
    let rejectPromise;

    const waiter = {
      agentId,
      sessionKey,
      expectedLevel,
      startedAtMs: startedMs,
      resolve(value) {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        resolvePromise(value);
      },
      reject(error) {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        rejectPromise(error);
      },
      timer: null
    };

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    waiter.timer = setTimeout(() => {
      waiter.reject(new Error('artifact_wait_timeout'));
    }, timeoutMs);

    waiters.add(waiter);

    return {
      promise,
      cancel() {
        waiter.reject(new Error('artifact_wait_cancelled'));
      }
    };
  }

  function waitForDeliveredArtifact({
    agentId,
    sessionKey = null,
    expectedLevel = null,
    sourceMessage,
    startedAtMs = Date.now(),
    deliveryTimeoutMs = 1800000,
    responseTimeoutMs = 12000
  }) {
    const source = typeof sourceMessage === 'string' ? sourceMessage : '';
    if (!source.trim()) {
      throw new Error('sourceMessage is required for delivery-aware artifact wait');
    }

    const startedMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();

    let settled = false;
    let resolvePromise;
    let rejectPromise;

    const waiter = {
      mode: 'delivery_then_artifact',
      agentId,
      sessionKey,
      expectedLevel,
      sourceMessage: source,
      startedAtMs: startedMs,
      deliveryAckTsMs: null,
      deliveryTimer: null,
      responseTimer: null,
      resolve(value) {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.deliveryTimer);
        clearTimeout(waiter.responseTimer);
        waiters.delete(waiter);
        resolvePromise(value);
      },
      reject(error) {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.deliveryTimer);
        clearTimeout(waiter.responseTimer);
        waiters.delete(waiter);
        rejectPromise(error);
      },
      ackDelivery(tsMs) {
        if (settled || waiter.deliveryAckTsMs !== null) return;
        waiter.deliveryAckTsMs = tsMs;
        clearTimeout(waiter.deliveryTimer);
        waiter.responseTimer = setTimeout(() => {
          waiter.reject(new Error('artifact_wait_timeout'));
        }, responseTimeoutMs);
        logger.log('[artifact-stream-runtime] Delivery ACK captured, waiting for artifact response');
      }
    };

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    waiter.deliveryTimer = setTimeout(() => {
      waiter.reject(new Error('artifact_delivery_timeout'));
    }, deliveryTimeoutMs);

    waiters.add(waiter);

    return {
      promise,
      cancel() {
        waiter.reject(new Error('artifact_wait_cancelled'));
      }
    };
  }

  function observeLine({ agentId, line, sessionKey = null }) {
    if (!line || !line.trim()) return;

    let data;
    try {
      data = JSON.parse(line);
    } catch (_e) {
      return;
    }

    if (data.type !== 'message') return;

    const message = data.message || data;
    const role = message.role;
    if (role !== 'assistant' && role !== 'user') return;

    const content = typeof message.content === 'string'
      ? message.content
      : extractTextContent(message.content);

    const messageSessionKey = message.sessionKey || data.sessionKey || sessionKey || null;
    const tsMs = resolveEventTimestampMs(message, data);

    for (const waiter of [...waiters]) {
      if (waiter.agentId !== agentId) continue;
      if (waiter.sessionKey && messageSessionKey && waiter.sessionKey !== messageSessionKey) continue;
      if (tsMs < waiter.startedAtMs) continue;

      if (waiter.mode === 'delivery_then_artifact') {
        if (waiter.deliveryAckTsMs === null) {
          if (role !== 'user') continue;
          if (!sourceTextMatchesCandidate(content, waiter.sourceMessage)) continue;
          waiter.ackDelivery(tsMs);
          continue;
        }

        if (role !== 'assistant') continue;
        if (tsMs < waiter.deliveryAckTsMs) continue;
        if (!hasArtifactTagForLevel(content, waiter.expectedLevel)) continue;
        waiter.resolve(content);
        continue;
      }

      if (role !== 'assistant') continue;
      if (!hasArtifactTagForLevel(content, waiter.expectedLevel)) continue;
      waiter.resolve(content);
    }
  }

  function closeAll() {
    for (const waiter of [...waiters]) {
      waiter.reject(new Error('artifact_wait_runtime_closed'));
    }
  }

  return {
    waitForArtifact,
    waitForDeliveredArtifact,
    observeLine,
    closeAll,
    getPendingCount() {
      return waiters.size;
    }
  };
}

module.exports = {
  createArtifactStreamRuntime,
  toTimestampMs,
  resolveEventTimestampMs
};
