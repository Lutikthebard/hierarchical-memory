#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { OpenClawClient } = require('../gateway-client');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const E2E_ROOT = path.join(ROOT_DIR, 'tmp', 'real-e2e');

function buildRunLayout(args) {
  const runRoot = path.join(E2E_ROOT, args.runId);
  return {
    runRoot,
    dataDir: path.join(runRoot, 'data'),
    runInfoPath: path.join(E2E_ROOT, 'latest-run.json'),
    agentsConfigPath: path.join(runRoot, 'agents.json'),
    workspaceDir: path.join(runRoot, 'agent-workspace', args.agentId),
    reportPath: path.join(runRoot, 'report.json')
  };
}

function parseArgs(argv) {
  const args = {
    agentId: 'hm-real-e2e-agent',
    port: 3475,
    keepAlive: false,
    timeoutSec: 180,
    model: 'openai-codex/gpt-5.1-codex-mini',
    gatewayUrl: process.env.GATEWAY_URL || 'ws://127.0.0.1:18789',
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    openclawAgentsDir: process.env.OPENCLAW_AGENTS_DIR || '',
    openclawHome: process.env.OPENCLAW_HOME || path.join(process.env.HOME || '', '.openclaw'),
    gatewayToken: process.env.GATEWAY_TOKEN || '',
    gatewayPassword: process.env.GATEWAY_PASSWORD || '',
    turnsPerWave: 4,
    maxDriveTurns: 96
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--agent' && next) {
      args.agentId = next;
      i++;
      continue;
    }
    if (key === '--port' && next) {
      args.port = parseInt(next, 10) || args.port;
      i++;
      continue;
    }
    if (key === '--timeout-sec' && next) {
      args.timeoutSec = Math.max(30, parseInt(next, 10) || args.timeoutSec);
      i++;
      continue;
    }
    if (key === '--gateway-url' && next) {
      args.gatewayUrl = next;
      i++;
      continue;
    }
    if (key === '--model' && next) {
      args.model = next;
      i++;
      continue;
    }
    if (key === '--run-id' && next) {
      args.runId = next;
      i++;
      continue;
    }
    if (key === '--openclaw-agents-dir' && next) {
      args.openclawAgentsDir = next;
      i++;
      continue;
    }
    if (key === '--openclaw-home' && next) {
      args.openclawHome = next;
      i++;
      continue;
    }
    if (key === '--gateway-token' && next) {
      args.gatewayToken = next;
      i++;
      continue;
    }
    if (key === '--gateway-password' && next) {
      args.gatewayPassword = next;
      i++;
      continue;
    }
    if (key === '--keep-alive') {
      args.keepAlive = true;
      continue;
    }
    if (key === '--turns-per-wave' && next) {
      args.turnsPerWave = Math.max(1, parseInt(next, 10) || args.turnsPerWave);
      i++;
      continue;
    }
    if (key === '--max-drive-turns' && next) {
      args.maxDriveTurns = Math.max(1, parseInt(next, 10) || args.maxDriveTurns);
      i++;
      continue;
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApiReady(baseUrl, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/agents`);
      if (res.ok) return;
    } catch (_e) {}
    await sleep(300);
  }
  throw new Error(`API is not ready at ${baseUrl} within ${timeoutMs}ms`);
}

async function apiJson(baseUrl, method, endpoint, body = null) {
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = payload?.error || `${res.status} ${res.statusText}`;
    throw new Error(`${method} ${endpoint} failed: ${details}`);
  }
  return payload;
}

async function syncSessionWithRetry(baseUrl, agentId, maxAttempts = 10, delayMs = 800) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/session/sync`, {});
    } catch (e) {
      lastErr = e;
      if (!String(e.message || '').includes('No JSONL files found')) {
        throw e;
      }
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastErr || new Error('Failed to sync session');
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function resetPreRunAgentState({ runRoot, agentsRoot, agentId }) {
  const result = {
    runRootCleared: false,
    sessionJsonlRemoved: 0,
    sessionDir: path.join(agentsRoot, agentId, 'sessions')
  };

  if (runRoot && fs.existsSync(runRoot)) {
    fs.rmSync(runRoot, { recursive: true, force: true });
    result.runRootCleared = true;
  }

  if (!fs.existsSync(result.sessionDir)) {
    return result;
  }

  const entries = fs.readdirSync(result.sessionDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.jsonl')) continue;
    fs.unlinkSync(path.join(result.sessionDir, entry.name));
    result.sessionJsonlRemoved += 1;
  }

  return result;
}

function ensureGatewayAgentProvisioned({ openclawHome, openclawAgentsDir, agentId, workspaceDir, model }) {
  const configPath = path.join(openclawHome, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`openclaw.json not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.agents || typeof config.agents !== 'object') {
    config.agents = {};
  }
  if (!Array.isArray(config.agents.list)) {
    config.agents.list = [];
  }
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object') {
    config.agents.defaults = {};
  }
  if (!config.agents.defaults.models || typeof config.agents.defaults.models !== 'object') {
    config.agents.defaults.models = {};
  }

  let changed = false;
  let created = false;

  let agent = config.agents.list.find((a) => a && a.id === agentId);
  if (!agent) {
    agent = { id: agentId };
    config.agents.list.push(agent);
    changed = true;
    created = true;
  }

  if (agent.workspace !== workspaceDir) {
    agent.workspace = workspaceDir;
    changed = true;
  }
  if (!agent.model || typeof agent.model !== 'object') {
    agent.model = {};
    changed = true;
  }
  if (agent.model.primary !== model) {
    agent.model.primary = model;
    changed = true;
  }

  if (!config.agents.defaults.models[model]) {
    config.agents.defaults.models[model] = {};
    changed = true;
  }

  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(openclawHome, `openclaw.json.bak.real-e2e-${stamp}`);
    fs.copyFileSync(configPath, backupPath);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  const agentsRoot = openclawAgentsDir || path.join(openclawHome, 'agents');
  fs.mkdirSync(path.join(agentsRoot, agentId, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(agentsRoot, agentId, 'sessions'), { recursive: true });

  return {
    configPath,
    agentsRoot,
    changed,
    created,
    model,
    workspaceDir
  };
}

function loadGlobalThresholds() {
  const configPath = path.join(ROOT_DIR, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { L1: 60, default: 5 };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed?.thresholds || { L1: 60, default: 5 };
  } catch (_e) {
    return { L1: 60, default: 5 };
  }
}

function parseIsoTimestampMs(value) {
  if (!value) return null;
  const ts = Date.parse(String(value));
  return Number.isFinite(ts) ? ts : null;
}

function normalizeArtifactArray(storePayload, levelKey) {
  const list = storePayload?.artifacts?.[levelKey];
  return Array.isArray(list) ? list : [];
}

function artifactKey(levelKey, artifact) {
  if (artifact && artifact.artifactId) {
    return String(artifact.artifactId);
  }
  const start = artifact?.startTimestamp || '';
  const end = artifact?.endTimestamp || '';
  const hash = artifact?.contentHash || '';
  return `${levelKey}|${start}|${end}|${hash}`;
}

function buildArtifactKeySet(levelKey, artifacts) {
  const set = new Set();
  for (const artifact of artifacts) {
    set.add(artifactKey(levelKey, artifact));
  }
  return set;
}

function countAddedArtifacts(current, baseline) {
  let added = 0;
  for (const key of current) {
    if (!baseline.has(key)) {
      added++;
    }
  }
  return added;
}

function getLastEndTimestampMs(artifacts) {
  let maxTs = null;
  for (const artifact of artifacts) {
    const ts = parseIsoTimestampMs(artifact?.endTimestamp);
    if (ts === null) continue;
    if (maxTs === null || ts > maxTs) {
      maxTs = ts;
    }
  }
  return maxTs;
}

function countUnsummarizedArtifacts(sourceArtifacts, targetArtifacts) {
  if (!sourceArtifacts.length) return 0;
  const lastTargetEndTs = getLastEndTimestampMs(targetArtifacts);
  if (lastTargetEndTs === null) {
    return sourceArtifacts.length;
  }
  let count = 0;
  for (const artifact of sourceArtifacts) {
    const endTs = parseIsoTimestampMs(artifact?.endTimestamp);
    if (endTs !== null && endTs > lastTargetEndTs) {
      count++;
    }
  }
  return count;
}

async function fetchMemorySnapshot(baseUrl, agentId) {
  const [storePayload, statsPayload, configPayload] = await Promise.all([
    apiJson(baseUrl, 'GET', `/api/agents/${agentId}/store`),
    apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`),
    apiJson(baseUrl, 'GET', `/api/agents/${agentId}/config`)
  ]);

  const artifacts = {
    L1: normalizeArtifactArray(storePayload, 'L1'),
    L2: normalizeArtifactArray(storePayload, 'L2'),
    L3: normalizeArtifactArray(storePayload, 'L3')
  };

  return {
    storePayload,
    statsPayload,
    configPayload,
    artifacts,
    keys: {
      L1: buildArtifactKeySet('L1', artifacts.L1),
      L2: buildArtifactKeySet('L2', artifacts.L2),
      L3: buildArtifactKeySet('L3', artifacts.L3)
    }
  };
}

function resolveLevelThreshold({ level, agentConfig, globalThresholds, statsPayload }) {
  const fromAgent = agentConfig?.thresholds?.[`L${level}`];
  if (Number.isFinite(Number(fromAgent)) && Number(fromAgent) > 0) {
    return Number(fromAgent);
  }
  if (level === 1) {
    const fromStats = statsPayload?.threshold;
    if (Number.isFinite(Number(fromStats)) && Number(fromStats) > 0) {
      return Number(fromStats);
    }
    const agentL1 = agentConfig?.thresholds?.L1;
    if (Number.isFinite(Number(agentL1)) && Number(agentL1) > 0) {
      return Number(agentL1);
    }
  }

  const fromGlobal = globalThresholds?.[`L${level}`];
  if (Number.isFinite(Number(fromGlobal)) && Number(fromGlobal) > 0) {
    return Number(fromGlobal);
  }

  const globalDefault = globalThresholds?.default;
  if (Number.isFinite(Number(globalDefault)) && Number(globalDefault) > 0) {
    return Number(globalDefault);
  }

  const agentDefault = agentConfig?.thresholds?.default;
  if (Number.isFinite(Number(agentDefault)) && Number(agentDefault) > 0) {
    return Number(agentDefault);
  }

  return level === 1 ? 60 : 5;
}

function planSummarizationWave(snapshot, globalThresholds) {
  const unsummarizedL0 = Number(snapshot.statsPayload?.unsummarized || 0);
  const thresholdL1 = resolveLevelThreshold({
    level: 1,
    agentConfig: snapshot.configPayload,
    globalThresholds,
    statsPayload: snapshot.statsPayload
  });
  const thresholdL2 = resolveLevelThreshold({
    level: 2,
    agentConfig: snapshot.configPayload,
    globalThresholds,
    statsPayload: snapshot.statsPayload
  });
  const thresholdL3 = resolveLevelThreshold({
    level: 3,
    agentConfig: snapshot.configPayload,
    globalThresholds,
    statsPayload: snapshot.statsPayload
  });

  const unsummarizedL1 = countUnsummarizedArtifacts(snapshot.artifacts.L1, snapshot.artifacts.L2);
  const unsummarizedL2 = countUnsummarizedArtifacts(snapshot.artifacts.L2, snapshot.artifacts.L3);
  const planned = { L1: 0, L2: 0, L3: 0 };

  planned.L1 = unsummarizedL0 >= thresholdL1 ? 1 : 0;
  const forecastUnsummarizedL1 = unsummarizedL1 + planned.L1;
  planned.L2 = forecastUnsummarizedL1 >= thresholdL2 ? 1 : 0;
  const forecastUnsummarizedL2 = unsummarizedL2 + planned.L2;
  planned.L3 = forecastUnsummarizedL2 >= thresholdL3 ? 1 : 0;

  return {
    planned,
    inputs: {
      unsummarizedL0,
      unsummarizedL1,
      unsummarizedL2,
      thresholds: { L1: thresholdL1, L2: thresholdL2, L3: thresholdL3 }
    }
  };
}

function plannedTotal(planned) {
  return Number(planned.L1 || 0) + Number(planned.L2 || 0) + Number(planned.L3 || 0);
}

async function waitForArtifactAdditions({
  baseUrl,
  agentId,
  baselineKeys,
  planned,
  timeoutMs
}) {
  const started = Date.now();
  let lastObserved = { L1: 0, L2: 0, L3: 0 };

  while (Date.now() - started < timeoutMs) {
    const snapshot = await fetchMemorySnapshot(baseUrl, agentId);
    const observed = {
      L1: countAddedArtifacts(snapshot.keys.L1, baselineKeys.L1),
      L2: countAddedArtifacts(snapshot.keys.L2, baselineKeys.L2),
      L3: countAddedArtifacts(snapshot.keys.L3, baselineKeys.L3)
    };
    lastObserved = observed;

    const done =
      observed.L1 >= planned.L1 &&
      observed.L2 >= planned.L2 &&
      observed.L3 >= planned.L3;
    if (done) {
      return { snapshot, observed };
    }

    await sleep(1200);
  }

  throw new Error(
    `Timed out waiting for planned artifact additions. Planned L1/L2/L3=${planned.L1}/${planned.L2}/${planned.L3}, ` +
      `observed L1/L2/L3=${lastObserved.L1}/${lastObserved.L2}/${lastObserved.L3}`
  );
}

async function waitForPlannedSummarizations(baseUrl, agentId, timeoutMs) {
  const started = Date.now();
  const globalThresholds = loadGlobalThresholds();
  const waves = [];

  while (Date.now() - started < timeoutMs) {
    const snapshot = await fetchMemorySnapshot(baseUrl, agentId);
    const wavePlan = planSummarizationWave(snapshot, globalThresholds);
    if (plannedTotal(wavePlan.planned) === 0) {
      return {
        waves,
        final: {
          artifacts: snapshot.statsPayload?.artifacts || {},
          messagesCount: snapshot.statsPayload?.messagesCount || 0,
          unsummarized: snapshot.statsPayload?.unsummarized || 0
        }
      };
    }

    const baselineKeys = {
      L1: new Set(snapshot.keys.L1),
      L2: new Set(snapshot.keys.L2),
      L3: new Set(snapshot.keys.L3)
    };
    const remaining = timeoutMs - (Date.now() - started);
    const { observed } = await waitForArtifactAdditions({
      baseUrl,
      agentId,
      baselineKeys,
      planned: wavePlan.planned,
      timeoutMs: Math.max(1000, remaining)
    });

    waves.push({
      wave: waves.length + 1,
      planned: wavePlan.planned,
      observed,
      atPlan: wavePlan.inputs
    });
  }

  throw new Error(`Timeout waiting for all planned summarizations within ${timeoutMs}ms`);
}

async function waitForArtifactMinimums(baseUrl, agentId, minimums, timeoutMs) {
  const started = Date.now();
  let lastStats = null;

  while (Date.now() - started < timeoutMs) {
    const stats = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
    lastStats = stats;

    let ok = true;
    for (const [levelKey, minCount] of Object.entries(minimums)) {
      const got = Number(stats?.artifacts?.[levelKey] || 0);
      if (got < Number(minCount)) {
        ok = false;
        break;
      }
    }

    if (ok) {
      return stats;
    }

    await sleep(1200);
  }

  const observed = {
    L1: Number(lastStats?.artifacts?.L1 || 0),
    L2: Number(lastStats?.artifacts?.L2 || 0),
    L3: Number(lastStats?.artifacts?.L3 || 0)
  };
  throw new Error(
    `Timed out waiting for artifact minimums. Required=${JSON.stringify(minimums)}, observed=${JSON.stringify(observed)}`
  );
}

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);
}

function buildAttemptsDistribution(events) {
  const dist = {};
  for (const event of events) {
    const attempt = Number(event?.attemptsBeforeProcessed);
    if (!Number.isFinite(attempt) || attempt <= 0) continue;
    const key = String(attempt);
    dist[key] = (dist[key] || 0) + 1;
  }
  return dist;
}

function collectSummarizationTelemetry(dataDir, agentId) {
  const telemetryPath = path.join(dataDir, agentId, 'summarization-events.jsonl');
  const events = readJsonlSafe(telemetryPath);

  const requests = events.filter((e) => e.eventType === 'memory_task_sent');
  const responses = events.filter((e) => e.eventType === 'memory_task_response');
  const processed = events.filter((e) => e.eventType === 'artifact_processed');
  const failed = events.filter((e) => e.eventType === 'artifact_failed');

  const byTransition = {};
  for (const req of requests) {
    const key = `L${req.sourceLevel}->L${req.targetLevel}`;
    byTransition[key] = byTransition[key] || { requests: 0, processed: 0, failed: 0 };
    byTransition[key].requests += 1;
  }
  for (const done of processed) {
    const key = `L${done.sourceLevel}->L${done.targetLevel}`;
    byTransition[key] = byTransition[key] || { requests: 0, processed: 0, failed: 0 };
    byTransition[key].processed += 1;
  }
  for (const err of failed) {
    const key = `L${err.sourceLevel}->L${err.targetLevel}`;
    byTransition[key] = byTransition[key] || { requests: 0, processed: 0, failed: 0 };
    byTransition[key].failed += 1;
  }

  // Aggregate capture methods from response events
  const captureMethodCounts = {};
  for (const resp of responses) {
    const method = resp.captureMethod || 'unknown';
    captureMethodCounts[method] = (captureMethodCounts[method] || 0) + 1;
  }

  return {
    telemetryPath,
    eventsTotal: events.length,
    memoryTaskRequestsTotal: requests.length,
    artifactsProcessedTotal: processed.length,
    artifactsFailedTotal: failed.length,
    attemptsDistribution: buildAttemptsDistribution(processed),
    transitions: byTransition,
    captureMethodCounts
  };
}

function buildDialoguePrompt(stepNo) {
  return [
    `E2E step ${stepNo} for memory test.`,
    'Reply in one concise sentence.',
    `Keep continuity with previous steps and mention one concrete fact #${stepNo}.`
  ].join(' ');
}

async function driveDialogueTurns(client, sessionKey, startStep, count, timeoutSec) {
  const transcript = [];
  let step = startStep;
  for (let i = 0; i < count; i++, step++) {
    const prompt = buildDialoguePrompt(step);
    const response = await client.sendAndWait(sessionKey, prompt, timeoutSec);
    transcript.push({
      step,
      prompt,
      response: String(response || '').slice(0, 220)
    });
    await sleep(800);
  }
  return transcript;
}

async function driveUntilL3({
  baseUrl,
  agentId,
  gatewayUrl,
  gatewayToken,
  gatewayPassword,
  timeoutSec,
  maxDriveTurns,
  turnsPerWave,
  initialStep = 1
}) {
  const timeoutMs = timeoutSec * 1000;
  const started = Date.now();
  const client = new OpenClawClient(gatewayUrl, gatewayToken || undefined, {
    gatewayPassword: gatewayPassword || undefined,
    postWaitPollIntervalMs: 1200,
    postWaitWindowMs: 15000
  });

  let stepCursor = initialStep;
  const transcript = [];
  const waves = [];

  try {
    await client.connect();
    const sessionKey = `agent:${agentId}:main`;

    while (Date.now() - started < timeoutMs && transcript.length < maxDriveTurns) {
      const statsBefore = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
      const l3Before = Number(statsBefore?.artifacts?.L3 || 0);
      if (l3Before >= 1) {
        return {
          reachedL3: true,
          turnsSent: transcript.length,
          transcriptSample: transcript.slice(-4),
          waves
        };
      }

      const remainingTurns = maxDriveTurns - transcript.length;
      const turnsThisWave = Math.min(turnsPerWave, remainingTurns);
      const waveTranscript = await driveDialogueTurns(client, sessionKey, stepCursor, turnsThisWave, timeoutSec);
      transcript.push(...waveTranscript);
      stepCursor += waveTranscript.length;

      const remainingMs = timeoutMs - (Date.now() - started);
      if (remainingMs <= 0) break;
      const sweep = await waitForPlannedSummarizations(
        baseUrl,
        agentId,
        Math.min(remainingMs, 60000)
      );
      const statsAfter = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
      waves.push({
        wave: waves.length + 1,
        turnsSent: waveTranscript.length,
        l1: Number(statsAfter?.artifacts?.L1 || 0),
        l2: Number(statsAfter?.artifacts?.L2 || 0),
        l3: Number(statsAfter?.artifacts?.L3 || 0),
        plannedWaves: sweep.waves || []
      });
    }
  } finally {
    client.close();
  }

  const finalStats = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
  return {
    reachedL3: Number(finalStats?.artifacts?.L3 || 0) >= 1,
    turnsSent: transcript.length,
    transcriptSample: transcript.slice(-4),
    finalStats,
    waves
  };
}

async function verifyCompressionToL3(baseUrl, agentId, timeoutMs) {
  const stats = await waitForArtifactMinimums(baseUrl, agentId, { L2: 1, L3: 1 }, timeoutMs);
  const snapshot = await fetchMemorySnapshot(baseUrl, agentId);
  const thresholdL3 = resolveLevelThreshold({
    level: 3,
    agentConfig: snapshot.configPayload,
    globalThresholds: loadGlobalThresholds(),
    statsPayload: snapshot.statsPayload
  });

  const l3Artifacts = snapshot.artifacts.L3 || [];
  const qualifying = l3Artifacts.filter((artifact) => {
    const sourceLevel = Number(artifact?.sourceLevel);
    const count = Number(artifact?.artifactCount || 0);
    return sourceLevel === 2 && count >= thresholdL3;
  });

  if (qualifying.length === 0) {
    const summary = l3Artifacts.map((artifact) => ({
      artifactId: artifact?.artifactId || null,
      sourceLevel: artifact?.sourceLevel ?? null,
      artifactCount: artifact?.artifactCount ?? null,
      startTimestamp: artifact?.startTimestamp || null,
      endTimestamp: artifact?.endTimestamp || null
    }));
    throw new Error(
      `L3 artifacts exist but no qualifying L2->L3 compression found (required sourceLevel=2 and artifactCount>=${thresholdL3}). ` +
        `Observed=${JSON.stringify(summary)}`
    );
  }

  return {
    artifacts: stats.artifacts,
    messagesCount: stats.messagesCount,
    unsummarized: stats.unsummarized,
    l3Compression: {
      requiredMinSourceArtifacts: thresholdL3,
      qualifyingCount: qualifying.length,
      sample: qualifying.slice(0, 3).map((artifact) => ({
        artifactId: artifact?.artifactId || null,
        sourceLevel: artifact?.sourceLevel,
        artifactCount: artifact?.artifactCount,
        startTimestamp: artifact?.startTimestamp,
        endTimestamp: artifact?.endTimestamp
      }))
    }
  };
}

function prepareRun(args, runLayout = buildRunLayout(args)) {
  const { runRoot, dataDir, runInfoPath, agentsConfigPath, workspaceDir, reportPath } = runLayout;

  fs.mkdirSync(runRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  writeJson(agentsConfigPath, {
    agents: [
      {
        id: args.agentId,
        name: args.agentId,
        enabled: true,
        isSubagent: false
      }
    ]
  });

  const agentDataDir = path.join(dataDir, args.agentId);
  fs.mkdirSync(agentDataDir, { recursive: true });

  writeJson(path.join(agentDataDir, 'config.json'), {
    thresholds: { L1: 4, default: 2 },
    prompts: {
      l1: 'Summarize into max 5 short bullets: decisions, facts, open items.',
      aggregate: 'Compress L{level} into max 5 bullets: key themes and durable conclusions.'
    },
    filters: {
      exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
      excludePatterns: [],
      countRoles: ['user', 'assistant'],
      storeRoles: ['user', 'assistant'],
      storeMessageClasses: ['dialogue', 'inter_agent', 'command'],
      countMessageClasses: ['dialogue', 'command'],
      contextMessageClasses: ['dialogue', 'inter_agent', 'command'],
      commandAllowlist: ['/new', '/reset', '/compact']
    },
    autoInjectContext: {
      enabled: true,
      onNewSession: true,
      onCompaction: true,
      preText: '',
      postText: '',
      preMdFiles: [],
      postMdFiles: []
    },
    autoCompact: {
      enabled: true,
      messageThreshold: 12,
      postCompactMessage: '',
      retries: 5,
      retryDelayMs: 3000
    }
  });

  fs.writeFileSync(
    path.join(workspaceDir, 'README.md'),
    `# Real E2E Agent Workspace\n\nAgent: ${args.agentId}\nRun: ${args.runId}\nCreated: ${new Date().toISOString()}\n`,
    'utf8'
  );

  const runInfo = {
    runId: args.runId,
    agentId: args.agentId,
    port: args.port,
    baseUrl: `http://127.0.0.1:${args.port}`,
    runRoot,
    dataDir,
    agentsConfigPath,
    workspaceDir,
    model: args.model,
    reportPath,
    startedAt: new Date().toISOString()
  };
  writeJson(runInfoPath, runInfo);

  return runInfo;
}

function startServer(runInfo, args) {
  const env = {
    ...process.env,
    PORT: String(args.port),
    HM_DATA_DIR: runInfo.dataDir,
    HM_AGENTS_CONFIG_PATH: runInfo.agentsConfigPath,
    GATEWAY_URL: args.gatewayUrl
  };

  if (args.openclawAgentsDir) {
    env.OPENCLAW_AGENTS_DIR = args.openclawAgentsDir;
  }

  const server = spawn('node', [path.join(ROOT_DIR, 'web/server.js')], {
    cwd: ROOT_DIR,
    env,
    stdio: 'inherit'
  });

  server.on('exit', (code, signal) => {
    console.log(`[real-e2e] server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });

  return server;
}

async function runScenario(runInfo, args) {
  const baseUrl = runInfo.baseUrl;
  const agentId = runInfo.agentId;
  const timeoutMs = args.timeoutSec * 1000;
  const report = {
    runId: runInfo.runId,
    agentId,
    baseUrl,
    workspaceDir: runInfo.workspaceDir,
    model: args.model,
    steps: [],
    startedAt: new Date().toISOString()
  };

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const result = await fn();
      report.steps.push({ name, ok: true, durationMs: Date.now() - started, result });
      return result;
    } catch (e) {
      report.steps.push({ name, ok: false, durationMs: Date.now() - started, error: e.message });
      throw e;
    }
  };

  await step('api-ready', async () => {
    await waitForApiReady(baseUrl, 45000);
    return { ready: true };
  });

  await step('gateway-agent-preflight', async () => {
    const client = new OpenClawClient(args.gatewayUrl, args.gatewayToken || undefined, {
      gatewayPassword: args.gatewayPassword || undefined,
      postWaitPollIntervalMs: 1000,
      postWaitWindowMs: 10000
    });
    try {
      await client.connect();
      const response = await client.sendAndWait(
        `agent:${agentId}:main`,
        'Preflight check for real-e2e. Reply with one word: READY.',
        Math.min(90, args.timeoutSec)
      );
      return { ok: true, responsePreview: String(response || '').slice(0, 120) };
    } catch (e) {
      throw new Error(
        `Gateway preflight failed for agent "${agentId}". If agent was just added to openclaw.json, restart gateway once. Root error: ${e.message}`
      );
    } finally {
      client.close();
    }
  });

  await step('seed-session-jsonl', async () => {
    const client = new OpenClawClient(args.gatewayUrl, args.gatewayToken || undefined, {
      gatewayPassword: args.gatewayPassword || undefined,
      postWaitPollIntervalMs: 800,
      postWaitWindowMs: 10000
    });
    try {
      await client.connect();
      const response = await client.sendAndWait(
        `agent:${agentId}:main`,
        'Session bootstrap for real-e2e. Reply with: BOOTSTRAP_OK.',
        Math.min(90, args.timeoutSec)
      );
      return { responsePreview: String(response || '').slice(0, 120) };
    } finally {
      client.close();
    }
  });

  await step('session-sync-initial', async () => {
    const payload = await syncSessionWithRetry(baseUrl, agentId, 12, 1000);
    return {
      sessionId: payload?.session?.sessionId || null,
      sessionKey: payload?.session?.sessionKey || null,
      source: payload?.source || null
    };
  });

  await step('drive-dialogue', async () => {
    const client = new OpenClawClient(args.gatewayUrl, args.gatewayToken || undefined, {
      gatewayPassword: args.gatewayPassword || undefined,
      postWaitPollIntervalMs: 1200,
      postWaitWindowMs: 15000
    });

    try {
      await client.connect();
      const sessionKey = `agent:${agentId}:main`;
      const transcript = await driveDialogueTurns(client, sessionKey, 1, 12, args.timeoutSec);
      return { turns: transcript.length, sample: transcript.slice(-2) };
    } finally {
      client.close();
    }
  });

  await step('wait-planned-summarizations', async () => {
    return waitForPlannedSummarizations(baseUrl, agentId, timeoutMs);
  });

  await step('compact-with-inject', async () => {
    const payload = await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/compact-with-inject`, {
      timeoutMs: 90000,
      pollMs: 1200
    });
    return {
      compactionDetected: payload.compactionDetected,
      fallbackDelay: payload.fallbackDelay,
      sessionId: payload?.session?.sessionId || null
    };
  });

  await step('wait-planned-summarizations-before-new', async () => {
    return waitForPlannedSummarizations(baseUrl, agentId, timeoutMs);
  });

  await step('drive-dialogue-until-l3', async () => {
    const result = await driveUntilL3({
      baseUrl,
      agentId,
      gatewayUrl: args.gatewayUrl,
      gatewayToken: args.gatewayToken,
      gatewayPassword: args.gatewayPassword,
      timeoutSec: args.timeoutSec,
      maxDriveTurns: args.maxDriveTurns,
      turnsPerWave: args.turnsPerWave,
      initialStep: 13
    });

    if (!result.reachedL3) {
      throw new Error(
        `Unable to reach L3 with additional dialogue waves. turnsSent=${result.turnsSent}, ` +
          `final=${JSON.stringify(result.finalStats?.artifacts || {})}`
      );
    }

    return result;
  });

  await step('verify-l2-l3-created', async () => {
    return verifyCompressionToL3(baseUrl, agentId, timeoutMs);
  });

  await step('summarization-telemetry', async () => {
    return collectSummarizationTelemetry(runInfo.dataDir, agentId);
  });

  await step('verify-jsonl-capture', async () => {
    const telemetry = collectSummarizationTelemetry(runInfo.dataDir, agentId);
    const { captureMethodCounts } = telemetry;
    const jsonlCount = captureMethodCounts.jsonl || 0;
    const noneCount = captureMethodCounts.none || 0;
    const totalResponses = Object.values(captureMethodCounts).reduce((a, b) => a + b, 0);

    if (totalResponses === 0) {
      throw new Error('No memory_task_response events found — summarization never completed');
    }
    if (jsonlCount === 0) {
      throw new Error(
        `No artifacts captured via JSONL read. ` +
          `captureMethodCounts=${JSON.stringify(captureMethodCounts)}`
      );
    }
    if (noneCount > 0) {
      console.warn(
        `[real-e2e] ⚠️  ${noneCount}/${totalResponses} responses had no artifact via JSONL`
      );
    }

    return {
      captureMethodCounts,
      jsonlCount,
      noneCount,
      totalResponses,
      jsonlRate: totalResponses > 0 ? jsonlCount / totalResponses : 0
    };
  });

  const beforeNewSession = await step('session-active-before-new', async () => {
    const payload = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/session/active`);
    return { sessionId: payload.sessionId, source: payload.source };
  });

  await step('trigger-new-session', async () => {
    const client = new OpenClawClient(args.gatewayUrl, args.gatewayToken || undefined, {
      gatewayPassword: args.gatewayPassword || undefined
    });
    try {
      await client.connect();
      const response = await client.sendAndWait(`agent:${agentId}:main`, '/new', args.timeoutSec);
      return { responsePreview: String(response || '').slice(0, 160) };
    } finally {
      client.close();
    }
  });

  await step('session-sync-after-new', async () => {
    await sleep(2500);
    const payload = await syncSessionWithRetry(baseUrl, agentId, 12, 1000);
    const changed = Boolean(payload?.session?.sessionId && payload.session.sessionId !== beforeNewSession.sessionId);
    if (!changed) {
      throw new Error('Session ID did not change after /new and sync');
    }
    return {
      sessionId: payload?.session?.sessionId || null,
      source: payload?.source || null,
      changed
    };
  });

  await step('rollback-preview', async () => {
    const cutoffTs = new Date(Date.now() - 60 * 1000).toISOString();
    const payload = await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/memory/rollback/preview`, { cutoffTs });
    return {
      cutoffTs,
      removedMessages: payload?.preview?.removed?.totalMessages || 0
    };
  });

  const rollbackApply = await step('rollback-apply', async () => {
    const cutoffTs = new Date(Date.now() - 60 * 1000).toISOString();
    const payload = await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/memory/rollback`, { cutoffTs });
    return {
      cutoffTs,
      backupId: payload.backupId,
      removedMessages: payload?.removed?.totalMessages || 0
    };
  });

  await step('rollback-restore', async () => {
    const payload = await apiJson(
      baseUrl,
      'POST',
      `/api/agents/${agentId}/memory/rollback/restore/${encodeURIComponent(rollbackApply.backupId)}`,
      {}
    );
    return {
      backupId: payload.backupId
    };
  });

  await step('final-stats', async () => {
    const stats = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
    return {
      artifacts: stats.artifacts,
      messagesCount: stats.messagesCount,
      sessionMessageCount: stats.sessionMessageCount
    };
  });

  report.finishedAt = new Date().toISOString();
  report.success = true;
  writeJson(runInfo.reportPath, report);

  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  const runLayout = buildRunLayout(args);

  const provision = ensureGatewayAgentProvisioned({
    openclawHome: args.openclawHome,
    openclawAgentsDir: args.openclawAgentsDir,
    agentId: args.agentId,
    workspaceDir: runLayout.workspaceDir,
    model: args.model
  });

  const preRunReset = resetPreRunAgentState({
    runRoot: runLayout.runRoot,
    agentsRoot: provision.agentsRoot,
    agentId: args.agentId
  });

  const runInfo = prepareRun(args, runLayout);

  const server = startServer(runInfo, args);

  const stopServer = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    stopServer();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopServer();
    process.exit(143);
  });

  try {
    console.log(`[real-e2e] Run ID: ${runInfo.runId}`);
    console.log(`[real-e2e] Agent: ${runInfo.agentId}`);
    console.log(`[real-e2e] Model: ${args.model}`);
    console.log(`[real-e2e] DEV dashboard: ${runInfo.baseUrl}`);
    console.log(`[real-e2e] Isolated HM data: ${runInfo.dataDir}`);
    console.log(`[real-e2e] Agent workspace: ${runInfo.workspaceDir}`);
    console.log(`[real-e2e] Gateway config updated: ${provision.changed ? 'yes' : 'no'} (${provision.configPath})`);
    console.log(
      `[real-e2e] Pre-run reset: runRootCleared=${preRunReset.runRootCleared ? 'yes' : 'no'}, ` +
        `sessionJsonlRemoved=${preRunReset.sessionJsonlRemoved} (${preRunReset.sessionDir})`
    );

    const report = await runScenario(runInfo, args);
    console.log(`[real-e2e] ✅ completed. Report: ${runInfo.reportPath}`);

    if (args.keepAlive) {
      console.log('[real-e2e] keep-alive enabled; dashboard stays up. Ctrl+C to stop.');
      await new Promise(() => {});
    }

    stopServer();
    process.exit(report.success ? 0 : 1);
  } catch (e) {
    const failedReport = {
      runId: runInfo.runId,
      agentId: runInfo.agentId,
      success: false,
      error: e.message,
      failedAt: new Date().toISOString()
    };
    writeJson(runInfo.reportPath, failedReport);
    console.error(`[real-e2e] ❌ failed: ${e.message}`);
    console.error(`[real-e2e] report: ${runInfo.reportPath}`);
    stopServer();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  buildAttemptsDistribution,
  collectSummarizationTelemetry,
  buildDialoguePrompt,
  resetPreRunAgentState
};
