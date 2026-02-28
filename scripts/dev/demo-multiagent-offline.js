#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEMO_ROOT = path.join(ROOT_DIR, 'tmp', 'multiagent-demo');
const HOME_DIR = path.join(DEMO_ROOT, 'home');
const DATA_DIR = path.join(DEMO_ROOT, 'data');
const AGENTS_CONFIG_PATH = path.join(DEMO_ROOT, 'agents.json');

const PORT = parseInt(process.env.PORT || '3459', 10);
const AGENTS = ['alpha', 'beta', 'gamma'];
const TOTAL_BATCHES = parseInt(process.env.DEMO_BATCHES || '8', 10);
const STEP_DELAY_MS = parseInt(process.env.DEMO_STEP_DELAY_MS || '700', 10);
const EXIT_ON_COMPLETE = process.env.DEMO_EXIT_ON_COMPLETE === '1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForApiReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_e) {}
    await sleep(250);
  }
  throw new Error(`API not ready: ${url}`);
}

function runAggregate(agentId, sourceLevel) {
  execFileSync('node', [path.join(ROOT_DIR, 'scripts/trigger-ws.js'), 'aggregate', agentId, agentId, String(sourceLevel)], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HM_LLM_MODE: 'mock',
      HM_DATA_DIR: DATA_DIR
    },
    stdio: 'inherit'
  });
}

function resetDemoWorkspace() {
  fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function seedDemoFiles() {
  fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify({
    agents: AGENTS.map((id) => ({ id, name: id, enabled: true, isSubagent: false }))
  }, null, 2), 'utf8');

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

  return sessions;
}

async function runScenario(sessions) {
  const baseTs = Date.parse('2026-02-06T18:00:00.000Z');
  console.log(`[demo] Starting scenario: ${TOTAL_BATCHES} batches, ${AGENTS.length} agents`);

  for (let batch = 1; batch <= TOTAL_BATCHES; batch++) {
    for (let step = 1; step <= 4; step++) {
      const offset = (batch - 1) * 10 + step;
      const ts = new Date(baseTs + offset * 1000).toISOString();

      await Promise.all(AGENTS.map(async (id) => {
        const role = step % 2 === 1 ? 'user' : 'assistant';
        const peerA = id === 'alpha' ? 'beta' : 'alpha';
        const peerB = id === 'gamma' ? 'beta' : 'gamma';
        const content = `${id.toUpperCase()} batch-${batch} step-${step}: coordinate with ${peerA} and ${peerB}`;
        appendEvent(sessions[id], role, content, ts);
      }));

      await sleep(STEP_DELAY_MS);
    }

    // First L2 wave after 4 L1 artifacts.
    if (batch === 4) {
      console.log('[demo] Aggregating first L2 wave...');
      for (const id of AGENTS) {
        runAggregate(id, 1);
      }
    }
  }

  // Second L2 wave after next 4 L1 artifacts.
  console.log('[demo] Aggregating second L2 wave...');
  for (const id of AGENTS) {
    runAggregate(id, 1);
  }

  // L2 -> L3.
  console.log('[demo] Aggregating L3...');
  for (const id of AGENTS) {
    runAggregate(id, 2);
  }

  console.log('[demo] Scenario complete.');
}

async function main() {
  resetDemoWorkspace();
  const sessions = seedDemoFiles();

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
    stdio: 'inherit'
  });

  const shutdown = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await waitForApiReady(`http://127.0.0.1:${PORT}/api/agents`);
    console.log(`[demo] Dashboard: http://localhost:${PORT}`);
    console.log(`[demo] Data dir: ${DATA_DIR}`);
    console.log('[demo] You can observe agents, logs, context and L1/L2/L3 in the UI.');

    await sleep(1200);
    await runScenario(sessions);

    if (EXIT_ON_COMPLETE) {
      shutdown();
      return;
    }

    console.log('[demo] Running. Press Ctrl+C to stop.');
    await new Promise(() => {});
  } catch (err) {
    console.error('[demo] Failed:', err.message);
    shutdown();
    process.exit(1);
  }
}

main();
