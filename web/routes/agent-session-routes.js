function registerAgentSessionRoutes(app, ctx) {
  const {
    fsSync,
    store,
    path,
    openclawAgentsDir,
    loadAgentsConfig,
    loadLastSessionBinding,
    resolveActiveSession,
    listGatewaySessions,
    saveLastSessionBinding,
    runningWatchers,
    startWatcher,
    stopWatcher
  } = ctx;

  app.post('/api/agents/:id/session/sync', async (req, res) => {
    const { id } = req.params;
    const config = loadAgentsConfig();
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    try {
      const sessionInfo = await resolveActiveSession({
        agentId: id,
        isSubagent: agent.isSubagent || false,
        openclawAgentsDir,
        listSessions: listGatewaySessions,
        logger: (msg) => console.log(`[session-sync] ${id}: ${msg}`)
      });

      if (!sessionInfo || sessionInfo.source !== 'gateway') {
        console.warn(`[session-sync] agent=${id} source=${sessionInfo?.source || 'none'} result=rejected`);
        return res.status(502).json({ error: 'Failed to resolve active session from gateway' });
      }
      if (!sessionInfo.sessionId || !sessionInfo.jsonlPath) {
        return res.status(500).json({ error: 'Resolved session is incomplete' });
      }

      const prevBinding = loadLastSessionBinding(id, store.getDataDir()) || {};
      const binding = saveLastSessionBinding(id, store.getDataDir(), sessionInfo);
      console.log(
        `[session-sync] agent=${id} source=${sessionInfo.source} sessionId=${sessionInfo.sessionId} sessionKey=${sessionInfo.sessionKey || 'N/A'}`
      );
      const sessionChanged = Boolean(
        prevBinding.sessionId !== (sessionInfo.sessionId || null) ||
        prevBinding.sessionKey !== (sessionInfo.sessionKey || null) ||
        prevBinding.jsonlPath !== (sessionInfo.jsonlPath || null)
      );

      let touchedJsonl = false;
      if (fsSync.existsSync(sessionInfo.jsonlPath)) {
        const now = new Date();
        try {
          fsSync.utimesSync(sessionInfo.jsonlPath, now, now);
          touchedJsonl = true;
        } catch (_e) {}
      }

      let watcherRestarted = false;
      const wasRunning = runningWatchers.has(id);
      if (wasRunning && sessionChanged) {
        stopWatcher(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const restartResult = startWatcher(id);
        watcherRestarted = restartResult.success === true;
        if (!watcherRestarted) {
          return res.status(500).json({ error: `Session pinned but watcher restart failed: ${restartResult.message || 'unknown error'}` });
        }
      }

      res.json({
        success: true,
        session: {
          sessionId: sessionInfo.sessionId,
          sessionKey: sessionInfo.sessionKey || null,
          jsonlPath: sessionInfo.jsonlPath
        },
        source: sessionInfo.source,
        binding,
        sessionChanged,
        watcherRestarted,
        touchedJsonl
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/session/active', async (req, res) => {
    const { id } = req.params;
    const config = loadAgentsConfig();
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    try {
      const sessionInfo = await resolveActiveSession({
        agentId: id,
        isSubagent: agent.isSubagent || false,
        openclawAgentsDir,
        listSessions: listGatewaySessions,
        logger: (msg) => console.log(`[session-active] ${id}: ${msg}`)
      });
      console.log(
        `[session-active] agent=${id} source=${sessionInfo?.source || 'none'} sessionId=${sessionInfo?.sessionId || 'N/A'} sessionKey=${sessionInfo?.sessionKey || 'N/A'}`
      );

      res.json({
        agentId: id,
        sessionId: sessionInfo?.sessionId || null,
        sessionKey: sessionInfo?.sessionKey || null,
        jsonlPath: sessionInfo?.jsonlPath || null,
        source: sessionInfo?.source || null
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerAgentSessionRoutes
};
