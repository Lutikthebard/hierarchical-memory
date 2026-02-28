const crypto = require('crypto');
const { OpenClawClient } = require('../gateway-client');

function createStreamLLMAdapter({
  gatewayUrl,
  gatewayToken,
  timeoutSeconds = 600,
  artifactWaitMs = 60000,
  waitForArtifact,
  logger = console
}) {
  if (typeof waitForArtifact !== 'function') {
    throw new Error('waitForArtifact function is required for stream adapter');
  }

  let client = null;
  let lastCaptureInfo = null;

  async function ensureConnected() {
    if (client) return client;
    client = new OpenClawClient(gatewayUrl, gatewayToken);
    await client.connect();
    return client;
  }

  return {
    async send(agentId, message, options = {}) {
      const sessionKey = options.sessionKey || `agent:${agentId}:main`;
      const expectedLevel = Number.isInteger(Number(options.targetLevel)) && Number(options.targetLevel) > 0
        ? Number(options.targetLevel)
        : null;
      const timeoutMs = Math.max(1000, Number(timeoutSeconds) * 1000);
      const startedAtMs = Date.now();
      const waiter = waitForArtifact({
        agentId,
        sessionKey,
        expectedLevel,
        startedAtMs,
        timeoutMs: artifactWaitMs
      });
      const waiterPromise = waiter.promise;
      waiterPromise.catch(() => {});

      try {
        const gw = await ensureConnected();
        const sendResult = await gw.rpc('chat.send', {
          sessionKey,
          message,
          idempotencyKey: crypto.randomUUID(),
          timeoutMs
        }, timeoutMs + 30000);

        if (!sendResult || !sendResult.runId) {
          throw new Error('No runId returned from chat.send');
        }

        const runWaitPromise = gw.rpc('agent.wait', {
          runId: sendResult.runId,
          timeoutMs
        }, timeoutMs + 30000);

        const firstSettled = await Promise.race([
          waiterPromise.then((artifactText) => ({ kind: 'artifact', artifactText })),
          runWaitPromise.then(() => ({ kind: 'run_done' })).catch((error) => ({ kind: 'run_error', error }))
        ]);

        if (firstSettled.kind === 'run_error') {
          throw firstSettled.error;
        }

        const artifactText = firstSettled.kind === 'artifact'
          ? firstSettled.artifactText
          : await waiterPromise;
        lastCaptureInfo = { method: 'jsonl', collectedCount: 1 };
        return artifactText;
      } catch (error) {
        waiter.cancel();
        await waiterPromise.catch(() => {});
        if (error && error.message === 'artifact_wait_timeout') {
          logger.log('[stream-llm-adapter] Timed out waiting for artifact in stream');
          lastCaptureInfo = { method: 'jsonl-timeout', collectedCount: 0 };
          return '';
        }
        throw error;
      }
    },

    get lastCaptureInfo() {
      return lastCaptureInfo;
    },

    async close() {
      if (!client) return;
      try {
        await client.close();
      } finally {
        client = null;
      }
    }
  };
}

module.exports = {
  createStreamLLMAdapter
};
