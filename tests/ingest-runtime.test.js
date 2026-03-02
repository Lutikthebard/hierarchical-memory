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
      loadStore: () => ({ messages: [], artifacts: {} }),
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

  it('preserves persisted artifacts when message ingestion saves stale in-memory store', async () => {
    const state = {
      currentSessionKey: 'agent:test-agent:main',
      currentStoreRef: null,
      currentJsonlPath: null
    };

    const existingArtifact = {
      artifactId: 'a1',
      level: 1,
      content: 'L1 summary',
      startTimestamp: '2026-01-01T00:00:00.000Z',
      endTimestamp: '2026-01-01T00:01:00.000Z',
      createdAt: '2026-01-01T00:01:01.000Z'
    };
    const storeRef = { current: { messages: [], artifacts: {} } };
    let savedStore = null;

    const runtime = createIngestRuntime({
      state,
      fs: require('fs'),
      spawn: () => {
        throw new Error('spawn not used in this test');
      },
      processRef: process,
      loadAgentConfig: () => ({
        thresholds: { L1: 99, default: 99 },
        autoCompact: { enabled: false }
      }),
      parseMessage: () => ({
        role: 'user',
        content: 'new incoming message',
        timestamp: '2026-01-01T00:02:00.000Z',
        messageClass: 'dialogue',
        shouldCount: true
      }),
      addMessage: (store, msg) => {
        store.messages.push(msg);
        return msg;
      },
      formatTimestamp: () => '2026-01-01 00:02:00 UTC',
      loadStore: () => ({
        messages: [],
        artifacts: { 1: [existingArtifact] }
      }),
      saveStore: (_agentId, store) => {
        savedStore = JSON.parse(JSON.stringify(store));
      },
      scheduleContextRegenerate: () => {},
      compactController: {
        markMessageProcessed: () => {},
        maybeTriggerOrRetry: async () => {}
      },
      checkThreshold: () => ({ needed: false, items: [] }),
      getThresholdForLevel: () => 99,
      drainThresholdSummarization: async () => {},
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
      message: { role: 'user', content: 'new incoming message', timestamp: '2026-01-01T00:02:00.000Z' }
    });

    const added = await runtime.processLine('test-agent', storeRef, line, { verbose: false });
    assert.equal(added, true);
    assert.equal(Array.isArray(savedStore?.artifacts?.[1]), true);
    assert.equal(savedStore.artifacts[1].length, 1);
    assert.equal(savedStore.artifacts[1][0].artifactId, 'a1');
  });

  it('uses updateStore atomic commit when available', async () => {
    const state = {
      currentSessionKey: 'agent:test-agent:main',
      currentStoreRef: null,
      currentJsonlPath: null
    };

    const storeRef = { current: { messages: [], artifacts: {} } };
    let updateCalls = 0;
    let saveCalls = 0;

    const runtime = createIngestRuntime({
      state,
      fs: require('fs'),
      spawn: () => {
        throw new Error('spawn not used in this test');
      },
      processRef: process,
      loadAgentConfig: () => ({
        thresholds: { L1: 99, default: 99 },
        autoCompact: { enabled: false }
      }),
      parseMessage: () => ({
        role: 'user',
        content: 'atomic',
        timestamp: '2026-01-01T00:03:00.000Z',
        messageClass: 'dialogue',
        shouldCount: true
      }),
      addMessage: (store, msg) => {
        store.messages.push(msg);
        return msg;
      },
      formatTimestamp: () => '2026-01-01 00:03:00 UTC',
      loadStore: () => ({ messages: [], artifacts: {} }),
      saveStore: () => {
        saveCalls += 1;
      },
      updateStore: async (_agentId, mutator) => {
        updateCalls += 1;
        const latest = {
          messages: [],
          artifacts: {
            1: [{
              artifactId: 'existing',
              level: 1,
              content: 'summary',
              startTimestamp: '2026-01-01T00:00:00.000Z',
              endTimestamp: '2026-01-01T00:01:00.000Z',
              createdAt: '2026-01-01T00:01:01.000Z'
            }]
          }
        };
        const result = await mutator(latest);
        return { store: latest, result };
      },
      scheduleContextRegenerate: () => {},
      compactController: {
        markMessageProcessed: () => {},
        maybeTriggerOrRetry: async () => {}
      },
      checkThreshold: () => ({ needed: false, items: [] }),
      getThresholdForLevel: () => 99,
      drainThresholdSummarization: async () => {},
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
      message: { role: 'user', content: 'atomic', timestamp: '2026-01-01T00:03:00.000Z' }
    });

    const added = await runtime.processLine('test-agent', storeRef, line, { verbose: false });
    assert.equal(added, true);
    assert.equal(updateCalls, 1);
    assert.equal(saveCalls, 0);
    assert.equal(storeRef.current.messages.length, 1);
    assert.equal(Array.isArray(storeRef.current.artifacts[1]), true);
    assert.equal(storeRef.current.artifacts[1][0].artifactId, 'existing');
  });
});
