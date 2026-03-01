const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../scripts/store');

function artifactWindow(index, base = '2026-03-01T00:00:00.000Z') {
  const startMs = new Date(base).getTime() + (index * 60 * 1000);
  const endMs = startMs + (60 * 1000);
  return {
    startTimestamp: new Date(startMs).toISOString(),
    endTimestamp: new Date(endMs).toISOString()
  };
}

describe('artifacts long-term storage v2', () => {
  let tmpRoot;
  let prevDataDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-artifacts-v2-'));
    prevDataDir = process.env.HM_DATA_DIR;
    process.env.HM_DATA_DIR = path.join(tmpRoot, 'data');
  });

  afterEach(() => {
    if (prevDataDir === undefined) {
      delete process.env.HM_DATA_DIR;
    } else {
      process.env.HM_DATA_DIR = prevDataDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes artifacts in level chunks of 50 and emits v2 index', () => {
    const agentId = 'chunked-agent';
    const state = store.createEmptyStore();

    for (let i = 0; i < 120; i += 1) {
      const window = artifactWindow(i);
      store.addArtifact(state, 1, {
        content: `L1 artifact ${i}`,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        messageCount: 5
      });
    }

    for (let i = 0; i < 3; i += 1) {
      const window = artifactWindow(200 + i);
      store.addArtifact(state, 2, {
        content: `L2 artifact ${i}`,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        sourceLevel: 1,
        artifactCount: 50
      });
    }

    store.saveStore(agentId, state);

    const agentDir = path.join(process.env.HM_DATA_DIR, agentId);
    const l1ChunksDir = path.join(agentDir, 'artifacts', 'L1', 'chunks');
    const files = fs.readdirSync(l1ChunksDir).filter((name) => name.endsWith('.jsonl')).sort();
    assert.deepEqual(files, ['000001.jsonl', '000002.jsonl', '000003.jsonl']);

    const counts = files.map((name) => {
      const content = fs.readFileSync(path.join(l1ChunksDir, name), 'utf8');
      return content.split('\n').filter(Boolean).length;
    });
    assert.deepEqual(counts, [50, 50, 20]);

    const indexPath = path.join(agentDir, 'artifacts-index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(index.version, 2);
    assert.equal(index.chunkSize, 50);
    assert.equal(index.artifacts.length, 123);
    assert.equal(typeof index.artifactsHash, 'string');
    assert.equal(index.artifactsHash.length > 0, true);

    const sample = index.artifacts[0];
    assert.equal(typeof sample.artifactId, 'string');
    assert.equal(sample.path.includes('/chunks/'), true);
    assert.equal(Number.isInteger(sample.offset), true);
    assert.equal(sample.offset >= 0 && sample.offset < 50, true);
  });

  it('loads v2 chunked artifacts even when store.json artifacts are empty', () => {
    const agentId = 'chunked-load-agent';
    const state = store.createEmptyStore();

    for (let i = 0; i < 75; i += 1) {
      const window = artifactWindow(i);
      store.addArtifact(state, 1, {
        content: `persisted artifact ${i}`,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        messageCount: 3
      });
    }
    store.saveStore(agentId, state);

    const storePath = path.join(process.env.HM_DATA_DIR, agentId, 'store.json');
    const storePayload = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    storePayload.artifacts = {};
    fs.writeFileSync(storePath, JSON.stringify(storePayload, null, 2), 'utf8');

    const loaded = store.loadStore(agentId);
    assert.equal((loaded.artifacts[1] || []).length, 75);
    assert.equal(loaded.artifacts[1][0].content.includes('persisted artifact'), true);
  });

  it('does not rewrite chunk/index files when artifacts are unchanged', async () => {
    const agentId = 'hash-guard-agent';
    const state = store.createEmptyStore();

    for (let i = 0; i < 60; i += 1) {
      const window = artifactWindow(i);
      store.addArtifact(state, 1, {
        content: `stable artifact ${i}`,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        messageCount: 2
      });
    }
    store.saveStore(agentId, state);

    const agentDir = path.join(process.env.HM_DATA_DIR, agentId);
    const indexPath = path.join(agentDir, 'artifacts-index.json');
    const chunkPath = path.join(agentDir, 'artifacts', 'L1', 'chunks', '000001.jsonl');
    const indexBefore = fs.statSync(indexPath);
    const chunkBefore = fs.statSync(chunkPath);

    await new Promise((resolve) => setTimeout(resolve, 30));

    store.addMessage(state, {
      role: 'user',
      content: 'new l0 message only',
      timestamp: '2026-03-01T10:00:00.000Z'
    });
    store.saveStore(agentId, state);

    const indexAfter = fs.statSync(indexPath);
    const chunkAfter = fs.statSync(chunkPath);
    assert.equal(indexAfter.mtimeMs, indexBefore.mtimeMs);
    assert.equal(chunkAfter.mtimeMs, chunkBefore.mtimeMs);
  });

  it('reads legacy per-artifact files and rewrites them into v2 chunk layout on save', () => {
    const agentId = 'legacy-agent';
    const agentDir = path.join(process.env.HM_DATA_DIR, agentId);
    const legacyDir = path.join(agentDir, 'artifacts', 'L1');
    fs.mkdirSync(legacyDir, { recursive: true });

    const window = artifactWindow(1);
    const legacyArtifact = {
      content: 'legacy artifact',
      level: 1,
      startTimestamp: window.startTimestamp,
      endTimestamp: window.endTimestamp,
      createdAt: '2026-03-01T00:00:00.000Z'
    };

    fs.writeFileSync(path.join(legacyDir, 'legacy-item.json'), JSON.stringify(legacyArtifact, null, 2), 'utf8');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'store.json'), JSON.stringify({ messages: [], artifacts: {} }, null, 2), 'utf8');

    const loaded = store.loadStore(agentId);
    assert.equal((loaded.artifacts[1] || []).length, 1);
    assert.equal(loaded.artifacts[1][0].content, 'legacy artifact');

    store.saveStore(agentId, loaded);

    const chunkPath = path.join(agentDir, 'artifacts', 'L1', 'chunks', '000001.jsonl');
    assert.equal(fs.existsSync(chunkPath), true);
    assert.equal(fs.existsSync(path.join(legacyDir, 'legacy-item.json')), false);

    const index = JSON.parse(fs.readFileSync(path.join(agentDir, 'artifacts-index.json'), 'utf8'));
    assert.equal(index.version, 2);
    assert.equal(index.artifacts.length, 1);
  });
});
