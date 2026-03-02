#!/usr/bin/env node
/**
 * Watch JSONL session file and track messages into hierarchical memory store
 * 
 * Usage: node watch.js <agentId> <sessionId> [jsonlPath]
 * 
 * - Reads existing JSONL file on startup
 * - Uses tail -F to watch for new messages
 * - Filters: type === "message" && (role === "user" || role === "assistant")
 * - Adds messages to store via addMessage()
 * - Checks threshold after each addition
 * - Calls onThresholdReached when threshold is met
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  loadStore,
  saveStore,
  updateStore,
  addMessage,
  checkThreshold,
  getThresholdForLevel,
  loadConfig,
  loadAgentConfig,
  formatTimestamp,
  getDataDir
} = require('./store');
const { execSync } = require('child_process');
const { OpenClawClient } = require('./gateway-client');
const { parseMessage, extractContent } = require('./message-parser');
const { CompactController } = require('./compact-controller');
const { createSummarizationOrchestrator } = require('./summarization-orchestrator');
const {
  resolveInjectMdPath,
  buildInjectedContextMessage,
  sendCompactMessage: sendCompactMessageBase,
  injectCurrentContext
} = require('./context-actions');
const { resolveActiveSession, createGatewaySessionLister } = require('./session-resolver');
const { getAgentKind, getWatchSessionDirs, getLookupSessionDirs } = require('./session-policy');
const { countSessionMessagesFromJsonl } = require('./session-message-counter');
const {
  loadLastSessionBinding,
  saveLastSessionBinding
} = require('./shared/session-binding');
const { createProcessExistingFile } = require('./watch-runtime/jsonl-bootstrap');
const { createSessionPathHelpers } = require('./watch-runtime/session-paths');
const { createSessionRuntime } = require('./watch-runtime/session-runtime');
const { createIngestRuntime } = require('./watch-runtime/ingest-runtime');
const { createLockRuntime } = require('./watch-runtime/lock-runtime');
const { createContextRuntime } = require('./watch-runtime/context-runtime');
const { createMainRunner } = require('./watch-runtime/main-runner');
const { createThresholdRuntime } = require('./watch-runtime/threshold-runtime');
const { createArtifactStreamRuntime } = require('./watch-runtime/artifact-stream-runtime');
const { createStreamLLMAdapter } = require('./watch-runtime/stream-llm-adapter');
const triggerApi = require('./trigger-ws');

// Default paths
const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const AGENTS_CONFIG_PATH = process.env.HM_AGENTS_CONFIG_PATH || path.join(__dirname, '..', 'agents.json');

const compactController = new CompactController();
const artifactStreamRuntime = createArtifactStreamRuntime({ logger: console });

const triggerTimeoutSeconds = parseInt(process.env.TRIGGER_TIMEOUT_SEC, 10) || 600;
const artifactWaitMs = parseInt(process.env.TRIGGER_ARTIFACT_WAIT_MS, 10) || 60000;
const llmMode = (process.env.HM_LLM_MODE || 'openclaw').toLowerCase();
const useWatchStreamAdapter = llmMode !== 'mock';

if (useWatchStreamAdapter) {
  const streamingAdapter = createStreamLLMAdapter({
    gatewayUrl: GATEWAY_URL,
    gatewayToken: process.env.GATEWAY_TOKEN || '',
    timeoutSeconds: triggerTimeoutSeconds,
    artifactWaitMs,
    waitForArtifact: artifactStreamRuntime.waitForArtifact,
    logger: console
  });
  triggerApi.setAdapter(streamingAdapter, 'watch-stream');
}

const {
  loadAgentsConfigFile,
  isSubagent,
  getSessionsDir,
  getSessionDirsForAgent,
  findSessionPathInDirs
} = createSessionPathHelpers({
  fs,
  path,
  agentsConfigPath: AGENTS_CONFIG_PATH,
  openclawDir: OPENCLAW_DIR,
  getAgentKind,
  getWatchSessionDirs
});

function requireSessionKey(agentId) {
  if (runtimeState.currentSessionKey) return runtimeState.currentSessionKey;
  if (isSubagent(agentId)) {
    throw new Error(`No session key resolved for subagent ${agentId}`);
  }
  return `agent:${agentId}:main`;
}

function isSessionKeyForAgent(agentId, sessionKey) {
  if (!sessionKey) return false;
  return sessionKey === `agent:${agentId}` || sessionKey === `agent:${agentId}:main`;
}

// Current runtime state for hot-swap/session rebinding
const runtimeState = {
  currentTailProcess: null,
  currentSessionId: null,
  currentSessionKey: null,
  currentStoreRef: null,
  currentJsonlPath: null,
  agentLockPath: null
};
const listGatewaySessions = createGatewaySessionLister(() => new OpenClawClient(GATEWAY_URL));
const {
  acquireAgentLock,
  releaseAgentLock,
  saveLastSessionId,
  loadLastSessionId,
  getContextPath
} = createLockRuntime({
  fs,
  path,
  getDataDir,
  loadLastSessionBinding,
  saveLastSessionBinding,
  state: runtimeState
});

const { onThresholdReached } = createSummarizationOrchestrator({
  scriptDir: __dirname,
  triggerApi,
  resolveSessionKey: requireSessionKey,
  loadStore,
  saveStore,
  updateStore,
  loadAgentConfig,
  archiveMessages: require('./store').archiveMessages,
  removeSummarizedMessages: require('./store').removeSummarizedMessages,
  getLastSummarizedTimestamp: require('./store').getLastSummarizedTimestamp,
  checkThreshold,
  getThresholdForLevel,
  formatTimestamp,
  getContextPath
});

const { drainThresholdSummarization } = createThresholdRuntime({
  checkThreshold,
  onThresholdReached,
  logger: console
});

const {
  scheduleContextRegenerate,
  scheduleContextInject
} = createContextRuntime({
  getContextPath,
  loadAgentConfig,
  injectCurrentContext,
  gatewayUrl: GATEWAY_URL,
  requireSessionKey,
  execSync,
  scriptDir: __dirname,
  logger: console
});

const {
  processLine,
  forceSyncSessionToStore,
  sendCompactMessage,
  refreshSessionCounterFromJsonl,
  watchFile
} = createIngestRuntime({
  state: runtimeState,
  fs,
  spawn,
  processRef: process,
  loadAgentConfig,
  parseMessage,
  addMessage,
  formatTimestamp,
  loadStore,
  saveStore,
  updateStore,
  scheduleContextRegenerate,
  compactController,
  checkThreshold,
  getThresholdForLevel,
  drainThresholdSummarization,
  sendCompactMessageBase,
  gatewayUrl: GATEWAY_URL,
  requireSessionKey,
  countSessionMessagesFromJsonl,
  scheduleContextInject,
  onRawLine: ({ agentId, line, sessionKey }) => artifactStreamRuntime.observeLine({ agentId, line, sessionKey }),
  logger: console
});

const processExistingFile = createProcessExistingFile({
  fs,
  compactController,
  processLine,
  saveStore
});

const {
  getActiveSession,
  getActiveSessionInfo,
  switchToSession,
  watchSessionDirectory
} = createSessionRuntime({
  state: runtimeState,
  fs,
  path,
  openclawDir: OPENCLAW_DIR,
  listGatewaySessions,
  isSubagent,
  isSessionKeyForAgent,
  getSessionDirsForAgent,
  findSessionPathInDirs,
  getSessionsDir,
  getLookupSessionDirs,
  getAgentKind,
  resolveActiveSession,
  loadLastSessionBinding,
  saveLastSessionBinding,
  getDataDir,
  loadStore,
  loadAgentConfig,
  processExistingFile,
  refreshSessionCounterFromJsonl,
  getContextPath,
  execSync,
  scheduleContextInject,
  watchFile,
  logger: console
});

const main = createMainRunner({
  processRef: process,
  acquireAgentLock,
  isSubagent,
  getActiveSessionInfo,
  loadLastSessionId,
  saveLastSessionId,
  runtimeState,
  getSessionsDir,
  path,
  saveLastSessionBinding,
  getDataDir,
  loadConfig,
  loadStore,
  loadAgentConfig,
  processExistingFile,
  refreshSessionCounterFromJsonl,
  getContextPath,
  execSync,
  scheduleContextInject,
  watchFile,
  checkThreshold,
  getThresholdForLevel,
  onThresholdReached,
  compactController,
  sendCompactMessage,
  drainThresholdSummarization,
  watchSessionDirectory,
  logger: console
});

// Export for testing
module.exports = {
  parseMessage,
  extractContent,
  processLine,
  onThresholdReached,
  getActiveSessionInfo,
  resolveInjectMdPath,
  buildInjectedContextMessage,
  acquireAgentLock,
  releaseAgentLock
};

// Run if called directly
if (require.main === module) {
  const closeRuntimeResources = () => {
    artifactStreamRuntime.closeAll();
    triggerApi.closeAdapter().catch(() => {});
  };

  process.on('exit', () => {
    closeRuntimeResources();
    releaseAgentLock();
  });
  process.on('SIGTERM', () => {
    closeRuntimeResources();
    releaseAgentLock();
    process.exit(0);
  });
  main().catch((e) => {
    closeRuntimeResources();
    releaseAgentLock();
    console.error(e);
    process.exit(1);
  });
}
