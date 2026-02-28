const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-api-smoke-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');
const AGENTS_PATH = path.join(TMP_ROOT, 'agents.json');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const AGENT_ID = 'api-smoke-agent';

process.env.HM_DATA_DIR = DATA_DIR;

const { saveStore, createEmptyStore, addArtifact, addMessage } = require('../scripts/store');

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_e) {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Server did not become ready: ${url}`);
}

describe('dashboard/api localhost smoke', () => {
  it('serves agent stats/store/context for isolated test data', async () => {
    fs.mkdirSync(path.join(DATA_DIR, AGENT_ID), { recursive: true });
    fs.writeFileSync(AGENTS_PATH, JSON.stringify({
      agents: [{ id: AGENT_ID, name: AGENT_ID, enabled: false, isSubagent: false }]
    }, null, 2), 'utf8');

    const store = createEmptyStore();
    addArtifact(store, 1, {
      content: 'API smoke L1 artifact',
      startTimestamp: '2026-02-06T09:00:00.000Z',
      endTimestamp: '2026-02-06T09:05:00.000Z',
      messageCount: 3
    });
    addArtifact(store, 2, {
      content: 'API rollup L2 artifact',
      startTimestamp: '2026-02-06T09:00:00.000Z',
      endTimestamp: '2026-02-06T09:05:00.000Z',
      sourceLevel: 1,
      artifactCount: 1
    });
    addArtifact(store, 3, {
      content: 'API rollup L3 artifact',
      startTimestamp: '2026-02-06T09:00:00.000Z',
      endTimestamp: '2026-02-06T09:05:00.000Z',
      sourceLevel: 2,
      artifactCount: 1
    });
    addArtifact(store, 4, {
      content: 'API rollup L4 artifact',
      startTimestamp: '2026-02-06T09:00:00.000Z',
      endTimestamp: '2026-02-06T09:05:00.000Z',
      sourceLevel: 3,
      artifactCount: 1
    });
    addMessage(store, {
      role: 'user',
      content: 'recent-1',
      timestamp: '2026-02-06T09:06:00.000Z'
    });
    addMessage(store, {
      role: 'assistant',
      content: 'recent-2',
      timestamp: '2026-02-06T09:07:00.000Z'
    });
    saveStore(AGENT_ID, store);
    fs.writeFileSync(path.join(DATA_DIR, AGENT_ID, 'CONTEXT.md'), '# Memory Context\n\n## MEMORY (LEVEL 1)\n\nAPI smoke L1 artifact\n', 'utf8');
    fs.writeFileSync(path.join(DATA_DIR, AGENT_ID, 'watch.log'), 'boot ok\n', 'utf8');
    fs.mkdirSync(path.join(DATA_DIR, AGENT_ID, 'messages'), { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, AGENT_ID, 'messages', '2026-02-06.jsonl'),
      JSON.stringify({
        role: 'user',
        content: 'archived message',
        timestamp: '2026-02-06T09:01:00.000Z'
      }) + '\n',
      'utf8'
    );
    const sessionId = 'api-smoke-session';
    const openclawAgentsDir = path.join(TMP_ROOT, 'openclaw-agents');
    const sessionsDir = path.join(openclawAgentsDir, AGENT_ID, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-06T09:00:00.000Z',
          message: {
            role: 'user',
            content: 's1',
            timestamp: '2026-02-06T09:00:00.000Z'
          }
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-06T09:05:00.000Z',
          message: {
            role: 'assistant',
            content: 's2',
            timestamp: '2026-02-06T09:05:00.000Z'
          }
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-06T09:06:00.000Z',
          message: {
            role: 'user',
            content: 's3',
            timestamp: '2026-02-06T09:06:00.000Z'
          }
        }),
        JSON.stringify({
          type: 'message',
          timestamp: '2026-02-06T09:07:00.000Z',
          message: {
            role: 'assistant',
            content: 's4',
            timestamp: '2026-02-06T09:07:00.000Z'
          }
        })
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(DATA_DIR, AGENT_ID, 'last-session.json'),
      JSON.stringify({
        sessionId,
        sessionKey: `agent:${AGENT_ID}:main`,
        jsonlPath: sessionPath
      }, null, 2),
      'utf8'
    );

    const server = spawn('node', [path.join(ROOT_DIR, 'web/server.js')], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        HM_DATA_DIR: DATA_DIR,
        HM_AGENTS_CONFIG_PATH: AGENTS_PATH,
        OPENCLAW_AGENTS_DIR: openclawAgentsDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      await waitForServer(`http://127.0.0.1:${PORT}/api/agents`);

      const agentsRes = await fetch(`http://127.0.0.1:${PORT}/api/agents`);
      const agentsPayload = await agentsRes.json();
      assert.equal(Array.isArray(agentsPayload.agents), true);
      assert.equal(agentsPayload.agents[0].id, AGENT_ID);

      const statsRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/stats`);
      const statsPayload = await statsRes.json();
      assert.equal(statsPayload.artifacts.L1, 1);
      assert.equal(statsPayload.artifacts.L4, 1);

      const storeRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/store`);
      const storePayload = await storeRes.json();
      assert.equal(storePayload.artifacts.L1.length, 1);
      assert.equal(storePayload.artifacts.L4.length, 1);
      assert.equal(typeof storePayload.artifacts.L1[0].artifactId, 'string');

      const artifactsRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/artifacts`);
      const artifactsPayload = await artifactsRes.json();
      assert.equal(artifactsPayload.count, 4);
      assert.equal(artifactsPayload.artifacts.some((artifact) => artifact.level === 4), true);

      const searchRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/artifacts/search?q=smoke`);
      const searchPayload = await searchRes.json();
      assert.equal(searchPayload.count, 1);
      assert.equal(searchPayload.results[0].artifactId, storePayload.artifacts.L1[0].artifactId);

      const drilldownByIdRes = await fetch(
        `http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/artifacts/${storePayload.artifacts.L1[0].artifactId}/drilldown`
      );
      const drilldownByIdPayload = await drilldownByIdRes.json();
      assert.equal(drilldownByIdPayload.source, 'archive');
      assert.equal(drilldownByIdPayload.messages.length, 1);

      const drilldownL4Res = await fetch(
        `http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/artifacts/${storePayload.artifacts.L4[0].artifactId}/drilldown`
      );
      const drilldownL4Payload = await drilldownL4Res.json();
      assert.equal(drilldownL4Payload.source, 'L3');
      assert.equal(drilldownL4Payload.sourceArtifacts.length, 1);
      assert.equal(drilldownL4Payload.sourceArtifacts[0].artifactId, storePayload.artifacts.L3[0].artifactId);

      const contextRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/context`);
      const contextPayload = await contextRes.json();
      assert.match(contextPayload.content, /Memory Context/);

      const inject404Res = await fetch(`http://127.0.0.1:${PORT}/api/agents/missing-agent/context/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rebuild: true })
      });
      assert.equal(inject404Res.status, 404);

      const compact404Res = await fetch(`http://127.0.0.1:${PORT}/api/agents/missing-agent/compact`, {
        method: 'POST'
      });
      assert.equal(compact404Res.status, 404);

      const compactInject404Res = await fetch(`http://127.0.0.1:${PORT}/api/agents/missing-agent/compact-with-inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(compactInject404Res.status, 404);

      const logsRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/logs?lines=10`);
      const logsPayload = await logsRes.json();
      assert.equal(logsPayload.logs.some((line) => line.includes('boot ok')), true);

      const validConfig = {
        thresholds: { L1: 42, default: 5 },
        prompts: { l1: 'Summarize', aggregate: 'Aggregate {level}' },
        filters: {
          exclude: [],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant'],
          storeMessageClasses: ['dialogue', 'command'],
          countMessageClasses: ['dialogue'],
          contextMessageClasses: ['dialogue'],
          commandAllowlist: ['/compact']
        },
        autoInjectContext: {
          enabled: true,
          onNewSession: true,
          onCompaction: false,
          preText: 'before',
          postText: 'after',
          preMdFiles: ['README.md'],
          postMdFiles: []
        },
        autoCompact: { enabled: false, messageThreshold: 150, postCompactMessage: '' }
      };

      const saveConfigRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validConfig)
      });
      const saveConfigPayload = await saveConfigRes.json();
      assert.equal(saveConfigRes.ok, true);
      assert.equal(saveConfigPayload.success, true);

      const getConfigRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/config`);
      const getConfigPayload = await getConfigRes.json();
      assert.deepEqual(getConfigPayload.filters.storeMessageClasses, ['dialogue', 'command']);
      assert.deepEqual(getConfigPayload.filters.countMessageClasses, ['dialogue']);
      assert.equal(getConfigPayload.autoInjectContext.preText, 'before');
      assert.deepEqual(getConfigPayload.autoInjectContext.preMdFiles, ['README.md']);

      const rollbackPreviewRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/memory/rollback/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoffTs: '2026-02-06T09:05:30.000Z' })
      });
      const rollbackPreviewPayload = await rollbackPreviewRes.json();
      assert.equal(rollbackPreviewRes.ok, true);
      assert.equal(rollbackPreviewPayload.success, true);
      assert.equal(rollbackPreviewPayload.preview.removed.totalMessages, 2);

      const rollbackApplyRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/memory/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoffTs: '2026-02-06T09:05:30.000Z' })
      });
      const rollbackApplyPayload = await rollbackApplyRes.json();
      assert.equal(rollbackApplyRes.ok, true);
      assert.equal(rollbackApplyPayload.success, true);
      assert.equal(typeof rollbackApplyPayload.backupId, 'string');

      const storeAfterRollbackRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/store`);
      const storeAfterRollbackPayload = await storeAfterRollbackRes.json();
      assert.equal(storeAfterRollbackPayload.recentMessages.length, 0);
      assert.equal(storeAfterRollbackPayload.artifacts.L1.length, 1);
      const sessionAfterRollback = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(sessionAfterRollback.length, 2);
      assert.equal(sessionAfterRollback[0].message.content, 's1');
      assert.equal(sessionAfterRollback[1].message.content, 's2');

      const rollbackBackupsRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/memory/rollback/backups`);
      const rollbackBackupsPayload = await rollbackBackupsRes.json();
      assert.equal(rollbackBackupsRes.ok, true);
      assert.equal(rollbackBackupsPayload.success, true);
      assert.equal(rollbackBackupsPayload.backups.length >= 1, true);

      const rollbackRestoreRes = await fetch(
        `http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/memory/rollback/restore/${rollbackApplyPayload.backupId}`,
        { method: 'POST' }
      );
      const rollbackRestorePayload = await rollbackRestoreRes.json();
      assert.equal(rollbackRestoreRes.ok, true);
      assert.equal(rollbackRestorePayload.success, true);

      const storeAfterRestoreRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/store`);
      const storeAfterRestorePayload = await storeAfterRestoreRes.json();
      assert.equal(storeAfterRestorePayload.recentMessages.length, 2);
      const sessionAfterRestore = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(sessionAfterRestore.length, 4);
      assert.equal(sessionAfterRestore[3].message.content, 's4');

      const invalidConfigRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validConfig,
          filters: {
            ...validConfig.filters,
            storeMessageClasses: ['dialogue', 'broken_class']
          }
        })
      });
      const invalidConfigPayload = await invalidConfigRes.json();
      assert.equal(invalidConfigRes.status, 400);
      assert.match(invalidConfigPayload.error, /invalid classes/i);

      const invalidInjectConfigRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validConfig,
          autoInjectContext: {
            ...validConfig.autoInjectContext,
            preMdFiles: ['ok.md', 123]
          }
        })
      });
      const invalidInjectConfigPayload = await invalidInjectConfigRes.json();
      assert.equal(invalidInjectConfigRes.status, 400);
      assert.match(invalidInjectConfigPayload.error, /autoInjectContext\.preMdFiles/i);

      const clearRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/memory/clear`, {
        method: 'POST'
      });
      const clearPayload = await clearRes.json();
      assert.equal(clearRes.ok, true);
      assert.equal(clearPayload.success, true);
      assert.equal(clearPayload.removed.storeMessages, 2);
      assert.equal(clearPayload.removed.artifacts, 4);
      assert.equal(clearPayload.removed.archivedFiles, 1);
      assert.equal(clearPayload.removed.contextFileRemoved, true);

      const storeAfterRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/store`);
      const storeAfterPayload = await storeAfterRes.json();
      assert.equal(storeAfterPayload.artifacts.L1.length, 0);
      assert.equal((storeAfterPayload.artifacts.L4 || []).length, 0);
      assert.equal(storeAfterPayload.recentMessages.length, 0);

      const contextAfterRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/context`);
      const contextAfterPayload = await contextAfterRes.json();
      assert.equal(contextAfterPayload.content, '');

      const datesAfterRes = await fetch(`http://127.0.0.1:${PORT}/api/agents/${AGENT_ID}/messages-dates`);
      const datesAfterPayload = await datesAfterRes.json();
      assert.deepEqual(datesAfterPayload.dates, []);
    } finally {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.on('close', resolve));
    }
  });
});
