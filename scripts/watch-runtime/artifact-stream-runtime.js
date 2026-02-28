const { extractTextContent, hasArtifactTagForLevel } = require('../gateway/artifact-extract');

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
    if (message.role !== 'assistant') return;

    const content = typeof message.content === 'string'
      ? message.content
      : extractTextContent(message.content);

    const messageSessionKey = message.sessionKey || data.sessionKey || sessionKey || null;
    const tsMs = resolveEventTimestampMs(message, data);

    for (const waiter of [...waiters]) {
      if (waiter.agentId !== agentId) continue;
      if (waiter.sessionKey && messageSessionKey && waiter.sessionKey !== messageSessionKey) continue;
      if (tsMs < waiter.startedAtMs) continue;
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
