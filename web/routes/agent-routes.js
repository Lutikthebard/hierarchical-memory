const { registerAgentManagementRoutes } = require('./agent-management-routes');
const { registerAgentSessionRoutes } = require('./agent-session-routes');
const { registerAgentConfigRoutes } = require('./agent-config-routes');
const { registerAgentMemoryRoutes } = require('./agent-memory-routes');
const {
  buildArtifactsByLevel,
  buildArtifactCounts,
  clampArtifactsToParentRange
} = require('../services/artifact-levels');

function registerAgentRoutes(app, deps) {
  const {
    store,
    fs,
    path,
    openclawAgentsDir,
    scriptsDir,
    gatewayUrl,
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
    messageClasses,
    sendCompactMessage,
    rebuildContextFile,
    injectCurrentContext,
    rollbackService,
    loadLastSessionBinding,
    saveLastSessionBinding,
    countJsonlLines,
    waitForCompaction,
    resolveActionSessionBase,
    fsSync,
    watcherMaintenance,
    runFullSummarization,
    runLearnContext
  } = deps;

  async function getSessionMessageCount(agentId) {
    try {
      const config = loadAgentsConfig();
      const agent = config.agents.find((a) => a.id === agentId);
      const isSubagentMode = agent?.isSubagent || false;
      const listSessions = isSubagentMode ? listGatewaySessions : null;

      const sessionInfo = await resolveActiveSession({
        agentId,
        isSubagent: isSubagentMode,
        openclawAgentsDir,
        listSessions,
        logger: (msg) => console.log(`[session-resolver] ${agentId}: ${msg}`)
      });
      console.log(
        `[session-count] agent=${agentId} source=${sessionInfo?.source || 'none'} sessionId=${sessionInfo?.sessionId || 'N/A'}`
      );
      const jsonlPath = sessionInfo?.jsonlPath;
      const agentConfig = store.loadAgentConfig(agentId);
      return countSessionMessagesFromJsonl(jsonlPath, agentConfig);
    } catch (e) {
      console.error('Error counting session messages:', e.message);
      return 0;
    }
  }

  function handleAgentStatus(res, agentId, options = {}) {
    const status = getWatcherStatus(agentId);
    const payload = { agentId, ...status };
    if (options.includeLegacySession) {
      payload.sessionId = null;
    }
    res.json(payload);
  }

  async function handleAgentStats(res, agentId, options = {}) {
    const legacy = options.legacy === true;
    const s = store.loadStore(agentId);
    const agentConfig = store.loadAgentConfig(agentId);
    const threshold = agentConfig.thresholds?.L1 || 60;

    const unsummarizedItems = store.getUnsummarized(s, 0, agentId);
    const countable = store.filterForCounting(unsummarizedItems, agentConfig);
    const unsummarized = legacy ? (s.messages?.length || 0) : countable.length;

    const payload = {
      messagesCount: s.messages?.length || 0,
      artifacts: buildArtifactCounts(s.artifacts),
      threshold,
      unsummarized,
      progress: Math.min(1, unsummarized / threshold)
    };

    if (!legacy) {
      const sessionMessageCount = await getSessionMessageCount(agentId);
      const compactThreshold = agentConfig.autoCompact?.messageThreshold || 150;
      payload.sessionMessageCount = sessionMessageCount;
      payload.compactThreshold = compactThreshold;
      payload.compactProgress = Math.min(1, sessionMessageCount / compactThreshold);
    }

    res.json(payload);
  }

  function handleAgentStore(res, agentId) {
    const s = store.loadStore(agentId);
    const recentMessages = (s.messages || []).slice(-20);

    res.json({
      artifacts: buildArtifactsByLevel(s.artifacts),
      recentMessages
    });
  }

  async function handleAgentContext(res, agentId) {
    const contextPath = path.join(getAgentDataDir(agentId), 'CONTEXT.md');
    try {
      const content = await fs.readFile(contextPath, 'utf8');
      const sections = parseContextSections(content);
      res.json({ content, sections });
    } catch (_e) {
      res.json({ content: '', sections: [] });
    }
  }

  async function handleAgentLogs(req, res, agentId) {
    const logPath = path.join(getAgentDataDir(agentId), 'watch.log');
    const lines = parseInt(req.query.lines) || 50;
    try {
      const content = await fs.readFile(logPath, 'utf8');
      const allLines = content.split('\n');
      res.json({ logs: allLines.slice(-lines) });
    } catch (_e) {
      res.json({ logs: [] });
    }
  }

  async function resolveActionSession(agentId, isSubagentMode) {
    return resolveActionSessionBase({
      agentId,
      isSubagentMode,
      openclawAgentsDir,
      listGatewaySessions,
      resolveActiveSession,
      loadLastSessionBinding,
      saveLastSessionBinding,
      dataDir: store.getDataDir(),
      logger: console.log
    });
  }

  function handleArtifactDrilldown(res, agentId, level, index) {
    const levelNum = parseInt(level);
    const indexNum = parseInt(index);

    const s = store.loadStore(agentId);
    const levelArtifacts = s.artifacts?.[String(levelNum)] || [];

    if (indexNum < 0 || indexNum >= levelArtifacts.length) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    const artifact = levelArtifacts[indexNum];
    if (levelNum === 1) {
      const messages = store.getArchivedMessages(agentId, artifact.startTimestamp, artifact.endTimestamp);
      return res.json({ artifact, messages, source: 'archive' });
    }

    const sourceLevel = levelNum - 1;
    const sourceLevelArtifacts = (s.artifacts?.[String(sourceLevel)] || s.artifacts?.[sourceLevel] || []);
    const sourceArtifacts = clampArtifactsToParentRange(sourceLevelArtifacts, artifact)
      .map((item) => ({ ...item, level: Number(item.level || sourceLevel) }));
    return res.json({ artifact, sourceArtifacts, source: `L${sourceLevel}` });
  }

  const routeCtx = {
    ...deps,
    fsSync,
    store,
    path,
    fs,
    openclawAgentsDir,
    scriptsDir,
    gatewayUrl,
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
    parseContextSections,
    validateAgentConfig,
    messageClasses,
    sendCompactMessage,
    rebuildContextFile,
    injectCurrentContext,
    rollbackService,
    loadLastSessionBinding,
    saveLastSessionBinding,
    countJsonlLines,
    waitForCompaction,
    watcherMaintenance,
    runFullSummarization,
    runLearnContext,
    resolveActionSession,
    handleAgentStats,
    handleAgentStore,
    handleAgentContext,
    handleAgentLogs
  };

  registerAgentManagementRoutes(app, routeCtx);
  registerAgentSessionRoutes(app, routeCtx);
  registerAgentConfigRoutes(app, routeCtx);
  registerAgentMemoryRoutes(app, routeCtx);

  return {
    handleAgentStatus,
    handleAgentStats,
    handleAgentStore,
    handleAgentContext,
    handleAgentLogs,
    handleArtifactDrilldown
  };
}

module.exports = {
  registerAgentRoutes
};
