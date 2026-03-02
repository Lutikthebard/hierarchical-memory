const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Import store API
const store = require('../scripts/store');
const { OpenClawClient } = require('../scripts/gateway-client');
const { resolveActiveSession, createGatewaySessionLister } = require('../scripts/session-resolver');
const { countSessionMessagesFromJsonl } = require('../scripts/session-message-counter');
const { MESSAGE_CLASSES } = require('../scripts/message-classifier');
const {
  sendCompactMessage,
  rebuildContextFile,
  injectCurrentContext
} = require('../scripts/context-actions');
const rollbackService = require('../scripts/rollback-service');
const { createFullSummarizationService } = require('../scripts/full-summarization-service');
const { createLearnContextService } = require('../scripts/learn-context-service');
const {
  loadLastSessionBinding,
  saveLastSessionBinding
} = require('../scripts/shared/session-binding');
const {
  countJsonlLines,
  waitForCompaction
} = require('../scripts/shared/jsonl-compaction');
const { parseContextSections } = require('./services/context-sections');
const { validateAgentConfig } = require('./services/config-validation');
const { resolveActionSession: resolveActionSessionBase } = require('./services/action-session');
const { attachLogsWebsocket } = require('./services/logs-ws');
const { createWatcherMaintenance } = require('./services/watcher-maintenance');
const { registerAgentRoutes } = require('./routes/agent-routes');
const { registerArtifactRoutes } = require('./routes/artifact-routes');
const { registerLegacyRoutes } = require('./routes/legacy-routes');

const app = express();
const PORT = parseInt(process.env.PORT || '3458', 10);
const fullSummarizationService = createFullSummarizationService();
const learnContextService = createLearnContextService({
  runFullSummarization: fullSummarizationService.runFullSummarization
});

// Paths
const BASE_DIR = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');
const AGENTS_CONFIG_PATH = process.env.HM_AGENTS_CONFIG_PATH || path.join(BASE_DIR, 'agents.json');
const OPENCLAW_AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const listGatewaySessions = createGatewaySessionLister(() => new OpenClawClient(GATEWAY_URL));

// Process Manager - tracks running watchers
const runningWatchers = new Map(); // agentId -> { process, pid, startTime }

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// AGENTS CONFIG
// ============================================================

function loadAgentsConfig() {
  try {
    if (fsSync.existsSync(AGENTS_CONFIG_PATH)) {
      return JSON.parse(fsSync.readFileSync(AGENTS_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load agents config:', e.message);
  }
  return { agents: [] };
}

function saveAgentsConfig(config) {
  fsSync.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getAgentDataDir(agentId) {
  return path.join(store.getDataDir(), agentId);
}

function ensureAgentDataDir(agentId) {
  const dir = getAgentDataDir(agentId);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function clearAgentMemoryData(agentId) {
  ensureAgentDataDir(agentId);
  const agentDir = getAgentDataDir(agentId);
  const messagesDir = path.join(agentDir, 'messages');
  const contextPath = path.join(agentDir, 'CONTEXT.md');
  const artifactsPath = path.join(agentDir, 'artifacts.json');

  const existingStore = store.loadStore(agentId);
  const removed = {
    storeMessages: existingStore.messages?.length || 0,
    artifacts: Object.values(existingStore.artifacts || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    archivedFiles: 0,
    contextFileRemoved: false,
    artifactsFileRemoved: false
  };

  if (fsSync.existsSync(messagesDir)) {
    removed.archivedFiles = fsSync.readdirSync(messagesDir).filter((name) => name.endsWith('.jsonl')).length;
    fsSync.rmSync(messagesDir, { recursive: true, force: true });
  }

  if (fsSync.existsSync(contextPath)) {
    fsSync.rmSync(contextPath, { force: true });
    removed.contextFileRemoved = true;
  }

  if (fsSync.existsSync(artifactsPath)) {
    fsSync.rmSync(artifactsPath, { force: true });
    removed.artifactsFileRemoved = true;
  }

  store.saveStore(agentId, store.createEmptyStore());
  return removed;
}

// ============================================================
// PROCESS MANAGER
// ============================================================

function startWatcher(agentId) {
  if (runningWatchers.has(agentId)) {
    console.log(`[PM] Watcher for ${agentId} already running`);
    return { success: false, message: 'Already running' };
  }

  ensureAgentDataDir(agentId);
  const logPath = path.join(getAgentDataDir(agentId), 'watch.log');
  const logStream = fsSync.createWriteStream(logPath, { flags: 'a' });

  const proc = spawn('node', ['watch.js', agentId], {
    cwd: SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('exit', (code) => {
    console.log(`[PM] Watcher ${agentId} exited with code ${code}`);
    runningWatchers.delete(agentId);
    logStream.end();
  });

  proc.on('error', (err) => {
    console.error(`[PM] Watcher ${agentId} error:`, err.message);
    runningWatchers.delete(agentId);
    logStream.end();
  });

  runningWatchers.set(agentId, {
    process: proc,
    pid: proc.pid,
    startTime: Date.now()
  });

  console.log(`[PM] Started watcher for ${agentId} (PID: ${proc.pid})`);
  return { success: true, pid: proc.pid };
}

function stopWatcher(agentId) {
  const watcher = runningWatchers.get(agentId);
  if (!watcher) {
    return { success: false, message: 'Not running' };
  }

  try {
    process.kill(watcher.pid, 'SIGTERM');
    runningWatchers.delete(agentId);
    console.log(`[PM] Stopped watcher for ${agentId}`);
    return { success: true };
  } catch (err) {
    console.error(`[PM] Failed to stop ${agentId}:`, err.message);
    runningWatchers.delete(agentId);
    return { success: false, message: err.message };
  }
}

function getWatcherStatus(agentId) {
  const watcher = runningWatchers.get(agentId);
  if (!watcher) {
    return { running: false };
  }

  const uptimeMs = Date.now() - watcher.startTime;
  const minutes = Math.floor(uptimeMs / 60000);
  const seconds = Math.floor((uptimeMs % 60000) / 1000);
  
  return {
    running: true,
    pid: watcher.pid,
    uptime: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  };
}

// Start enabled watchers on server startup
function initializeWatchers() {
  const config = loadAgentsConfig();
  for (const agent of config.agents) {
    if (agent.enabled) {
      console.log(`[PM] Auto-starting watcher for ${agent.id}`);
      startWatcher(agent.id);
    }
  }
}

// ============================================================
// ============================================================
// API: AGENTS ROUTES
// ============================================================

const agentHandlers = registerAgentRoutes(app, {
  store,
  fs,
  fsSync,
  path,
  openclawAgentsDir: OPENCLAW_AGENTS_DIR,
  scriptsDir: SCRIPTS_DIR,
  gatewayUrl: GATEWAY_URL,
  loadAgentsConfig,
  saveAgentsConfig,
  getAgentDataDir,
  ensureAgentDataDir,
  clearAgentMemoryData,
  getWatcherStatus,
  startWatcher,
  stopWatcher,
  runningWatchers,
  resolveActiveSession,
  listGatewaySessions,
  countSessionMessagesFromJsonl,
  parseContextSections,
  validateAgentConfig,
  messageClasses: MESSAGE_CLASSES,
  sendCompactMessage,
  rebuildContextFile,
  injectCurrentContext,
  rollbackService,
  loadLastSessionBinding,
  saveLastSessionBinding,
  countJsonlLines,
  waitForCompaction,
  resolveActionSessionBase,
  watcherMaintenance: createWatcherMaintenance({
    runningWatchers,
    stopWatcher,
    startWatcher
  }),
  runFullSummarization: fullSummarizationService.runFullSummarization,
  runLearnContext: learnContextService.runLearnContext
});

registerArtifactRoutes(app, { store, handleArtifactDrilldown: agentHandlers.handleArtifactDrilldown });
registerLegacyRoutes(app, {
  handleAgentStatus: agentHandlers.handleAgentStatus,
  handleAgentStats: agentHandlers.handleAgentStats,
  handleAgentStore: agentHandlers.handleAgentStore,
  handleAgentContext: agentHandlers.handleAgentContext,
  handleAgentLogs: agentHandlers.handleAgentLogs,
  handleArtifactDrilldown: agentHandlers.handleArtifactDrilldown,
  startWatcher,
  stopWatcher
});

// ============================================================
// WEBSOCKET FOR LOGS
// ============================================================

const server = app.listen(PORT, () => {
  console.log(`\n🧠 Hierarchical Memory Server`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/agents\n`);
  console.log(`   Data dir: ${store.getDataDir()}`);
  console.log(`   Agents config: ${AGENTS_CONFIG_PATH}`);
  console.log(`   OpenClaw agents dir: ${OPENCLAW_AGENTS_DIR}\n`);
  
  // Initialize watchers for enabled agents
  initializeWatchers();
});

attachLogsWebsocket({
  server,
  WebSocketServer,
  loadAgentsConfig,
  getAgentDataDir,
  fsSync,
  logger: console
});

// Cleanup on exit
process.on('SIGTERM', () => {
  console.log('\n[PM] Shutting down...');
  for (const [agentId] of runningWatchers) {
    stopWatcher(agentId);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[PM] Shutting down...');
  for (const [agentId] of runningWatchers) {
    stopWatcher(agentId);
  }
  process.exit(0);
});
