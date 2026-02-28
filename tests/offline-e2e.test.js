const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-offline-e2e-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const AGENT_ID = 'offline-e2e-agent';

process.env.HM_DATA_DIR = DATA_DIR;
process.env.HM_LLM_MODE = process.env.HM_LLM_MODE || 'mock';

const { createEmptyStore, addMessage, saveStore, loadStore } = require('../scripts/store');
const { processLine } = require('../scripts/watch');

function writeAgentConfig(config) {
  const agentDir = path.join(DATA_DIR, AGENT_ID);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function messageLine(role, content, timestamp) {
  return JSON.stringify({
    type: 'message',
    message: { role, content, timestamp }
  });
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timeout');
}

describe('offline e2e scenarios', () => {
  it('runs watcher -> L1 summary -> archive -> context without real LLM', async () => {
    const storeRef = { current: createEmptyStore() };
    writeAgentConfig({
      thresholds: { L1: 3, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoCompact: { enabled: false }
    });
    saveStore(AGENT_ID, storeRef.current);

    const lines = [
      messageLine('user', 'Need a design for memory hierarchy', '2026-02-06T10:00:00.000Z'),
      messageLine('assistant', 'Propose 3-layer structure', '2026-02-06T10:01:00.000Z'),
      messageLine('user', 'Approved, implement minimal version', '2026-02-06T10:02:00.000Z')
    ];

    for (const line of lines) {
      await processLine(AGENT_ID, storeRef, line, {
        skipContextRegenerate: true
      });
    }

    await waitFor(() => {
      const snapshot = loadStore(AGENT_ID);
      return snapshot.messages.length === 0 && (snapshot.artifacts[1] || []).length === 1;
    });

    const updated = loadStore(AGENT_ID);
    assert.equal(updated.messages.length, 0);
    assert.equal((updated.artifacts[1] || []).length, 1);
    assert.match(updated.artifacts[1][0].content, /MOCK L1 SUMMARY/);

    const archivePath = path.join(DATA_DIR, AGENT_ID, 'messages', '2026-02-06.jsonl');
    assert.equal(fs.existsSync(archivePath), true);
    const archivedLines = fs.readFileSync(archivePath, 'utf8').trim().split('\n');
    assert.equal(archivedLines.length, 3);

    const contextPath = path.join(DATA_DIR, AGENT_ID, 'CONTEXT.md');
    assert.equal(fs.existsSync(contextPath), true);
    const context = fs.readFileSync(contextPath, 'utf8');
    assert.match(context, /^# Memory Context/m);
    assert.match(context, /_Max Level: 1, Overlap: 1_/);
    assert.doesNotMatch(context, /MEMORY \(LEVEL 1\)/);
    assert.match(context, /RECENT CONVERSATION/);
    assert.match(context, /Need a design for memory hierarchy/);
    assert.match(context, /Propose 3-layer structure/);
    assert.match(context, /Approved, implement minimal version/);
  });

  it('runs L1 twice and then L2 aggregation in offline mode', () => {
    const store = createEmptyStore();
    writeAgentConfig({
      thresholds: { L1: 3, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoCompact: { enabled: false }
    });

    addMessage(store, { role: 'user', content: 'batch1-a', timestamp: '2026-02-06T11:00:00.000Z' });
    addMessage(store, { role: 'assistant', content: 'batch1-b', timestamp: '2026-02-06T11:01:00.000Z' });
    addMessage(store, { role: 'user', content: 'batch1-c', timestamp: '2026-02-06T11:02:00.000Z' });
    saveStore(AGENT_ID, store);

    execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'l1', AGENT_ID, AGENT_ID], {
      cwd: ROOT_DIR,
      env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
      stdio: 'pipe'
    });

    const afterFirst = loadStore(AGENT_ID);
    addMessage(afterFirst, { role: 'user', content: 'batch2-a', timestamp: '2026-02-06T12:00:00.000Z' });
    addMessage(afterFirst, { role: 'assistant', content: 'batch2-b', timestamp: '2026-02-06T12:01:00.000Z' });
    addMessage(afterFirst, { role: 'user', content: 'batch2-c', timestamp: '2026-02-06T12:02:00.000Z' });
    saveStore(AGENT_ID, afterFirst);

    execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'l1', AGENT_ID, AGENT_ID], {
      cwd: ROOT_DIR,
      env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
      stdio: 'pipe'
    });

    execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'aggregate', AGENT_ID, AGENT_ID, '1'], {
      cwd: ROOT_DIR,
      env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
      stdio: 'pipe'
    });

    const finalStore = loadStore(AGENT_ID);
    assert.equal((finalStore.artifacts[1] || []).length, 2);
    assert.equal((finalStore.artifacts[2] || []).length, 1);
    assert.match(finalStore.artifacts[2][0].content, /MOCK L2 SUMMARY/);
  });
});
