const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-multiagent-offline-'));
const HOME_DIR = path.join(TMP_ROOT, 'home');
const DATA_DIR = path.join(TMP_ROOT, 'data');
const AGENTS_CONFIG_PATH = path.join(TMP_ROOT, 'agents.json');
const SNAPSHOT_ROOT = path.join(ROOT_DIR, 'tmp', 'latest-test-run');
const SNAPSHOT_DATA_DIR = path.join(SNAPSHOT_ROOT, 'data');
const SNAPSHOT_AGENTS_PATH = path.join(SNAPSHOT_ROOT, 'agents.json');
const SNAPSHOT_META_PATH = path.join(SNAPSHOT_ROOT, 'metadata.json');
const DEBUG_RESULTS_PATH = path.join(ROOT_DIR, 'tmp', 'test-results', 'multiagent-offline-debug.md');
const PORT = 4800 + Math.floor(Math.random() * 300);
const AGENTS = ['alpha', 'beta', 'gamma'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, timeoutMs = 45000, stepMs = 250) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_e) {}
    await sleep(stepMs);
  }
  throw new Error('waitFor timeout');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res.json();
}

function hasTailStarted(logPath) {
  if (!fs.existsSync(logPath)) return false;
  const content = fs.readFileSync(logPath, 'utf8');
  return content.includes('Watching for new messages (tail -F)...');
}

function createMessageLine(role, content, timestamp) {
  return JSON.stringify({
    type: 'message',
    message: { role, content, timestamp }
  }) + '\n';
}

function appendEvent(sessionFile, role, content, timestamp) {
  fs.appendFileSync(sessionFile, createMessageLine(role, content, timestamp), 'utf8');
}

function persistLatestSnapshot() {
  fs.rmSync(SNAPSHOT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  fs.cpSync(DATA_DIR, SNAPSHOT_DATA_DIR, { recursive: true });
  fs.copyFileSync(AGENTS_CONFIG_PATH, SNAPSHOT_AGENTS_PATH);
  fs.writeFileSync(SNAPSHOT_META_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceTest: 'tests/multiagent-offline.test.js',
    agents: AGENTS
  }, null, 2), 'utf8');
}

function ensureDebugResultsDir() {
  fs.mkdirSync(path.dirname(DEBUG_RESULTS_PATH), { recursive: true });
}

function appendDebugResult(lines) {
  ensureDebugResultsDir();
  fs.appendFileSync(DEBUG_RESULTS_PATH, lines.join('\n') + '\n', 'utf8');
}

function tailText(filePath, lineCount = 40) {
  if (!fs.existsSync(filePath)) return '[missing]';
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  return lines.slice(Math.max(0, lines.length - lineCount)).join('\n');
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) return 0;
  return content.split('\n').filter(Boolean).length;
}

async function fetchAgentState(port, agentId) {
  const state = {
    id: agentId,
    stats: null,
    store: null,
    statsError: null,
    storeError: null
  };
  try {
    state.stats = await fetchJson(`http://127.0.0.1:${port}/api/agents/${agentId}/stats`);
  } catch (e) {
    state.statsError = e.message;
  }
  try {
    state.store = await fetchJson(`http://127.0.0.1:${port}/api/agents/${agentId}/store`);
  } catch (e) {
    state.storeError = e.message;
  }
  return state;
}

function formatStateLine(state) {
  const l1 = state.stats?.artifacts?.L1 ?? 'err';
  const l2 = state.stats?.artifacts?.L2 ?? 'err';
  const l3 = state.stats?.artifacts?.L3 ?? 'err';
  const unsummarized = state.stats?.unsummarized ?? 'err';
  const storedMsgs = state.store?.recentMessages?.length ?? 'err';
  return `${state.id}: L1=${l1} L2=${l2} L3=${l3} unsummarized=${unsummarized} recentMessages=${storedMsgs}`;
}

async function waitForL1Batch({ batch, port, sessions, timeoutMs = 120000, stepMs = 400 }) {
  const start = Date.now();
  let attempts = 0;
  let lastStates = [];
  let nextProgressLogAt = start;

  while (Date.now() - start < timeoutMs) {
    attempts++;
    lastStates = await Promise.all(AGENTS.map((id) => fetchAgentState(port, id)));
    const pending = lastStates
      .filter((s) => (s.stats?.artifacts?.L1 ?? -1) < batch)
      .map((s) => s.id);
    if (pending.length === 0) {
      return;
    }

    if (Date.now() >= nextProgressLogAt) {
      const progress = lastStates.map((s) => formatStateLine(s)).join(' | ');
      console.log(`[multiagent-offline] batch=${batch} waiting L1; pending=${pending.join(',')} | ${progress}`);
      nextProgressLogAt = Date.now() + 10000;
    }

    await sleep(stepMs);
  }

  const elapsed = Date.now() - start;
  const pending = lastStates
    .filter((s) => (s.stats?.artifacts?.L1 ?? -1) < batch)
    .map((s) => s.id);

  const report = [
    `## ${new Date().toISOString()} - L1 batch timeout`,
    `batch=${batch}, timeoutMs=${timeoutMs}, elapsedMs=${elapsed}, attempts=${attempts}, pending=${pending.join(',') || 'none'}`
  ];

  for (const state of lastStates) {
    const sessionFile = sessions[state.id];
    const watchLogPath = path.join(DATA_DIR, state.id, 'watch.log');
    report.push(`### agent=${state.id}`);
    report.push(`state: ${formatStateLine(state)}`);
    if (state.statsError) report.push(`statsError: ${state.statsError}`);
    if (state.storeError) report.push(`storeError: ${state.storeError}`);
    report.push(`sessionJsonl=${sessionFile}`);
    report.push(`sessionJsonlLines=${countJsonlLines(sessionFile)}`);
    report.push('watch.log tail:');
    report.push('```');
    report.push(tailText(watchLogPath, 80));
    report.push('```');
  }
  appendDebugResult(report);
  throw new Error(`waitFor timeout on L1 batch=${batch}; pending=${pending.join(',') || 'unknown'}`);
}

describe('multi-agent offline assembled system', () => {
  it('runs 3 agents in parallel and compresses artifacts up to L3 for each', { timeout: 240000 }, async () => {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const agentsConfig = {
      agents: AGENTS.map((id) => ({ id, name: id, enabled: true, isSubagent: false }))
    };
    fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(agentsConfig, null, 2), 'utf8');

    const sessions = {};
    for (const id of AGENTS) {
      const sessionsDir = path.join(HOME_DIR, '.openclaw', 'agents', id, 'sessions');
      const sessionId = `${id}-session`;
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(sessionFile, '', 'utf8');
      sessions[id] = sessionFile;

      const agentDataDir = path.join(DATA_DIR, id);
      fs.mkdirSync(agentDataDir, { recursive: true });
      fs.writeFileSync(path.join(agentDataDir, 'config.json'), JSON.stringify({
        thresholds: { L1: 4, default: 2 },
        filters: {
          exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant']
        },
        autoInjectContext: { enabled: false, onNewSession: false, onCompaction: false },
        autoCompact: { enabled: false, messageThreshold: 1000, retries: 1, retryDelayMs: 1000 }
      }, null, 2), 'utf8');
    }

    const server = spawn('node', [path.join(ROOT_DIR, 'web/server.js')], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PORT: String(PORT),
        HM_LLM_MODE: 'mock',
        HM_DATA_DIR: DATA_DIR,
        HM_AGENTS_CONFIG_PATH: AGENTS_CONFIG_PATH
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stderr.on('data', () => {});

    try {
      await waitFor(async () => {
        const payload = await fetchJson(`http://127.0.0.1:${PORT}/api/agents`);
        return payload.agents?.length === 3;
      }, 30000);

      await waitFor(async () => {
        const payload = await fetchJson(`http://127.0.0.1:${PORT}/api/agents`);
        return payload.agents.every((a) => a.running === true);
      }, 30000);

      await waitFor(() => {
        return AGENTS.every((id) => {
          const logPath = path.join(DATA_DIR, id, 'watch.log');
          return hasTailStarted(logPath);
        });
      }, 30000, 200);
      // Give tail -F a short warmup to avoid dropping the first appended line.
      await sleep(1200);

      const baseTs = Date.parse('2026-02-06T16:00:00.000Z');
      const totalBatches = 8; // two L1 waves (4 + 4) => 2 x L2 => 1 x L3

      for (let batch = 1; batch <= totalBatches; batch++) {
        for (let step = 1; step <= 4; step++) {
          const offset = (batch - 1) * 10 + step;
          const ts = new Date(baseTs + offset * 1000).toISOString();
          await Promise.all(AGENTS.map(async (id) => {
            const role = step % 2 === 1 ? 'user' : 'assistant';
            const peerA = id === 'alpha' ? 'beta' : 'alpha';
            const peerB = id === 'gamma' ? 'beta' : 'gamma';
            const content = `${id.toUpperCase()} batch-${batch} step-${step}: coordinate with ${peerA} and ${peerB}`;
            appendEvent(sessions[id], role, content, ts);
            await sleep(Math.floor(Math.random() * 20));
          }));
        }

        await waitForL1Batch({
          batch,
          port: PORT,
          sessions,
          timeoutMs: 120000,
          stepMs: 400
        });

        // After the first L1 wave, aggregate L1 -> L2 (first L2 artifact).
        if (batch === 4) {
          for (const id of AGENTS) {
            execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'aggregate', id, id, '1'], {
              cwd: ROOT_DIR,
              env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
              stdio: 'pipe'
            });
          }
          await waitFor(async () => {
            const checks = await Promise.all(AGENTS.map(async (id) => {
              const stats = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/stats`);
              return stats.artifacts?.L2 >= 1;
            }));
            return checks.every(Boolean);
          }, 90000, 400);
        }
      }

      for (const id of AGENTS) {
        execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'aggregate', id, id, '1'], {
          cwd: ROOT_DIR,
          env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
          stdio: 'pipe'
        });
        execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'aggregate', id, id, '2'], {
          cwd: ROOT_DIR,
          env: { ...process.env, HM_LLM_MODE: 'mock', HM_DATA_DIR: DATA_DIR },
          stdio: 'pipe'
        });
      }

      await waitFor(async () => {
        const checks = await Promise.all(AGENTS.map(async (id) => {
          const stats = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/stats`);
          return stats.artifacts?.L1 >= 8 &&
            stats.artifacts?.L2 >= 2 &&
            stats.artifacts?.L3 >= 1;
        }));
        return checks.every(Boolean);
      }, 120000, 500);

      for (const id of AGENTS) {
        const stats = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/stats`);
        assert.equal(stats.artifacts.L1 >= 8, true, `${id} should have >=8 L1 artifacts`);
        assert.equal(stats.artifacts.L2 >= 2, true, `${id} should have >=2 L2 artifacts`);
        assert.equal(stats.artifacts.L3 >= 1, true, `${id} should have >=1 L3 artifact`);

        const storePayload = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/store`);
        assert.equal(storePayload.artifacts.L1.length >= 8, true, `${id} store should expose L1 artifacts`);
        assert.equal(storePayload.artifacts.L2.length >= 2, true, `${id} store should expose L2 artifacts`);
        assert.equal(storePayload.artifacts.L3.length >= 1, true, `${id} store should expose L3 artifacts`);
        assert.match(storePayload.artifacts.L1[0].content, /MOCK L1 SUMMARY/);
        assert.match(storePayload.artifacts.L2[0].content, /MOCK L2 SUMMARY/);
        assert.match(storePayload.artifacts.L3[0].content, /MOCK L3 SUMMARY/);

        const contextPayload = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/context`);
        assert.match(contextPayload.content, /Memory Context/);

        const archivePath = path.join(DATA_DIR, id, 'messages', '2026-02-06.jsonl');
        assert.equal(fs.existsSync(archivePath), true, `${id} archive should exist`);
      }

      persistLatestSnapshot();
    } finally {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.on('close', resolve));
    }
  });
});
