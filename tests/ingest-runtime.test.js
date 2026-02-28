const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createIngestRuntime } = require('../scripts/watch-runtime/ingest-runtime');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ingest runtime', () => {
  it('does not block line ingestion while threshold summarization is running', async () => {
    const state = {
      currentSessionKey: 'agent:test-agent:main',
      currentStoreRef: null,
      currentJsonlPath: null
    };

    const storeRef = { current: { messages: [], artifacts: {} } };
    let drainCalls = 0;
    let drainResolved = false;

    const runtime = createIngestRuntime({
      state,
      fs: require('fs'),
      spawn: () => {
        throw new Error('spawn not used in this test');
      },
      processRef: process,
      loadAgentConfig: () => ({
        thresholds: { L1: 1, default: 1 },
        autoCompact: { enabled: false }
      }),
      parseMessage: () => ({
        role: 'user',
        content: 'hello',
        timestamp: '2026-01-01T00:00:00.000Z',
        messageClass: 'dialogue',
        shouldCount: true
      }),
      addMessage: (store, msg) => {
        store.messages.push(msg);
        return msg;
      },
      formatTimestamp: () => '2026-01-01 00:00:00 UTC',
      saveStore: () => {},
      scheduleContextRegenerate: () => {},
      compactController: {
        markMessageProcessed: () => {},
        maybeTriggerOrRetry: async () => {}
      },
      checkThreshold: () => ({ needed: true, items: [{ id: 1 }] }),
      getThresholdForLevel: () => 1,
      drainThresholdSummarization: async () => {
        drainCalls += 1;
        await sleep(120);
        drainResolved = true;
      },
      sendCompactMessageBase: async () => true,
      gatewayUrl: 'ws://127.0.0.1:18789',
      requireSessionKey: () => 'agent:test-agent:main',
      countSessionMessagesFromJsonl: () => 0,
      scheduleContextInject: () => {},
      onRawLine: () => {},
      logger: { log: () => {}, error: () => {} }
    });

    const line = JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' }
    });

    const started = Date.now();
    const added = await runtime.processLine('test-agent', storeRef, line, { verbose: false });
    const elapsedMs = Date.now() - started;

    assert.equal(added, true);
    assert.equal(drainCalls, 1);
    assert.equal(drainResolved, false);
    assert.ok(elapsedMs < 100, `processLine was blocked for ${elapsedMs}ms`);

    await sleep(150);
    assert.equal(drainResolved, true);
  });
});
