#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { OpenClawClient } = require('../gateway-client');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const E2E_ROOT = path.join(ROOT_DIR, 'tmp', 'real-e2e-learn-export');

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

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseArgs(argv) {
  const args = {
    agentId: 'hm-real-e2e-learn-export-agent',
    port: 3476,
    keepAlive: false,
    timeoutSec: 240,
    model: 'openai-codex/gpt-5.1-codex-mini',
    gatewayUrl: process.env.GATEWAY_URL || 'ws://127.0.0.1:18789',
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    openclawAgentsDir: process.env.OPENCLAW_AGENTS_DIR || '',
    openclawHome: process.env.OPENCLAW_HOME || path.join(process.env.HOME || '', '.openclaw'),
    gatewayToken: process.env.GATEWAY_TOKEN || '',
    gatewayPassword: process.env.GATEWAY_PASSWORD || '',
    sourceDocPath: 'README.md',
    wordsPerBlock: 180,
    fromBlock: 1,
    toBlock: 3,
    maxTargetLevel: 3,
    aggregateBatch: 2,
    exportFromLevel: 1,
    exportToLevel: 3
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
    if (key === '--source-doc' && next) {
      args.sourceDocPath = next;
      i++;
      continue;
    }
    if (key === '--words-per-block' && next) {
      args.wordsPerBlock = toPositiveInt(next, args.wordsPerBlock);
      i++;
      continue;
    }
    if (key === '--from-block' && next) {
      args.fromBlock = toPositiveInt(next, args.fromBlock);
      i++;
      continue;
    }
    if (key === '--to-block' && next) {
      args.toBlock = toPositiveInt(next, args.toBlock);
      i++;
      continue;
    }
    if (key === '--max-target-level' && next) {
      args.maxTargetLevel = toPositiveInt(next, args.maxTargetLevel);
      i++;
      continue;
    }
    if (key === '--aggregate-batch' && next) {
      args.aggregateBatch = toPositiveInt(next, args.aggregateBatch);
      i++;
      continue;
    }
    if (key === '--export-from-level' && next) {
      args.exportFromLevel = toPositiveInt(next, args.exportFromLevel);
      i++;
      continue;
    }
    if (key === '--export-to-level' && next) {
      args.exportToLevel = toPositiveInt(next, args.exportToLevel);
      i++;
      continue;
    }
    if (key === '--keep-alive') {
      args.keepAlive = true;
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
    thresholds: { L1: 60, default: 2 },
    prompts: {
      l1: 'Summarize into max 6 short bullets with durable facts and decisions.',
      aggregate: 'Compress L{level} memory artifacts into concise durable knowledge.'
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
      enabled: false,
      messageThreshold: 1000,
      postCompactMessage: '',
      retries: 2,
      retryDelayMs: 1500
    },
    learnContext: {
      wordsPerBlock: args.wordsPerBlock,
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      learningIntent: 'Learn project architecture and operation constraints.',
      l1ArtifactPrompt: 'Capture facts, invariants, APIs and key workflows.',
      aggregatePrompt: '',
      aggregatePromptsByLevel: {},
      runFullSummarize: true,
      maxTargetLevel: args.maxTargetLevel,
      aggregateBatch: args.aggregateBatch,
      thresholds: {
        L2: 2,
        L3: 2,
        default: 2
      }
    }
  });

  const sourcePath = path.resolve(ROOT_DIR, args.sourceDocPath);
  const sourceText = fs.existsSync(sourcePath)
    ? fs.readFileSync(sourcePath, 'utf8')
    : '# Missing source document';
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), sourceText, 'utf8');

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
    sourceDocPath: sourcePath,
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
    console.log(`[real-e2e-learn-export] server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });

  return server;
}

function resolveSourceDocContent(runInfo, args) {
  const sourcePath = path.resolve(ROOT_DIR, args.sourceDocPath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source document not found: ${sourcePath}`);
  }
  const text = fs.readFileSync(sourcePath, 'utf8');
  if (!text.trim()) {
    throw new Error(`Source document is empty: ${sourcePath}`);
  }
  return { sourcePath, text };
}

async function runScenario(runInfo, args) {
  const baseUrl = runInfo.baseUrl;
  const agentId = runInfo.agentId;
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
        'Preflight check for real-e2e learn-export. Reply with one word: READY.',
        Math.min(90, args.timeoutSec)
      );
      return { responsePreview: String(response || '').slice(0, 120) };
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
        'Session bootstrap for real-e2e learn-export. Reply with: BOOTSTRAP_OK.',
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

  const sourceDoc = await step('load-source-document', async () => {
    const source = resolveSourceDocContent(runInfo, args);
    return {
      sourcePath: source.sourcePath,
      bytes: Buffer.byteLength(source.text, 'utf8')
    };
  });

  const learnResult = await step('learn-context', async () => {
    const source = resolveSourceDocContent(runInfo, args);
    const payload = await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/memory/learn-context`, {
      text: source.text,
      wordsPerBlock: args.wordsPerBlock,
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      learningIntent: 'Learn project architecture and important workflows from README.',
      l1ArtifactPrompt: 'Focus on durable technical facts and constraints.',
      runFullSummarize: true,
      maxTargetLevel: args.maxTargetLevel,
      aggregateBatch: args.aggregateBatch,
      thresholds: {
        L2: 2,
        L3: 2,
        default: 2
      }
    });

    const created = Number(payload?.run?.l1?.created || 0);
    if (created < 1) {
      throw new Error(`Learn Context created no L1 artifacts (created=${created})`);
    }
    return {
      blocks: payload?.run?.blocks || null,
      l1: payload?.run?.l1 || null,
      fullSummarizePasses: Array.isArray(payload?.run?.fullSummarize?.run?.passes)
        ? payload.run.fullSummarize.run.passes.length
        : 0
    };
  });

  await step('verify-artifact-levels-after-learn', async () => {
    const stats = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
    const l1 = Number(stats?.artifacts?.L1 || 0);
    const l2 = Number(stats?.artifacts?.L2 || 0);
    if (l1 < 1) {
      throw new Error(`Expected L1 artifacts after learn-context, got ${l1}`);
    }
    if (l2 < 1) {
      throw new Error(`Expected L2 artifacts after full summarize, got ${l2}`);
    }
    return { L1: l1, L2: l2, L3: Number(stats?.artifacts?.L3 || 0) };
  });

  const exportResult = await step('export-context', async () => {
    const exportFileName = `learn-export-${runInfo.runId}.md`;
    const payload = await apiJson(baseUrl, 'POST', `/api/agents/${agentId}/memory/export-context`, {
      fromLevel: args.exportFromLevel,
      toLevel: args.exportToLevel,
      includeArchivedMessages: true,
      outputFileName: exportFileName
    });

    const exportPath = payload?.run?.file?.path || '';
    if (!exportPath) {
      throw new Error('Export endpoint returned empty file path');
    }
    if (!fs.existsSync(exportPath)) {
      throw new Error(`Export file not found on disk: ${exportPath}`);
    }

    const roots = payload?.run?.tree?.roots || [];
    if (!Array.isArray(roots) || roots.length < 1) {
      throw new Error('Export tree has no roots');
    }

    return {
      filePath: exportPath,
      fileName: payload?.run?.file?.name || null,
      bytes: payload?.run?.file?.bytes || null,
      rootArtifacts: payload?.run?.stats?.rootArtifacts || 0,
      totalNodes: payload?.run?.stats?.totalNodes || 0
    };
  });

  await step('verify-export-markdown', async () => {
    const filePath = exportResult.filePath;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('# Learned Context Export')) {
      throw new Error('Export markdown missing header');
    }
    if (!content.includes(`Agent: \`${agentId}\``)) {
      throw new Error('Export markdown missing agent marker');
    }
    if (!/L\d artifact/.test(content)) {
      throw new Error('Export markdown missing artifact drill-down lines');
    }
    return {
      filePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      containsL3: content.includes('L3 artifact'),
      sourceBytes: sourceDoc.bytes
    };
  });

  await step('final-stats', async () => {
    const stats = await apiJson(baseUrl, 'GET', `/api/agents/${agentId}/stats`);
    return {
      artifacts: stats.artifacts,
      messagesCount: stats.messagesCount,
      sessionMessageCount: stats.sessionMessageCount,
      unsummarized: stats.unsummarized
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
    console.log(`[real-e2e-learn-export] Run ID: ${runInfo.runId}`);
    console.log(`[real-e2e-learn-export] Agent: ${runInfo.agentId}`);
    console.log(`[real-e2e-learn-export] Model: ${args.model}`);
    console.log(`[real-e2e-learn-export] DEV dashboard: ${runInfo.baseUrl}`);
    console.log(`[real-e2e-learn-export] Isolated HM data: ${runInfo.dataDir}`);
    console.log(`[real-e2e-learn-export] Agent workspace: ${runInfo.workspaceDir}`);
    console.log(
      `[real-e2e-learn-export] Gateway config updated: ${provision.changed ? 'yes' : 'no'} (${provision.configPath})`
    );
    console.log(
      `[real-e2e-learn-export] Pre-run reset: runRootCleared=${preRunReset.runRootCleared ? 'yes' : 'no'}, ` +
        `sessionJsonlRemoved=${preRunReset.sessionJsonlRemoved} (${preRunReset.sessionDir})`
    );

    const report = await runScenario(runInfo, args);
    console.log(`[real-e2e-learn-export] ✅ completed. Report: ${runInfo.reportPath}`);

    if (args.keepAlive) {
      console.log('[real-e2e-learn-export] keep-alive enabled; dashboard stays up. Ctrl+C to stop.');
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
    console.error(`[real-e2e-learn-export] ❌ failed: ${e.message}`);
    console.error(`[real-e2e-learn-export] report: ${runInfo.reportPath}`);
    stopServer();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  resetPreRunAgentState
};
