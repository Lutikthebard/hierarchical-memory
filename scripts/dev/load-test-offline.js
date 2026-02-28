#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOAD_ROOT = path.join(ROOT_DIR, 'tmp', 'load-test-offline');
const HOME_DIR = path.join(LOAD_ROOT, 'home');
const DATA_DIR = path.join(LOAD_ROOT, 'data');
const AGENTS_CONFIG_PATH = path.join(LOAD_ROOT, 'agents.json');
const REPORTS_DIR = path.join(LOAD_ROOT, 'reports');

const PORT = parseInt(process.env.PORT || '3461', 10);
const AGENTS_COUNT = Math.max(3, parseInt(process.env.LOAD_AGENTS || '6', 10));
const DURATION_SEC = Math.max(10, parseInt(process.env.LOAD_DURATION_SEC || '90', 10));
const STATS_POLL_MS = Math.max(1000, parseInt(process.env.LOAD_STATS_POLL_MS || '2000', 10));
const KEEP_ALIVE = process.env.LOAD_KEEP_ALIVE === '1';
const BASE_TS = Date.now();
const SCENARIOS = (process.env.LOAD_SCENARIOS || 'burst,dialogue,session-rotate,compaction-event')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const AGENTS = Array.from({ length: AGENTS_COUNT }, (_, i) => `load-agent-${i + 1}`);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(offsetMs = 0) {
  return new Date(BASE_TS + offsetMs).toISOString();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(items) {
  return items[randInt(0, items.length - 1)];
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

function appendMessage(sessionFile, role, content, ts) {
  appendJsonLine(sessionFile, {
    type: 'message',
    message: {
      role,
      content,
      timestamp: ts
    }
  });
}

function appendCompactionEvent(sessionFile, tokensBefore = randInt(8000, 24000)) {
  appendJsonLine(sessionFile, {
    type: 'compaction',
    tokensBefore
  });
}

function resetWorkspace() {
  fs.rmSync(LOAD_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function seedAgents() {
  const agentsConfig = {
    agents: AGENTS.map((id) => ({ id, name: id, enabled: true, isSubagent: false }))
  };
  fs.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(agentsConfig, null, 2), 'utf8');

  const sessions = {};
  for (let i = 0; i < AGENTS.length; i++) {
    const id = AGENTS[i];
    const sessionsDir = path.join(HOME_DIR, '.openclaw', 'agents', id, 'sessions');
    const sessionId = `${id}-session-1`;
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(sessionFile, '', 'utf8');

    const agentDataDir = path.join(DATA_DIR, id);
    fs.mkdirSync(agentDataDir, { recursive: true });
    fs.writeFileSync(path.join(agentDataDir, 'config.json'), JSON.stringify({
      thresholds: { L1: 8, default: 3 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: { enabled: false, onNewSession: false, onCompaction: false },
      autoCompact: {
        enabled: i % 2 === 0,
        messageThreshold: 16,
        retries: 3,
        retryDelayMs: 1000
      }
    }, null, 2), 'utf8');

    sessions[id] = {
      sessionNo: 1,
      sessionId,
      sessionFile,
      sessionsDir,
      messageSeq: 0
    };
  }

  return sessions;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res.json();
}

async function waitForReady(port, agentsCount, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const payload = await fetchJson(`http://127.0.0.1:${port}/api/agents`);
      if (payload.agents?.length === agentsCount && payload.agents.every((a) => a.running)) {
        return;
      }
    } catch (_e) {}
    await sleep(300);
  }
  throw new Error('Load-test server not ready');
}

function rotateSession(sessionState, nowMs) {
  sessionState.sessionNo += 1;
  sessionState.sessionId = `${path.basename(sessionState.sessionsDir)}-session-${sessionState.sessionNo}`;
  sessionState.sessionFile = path.join(sessionState.sessionsDir, `${sessionState.sessionId}.jsonl`);
  fs.writeFileSync(sessionState.sessionFile, '', 'utf8');
  appendMessage(
    sessionState.sessionFile,
    'assistant',
    `Session switched to ${sessionState.sessionId}`,
    nowIso(nowMs)
  );
}

async function runBurstScenario(state, untilTs) {
  while (Date.now() < untilTs) {
    const agentId = pick(AGENTS);
    const s = state.sessions[agentId];
    s.messageSeq += 1;
    const role = s.messageSeq % 2 === 0 ? 'assistant' : 'user';
    const ts = nowIso(Date.now() - BASE_TS);
    appendMessage(s.sessionFile, role, `[burst] ${agentId} msg-${s.messageSeq}`, ts);
    state.generatedMessages += 1;
    await sleep(randInt(10, 35));
  }
}

async function runDialogueScenario(state, untilTs) {
  while (Date.now() < untilTs) {
    const a = pick(AGENTS);
    const b = pick(AGENTS.filter((x) => x !== a));
    const ts = nowIso(Date.now() - BASE_TS);
    const sa = state.sessions[a];
    const sb = state.sessions[b];
    sa.messageSeq += 1;
    sb.messageSeq += 1;
    appendMessage(sa.sessionFile, 'user', `[dialogue] ping ${b} #${sa.messageSeq}`, ts);
    appendMessage(sb.sessionFile, 'assistant', `[dialogue] ack ${a} #${sb.messageSeq}`, ts);
    state.generatedMessages += 2;
    await sleep(randInt(40, 90));
  }
}

async function runSessionRotateScenario(state, untilTs) {
  while (Date.now() < untilTs) {
    const id = pick(AGENTS);
    rotateSession(state.sessions[id], Date.now() - BASE_TS);
    state.sessionRotations += 1;
    await sleep(randInt(2500, 5000));
  }
}

async function runCompactionEventScenario(state, untilTs) {
  while (Date.now() < untilTs) {
    const id = pick(AGENTS);
    const s = state.sessions[id];
    appendCompactionEvent(s.sessionFile);
    state.compactionEvents += 1;
    await sleep(randInt(1800, 4000));
  }
}

async function collectStats(state, untilTs) {
  while (Date.now() < untilTs) {
    try {
      const snapshotAt = new Date().toISOString();
      const rows = await Promise.all(AGENTS.map(async (id) => {
        const stats = await fetchJson(`http://127.0.0.1:${PORT}/api/agents/${id}/stats`);
        return {
          agentId: id,
          messagesCount: stats.messagesCount || 0,
          unsummarized: stats.unsummarized || 0,
          l1: stats.artifacts?.L1 || 0,
          l2: stats.artifacts?.L2 || 0,
          l3: stats.artifacts?.L3 || 0,
          sessionMessageCount: stats.sessionMessageCount || 0
        };
      }));
      state.statsSamples.push({ snapshotAt, rows });
    } catch (err) {
      state.errors.push(`stats_poll: ${err.message}`);
    }
    await sleep(STATS_POLL_MS);
  }
}

function readWatcherErrors() {
  const issues = [];
  for (const id of AGENTS) {
    const logPath = path.join(DATA_DIR, id, 'watch.log');
    if (!fs.existsSync(logPath)) continue;
    const content = fs.readFileSync(logPath, 'utf8');
    const badLines = content
      .split('\n')
      .filter((line) => /error|failed|exception/i.test(line) && !/Skipping duplicate/i.test(line));
    if (badLines.length > 0) {
      issues.push({ agentId: id, count: badLines.length, sample: badLines.slice(0, 5) });
    }
  }
  return issues;
}

function summarize(state, startedAt, endedAt) {
  const latest = state.statsSamples[state.statsSamples.length - 1];
  const finalRows = latest ? latest.rows : [];
  const totalL1 = finalRows.reduce((sum, r) => sum + r.l1, 0);
  const totalL2 = finalRows.reduce((sum, r) => sum + r.l2, 0);
  const totalL3 = finalRows.reduce((sum, r) => sum + r.l3, 0);
  const totalUnsummarized = finalRows.reduce((sum, r) => sum + r.unsummarized, 0);

  return {
    startedAt,
    endedAt,
    durationSec: Math.round((endedAt - startedAt) / 1000),
    port: PORT,
    scenarios: SCENARIOS,
    agents: AGENTS,
    generatedMessages: state.generatedMessages,
    sessionRotations: state.sessionRotations,
    compactionEventsInjected: state.compactionEvents,
    statsSamples: state.statsSamples.length,
    finalTotals: {
      l1: totalL1,
      l2: totalL2,
      l3: totalL3,
      unsummarized: totalUnsummarized
    },
    watcherIssues: readWatcherErrors(),
    runtimeErrors: state.errors
  };
}

function writeReports(summary) {
  const jsonPath = path.join(REPORTS_DIR, 'latest.json');
  const mdPath = path.join(REPORTS_DIR, 'latest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');

  const md = [
    '# Offline Load Test Report',
    '',
    `- Started: ${new Date(summary.startedAt).toISOString()}`,
    `- Ended: ${new Date(summary.endedAt).toISOString()}`,
    `- Duration: ${summary.durationSec}s`,
    `- Agents: ${summary.agents.length}`,
    `- Scenarios: ${summary.scenarios.join(', ')}`,
    '',
    '## Traffic',
    `- Generated messages: ${summary.generatedMessages}`,
    `- Session rotations: ${summary.sessionRotations}`,
    `- Compaction events injected: ${summary.compactionEventsInjected}`,
    `- Stats samples: ${summary.statsSamples}`,
    '',
    '## Final Totals',
    `- L1 artifacts: ${summary.finalTotals.l1}`,
    `- L2 artifacts: ${summary.finalTotals.l2}`,
    `- L3 artifacts: ${summary.finalTotals.l3}`,
    `- Unsummarized messages: ${summary.finalTotals.unsummarized}`,
    '',
    '## Issues',
    `- Watcher issues: ${summary.watcherIssues.length}`,
    `- Runtime errors: ${summary.runtimeErrors.length}`
  ].join('\n');

  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');
  return { jsonPath, mdPath };
}

async function main() {
  resetWorkspace();
  const sessions = seedAgents();

  const state = {
    sessions,
    generatedMessages: 0,
    sessionRotations: 0,
    compactionEvents: 0,
    statsSamples: [],
    errors: []
  };

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

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!server.killed) server.kill('SIGTERM');
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const startedAt = Date.now();
  try {
    await waitForReady(PORT, AGENTS.length, 25000);
    await sleep(1200);

    const untilTs = Date.now() + DURATION_SEC * 1000;
    const tasks = [collectStats(state, untilTs)];

    if (SCENARIOS.includes('burst')) tasks.push(runBurstScenario(state, untilTs));
    if (SCENARIOS.includes('dialogue')) tasks.push(runDialogueScenario(state, untilTs));
    if (SCENARIOS.includes('session-rotate')) tasks.push(runSessionRotateScenario(state, untilTs));
    if (SCENARIOS.includes('compaction-event')) tasks.push(runCompactionEventScenario(state, untilTs));

    await Promise.all(tasks);

    const endedAt = Date.now();
    const summary = summarize(state, startedAt, endedAt);
    const paths = writeReports(summary);

    console.log('[loadtest] Completed');
    console.log(`[loadtest] Report JSON: ${paths.jsonPath}`);
    console.log(`[loadtest] Report MD: ${paths.mdPath}`);
    console.log(`[loadtest] Dashboard data dir: ${DATA_DIR}`);
    console.log(`[loadtest] Open dashboard: http://localhost:${PORT}`);

    if (KEEP_ALIVE) {
      console.log('[loadtest] KEEP_ALIVE=1 -> server stays running (Ctrl+C to stop)');
      await new Promise(() => {});
    }
  } catch (err) {
    console.error(`[loadtest] Failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (!KEEP_ALIVE) {
      shutdown();
    }
  }
}

main();
