const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('trigger-ws batch selection', () => {
  const originalDataDir = process.env.HM_DATA_DIR;
  const originalMode = process.env.HM_LLM_MODE;
  const agentId = 'trigger-batch-agent';
  let tmpDir;
  let storeApi;
  let triggerApi;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-trigger-batch-'));
    process.env.HM_DATA_DIR = tmpDir;
    process.env.HM_LLM_MODE = 'mock';

    // Load after HM_DATA_DIR is set so helpers operate on isolated temp store.
    delete require.cache[require.resolve('../scripts/store')];
    delete require.cache[require.resolve('../scripts/trigger-ws')];
    storeApi = require('../scripts/store');
    triggerApi = require('../scripts/trigger-ws');

    const agentDir = path.join(tmpDir, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'config.json'),
      JSON.stringify(
        {
          thresholds: { L1: 2, default: 2 },
          filters: {
            exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
            excludePatterns: [],
            countRoles: ['user', 'assistant'],
            storeRoles: ['user', 'assistant'],
            storeMessageClasses: ['dialogue'],
            countMessageClasses: ['dialogue'],
            contextMessageClasses: ['dialogue']
          }
        },
        null,
        2
      ),
      'utf8'
    );
  });

  afterEach(async () => {
    await triggerApi.closeAdapter();
    if (originalDataDir === undefined) {
      delete process.env.HM_DATA_DIR;
    } else {
      process.env.HM_DATA_DIR = originalDataDir;
    }
    if (originalMode === undefined) {
      delete process.env.HM_LLM_MODE;
    } else {
      process.env.HM_LLM_MODE = originalMode;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates L1 from threshold-sized earliest batch', async () => {
    const store = storeApi.createEmptyStore();
    storeApi.addMessage(store, {
      role: 'assistant',
      content: 'm2',
      timestamp: '2026-02-10T10:02:00.000Z',
      messageClass: 'dialogue'
    });
    storeApi.addMessage(store, {
      role: 'user',
      content: 'm1',
      timestamp: '2026-02-10T10:01:00.000Z',
      messageClass: 'dialogue'
    });
    storeApi.addMessage(store, {
      role: 'assistant',
      content: 'm3',
      timestamp: '2026-02-10T10:03:00.000Z',
      messageClass: 'dialogue'
    });
    storeApi.saveStore(agentId, store);

    await triggerApi.handleL1(agentId, agentId);

    const nextStore = storeApi.loadStore(agentId);
    assert.equal((nextStore.artifacts[1] || []).length, 1);
    const artifact = nextStore.artifacts[1][0];
    assert.equal(artifact.startTimestamp, '2026-02-10T10:01:00.000Z');
    assert.equal(artifact.endTimestamp, '2026-02-10T10:02:00.000Z');
    assert.equal(artifact.messageCount, 2);

    const telemetryPath = path.join(tmpDir, agentId, 'summarization-events.jsonl');
    const events = readJsonl(telemetryPath);
    const sent = events.find((e) => e.eventType === 'memory_task_sent' && e.taskKind === 'l1');
    const processed = events.find((e) => e.eventType === 'artifact_processed' && e.taskKind === 'l1');
    assert.ok(sent, 'expected memory_task_sent event for L1');
    assert.ok(processed, 'expected artifact_processed event for L1');
    assert.equal(processed.attemptsBeforeProcessed, 1);
  });

  it('creates L2 from threshold-sized earliest unsummarized artifacts', async () => {
    const store = storeApi.createEmptyStore();
    storeApi.addArtifact(store, 1, {
      content: 'a2',
      startTimestamp: '2026-02-10T10:05:00.000Z',
      endTimestamp: '2026-02-10T10:10:00.000Z'
    });
    storeApi.addArtifact(store, 1, {
      content: 'a1',
      startTimestamp: '2026-02-10T10:00:00.000Z',
      endTimestamp: '2026-02-10T10:05:00.000Z'
    });
    storeApi.addArtifact(store, 1, {
      content: 'a3',
      startTimestamp: '2026-02-10T10:10:00.000Z',
      endTimestamp: '2026-02-10T10:15:00.000Z'
    });
    storeApi.saveStore(agentId, store);

    await triggerApi.handleAggregate(agentId, agentId, 1);

    const nextStore = storeApi.loadStore(agentId);
    assert.equal((nextStore.artifacts[2] || []).length, 1);
    const artifact = nextStore.artifacts[2][0];
    assert.equal(artifact.startTimestamp, '2026-02-10T10:00:00.000Z');
    assert.equal(artifact.endTimestamp, '2026-02-10T10:10:00.000Z');
    assert.equal(artifact.artifactCount, 2);

    const indexPath = storeApi.getArtifactsIndexPath(agentId);
    const index = readJson(indexPath);
    const l2IndexEntry = index.artifacts.find((a) => a.level === 2);
    assert.ok(l2IndexEntry);

    const telemetryPath = path.join(tmpDir, agentId, 'summarization-events.jsonl');
    const events = readJsonl(telemetryPath);
    const sent = events.find((e) => e.eventType === 'memory_task_sent' && e.taskKind === 'aggregate' && e.targetLevel === 2);
    const processed = events.find((e) => e.eventType === 'artifact_processed' && e.taskKind === 'aggregate' && e.targetLevel === 2);
    assert.ok(sent, 'expected memory_task_sent event for L2 aggregate');
    assert.ok(processed, 'expected artifact_processed event for L2 aggregate');
    assert.equal(processed.attemptsBeforeProcessed, 1);
  });

  it('passes sessionKey to adapter for L1 tasks', async () => {
    const store = storeApi.createEmptyStore();
    storeApi.addMessage(store, {
      role: 'user',
      content: 'm1',
      timestamp: '2026-02-10T10:01:00.000Z',
      messageClass: 'dialogue'
    });
    storeApi.addMessage(store, {
      role: 'assistant',
      content: 'm2',
      timestamp: '2026-02-10T10:02:00.000Z',
      messageClass: 'dialogue'
    });
    storeApi.saveStore(agentId, store);

    let seenSessionKey = null;
    triggerApi.setAdapter({
      async send(_id, _message, options = {}) {
        seenSessionKey = options.sessionKey || null;
        return '<memory_artifact_L1>custom-l1</memory_artifact_L1>\nNO_REPLY';
      },
      get lastCaptureInfo() {
        return { method: 'test', collectedCount: 1 };
      },
      async close() {}
    }, 'test');

    await triggerApi.handleL1(agentId, 'agent:custom-l1:main');
    assert.equal(seenSessionKey, 'agent:custom-l1:main');
  });

  it('passes sessionKey to adapter for aggregate tasks', async () => {
    const store = storeApi.createEmptyStore();
    storeApi.addArtifact(store, 1, {
      content: 'a1',
      startTimestamp: '2026-02-10T10:00:00.000Z',
      endTimestamp: '2026-02-10T10:05:00.000Z'
    });
    storeApi.addArtifact(store, 1, {
      content: 'a2',
      startTimestamp: '2026-02-10T10:05:00.000Z',
      endTimestamp: '2026-02-10T10:10:00.000Z'
    });
    storeApi.saveStore(agentId, store);

    let seenSessionKey = null;
    triggerApi.setAdapter({
      async send(_id, _message, options = {}) {
        seenSessionKey = options.sessionKey || null;
        return '<memory_artifact_L2>custom-l2</memory_artifact_L2>\nNO_REPLY';
      },
      get lastCaptureInfo() {
        return { method: 'test', collectedCount: 1 };
      },
      async close() {}
    }, 'test');

    await triggerApi.handleAggregate(agentId, 'agent:custom-l2', 1);
    assert.equal(seenSessionKey, 'agent:custom-l2');
  });
});
