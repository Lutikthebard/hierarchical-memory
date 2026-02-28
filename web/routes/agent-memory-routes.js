function registerAgentMemoryRoutes(app, ctx) {
  const {
    store,
    fs,
    path,
    scriptsDir,
    gatewayUrl,
    loadAgentsConfig,
    getAgentDataDir,
    ensureAgentDataDir,
    clearAgentMemoryData,
    runningWatchers,
    startWatcher,
    stopWatcher,
    sendCompactMessage,
    rebuildContextFile,
    injectCurrentContext,
    rollbackService,
    countJsonlLines,
    waitForCompaction,
    resolveActionSession
  } = ctx;

  function requireAgent(id, res) {
    const config = loadAgentsConfig();
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return null;
    }
    return agent;
  }

  app.post('/api/agents/:id/context/rebuild', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      ensureAgentDataDir(id);
      const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
      await rebuildContextFile({
        agentId: id,
        contextPath,
        scriptDir: scriptsDir
      });

      const content = await fs.readFile(contextPath, 'utf8');
      const sections = ctx.parseContextSections(content);
      res.json({
        success: true,
        contextPath,
        sections,
        generatedAt: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:id/context/inject', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    const shouldRebuild = req.body?.rebuild !== false;
    try {
      ensureAgentDataDir(id);
      const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
      if (shouldRebuild) {
        await rebuildContextFile({
          agentId: id,
          contextPath,
          scriptDir: scriptsDir
        });
      }

      const session = await resolveActionSession(id, agent.isSubagent || false);
      const injectResult = await injectCurrentContext({
        agentId: id,
        sessionKey: session.sessionKey,
        contextPath,
        reason: 'manual inject',
        gatewayUrl,
        requireEnabled: false
      });

      if (injectResult.skipped) {
        return res.status(400).json({ error: injectResult.reason });
      }

      res.json({
        success: true,
        rebuilt: shouldRebuild,
        contextPath,
        session,
        injectedAt: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:id/compact', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const session = await resolveActionSession(id, agent.isSubagent || false);
      const agentConfig = store.loadAgentConfig(id);
      const postCompactMessage = String(agentConfig.autoCompact?.postCompactMessage || '');
      await sendCompactMessage({
        agentId: id,
        sessionKey: session.sessionKey,
        postCompactMessage,
        gatewayUrl
      });
      res.json({
        success: true,
        session,
        postCompactMessage,
        compactSentAt: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:id/compact-with-inject', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    const timeoutMs = Math.max(3000, parseInt(String(req.body?.timeoutMs || '45000'), 10) || 45000);
    const pollMs = Math.max(500, parseInt(String(req.body?.pollMs || '1000'), 10) || 1000);
    try {
      ensureAgentDataDir(id);
      const session = await resolveActionSession(id, agent.isSubagent || false);
      const startLine = countJsonlLines(session.jsonlPath);
      const agentConfig = store.loadAgentConfig(id);
      const postCompactMessage = String(agentConfig.autoCompact?.postCompactMessage || '');

      await sendCompactMessage({
        agentId: id,
        sessionKey: session.sessionKey,
        postCompactMessage,
        gatewayUrl
      });

      const waitResult = await waitForCompaction(session.jsonlPath, startLine, timeoutMs, pollMs);
      if (!waitResult.detected && !waitResult.fallbackDelay) {
        return res.status(504).json({ error: `Compaction not detected within ${timeoutMs}ms` });
      }

      const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
      await rebuildContextFile({
        agentId: id,
        contextPath,
        scriptDir: scriptsDir
      });
      const injectResult = await injectCurrentContext({
        agentId: id,
        sessionKey: session.sessionKey,
        contextPath,
        reason: 'compaction',
        gatewayUrl,
        requireEnabled: false
      });

      if (injectResult.skipped) {
        return res.status(400).json({ error: injectResult.reason });
      }

      res.json({
        success: true,
        session,
        compactionDetected: waitResult.detected,
        fallbackDelay: waitResult.fallbackDelay,
        contextPath,
        completedAt: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:id/memory/clear', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const watcherWasRunning = runningWatchers.has(id);
      if (watcherWasRunning) {
        stopWatcher(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      const removed = clearAgentMemoryData(id);

      let watcherRestarted = false;
      if (watcherWasRunning) {
        const restartResult = startWatcher(id);
        watcherRestarted = restartResult.success === true;
        if (!watcherRestarted) {
          return res.status(500).json({
            error: `Memory cleared but failed to restart watcher: ${restartResult.message || 'unknown error'}`,
            watcherWasRunning,
            removed
          });
        }
      }

      res.json({
        success: true,
        agentId: id,
        watcherWasRunning,
        watcherRestarted,
        removed,
        clearedAt: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/agents/:id/memory/rollback/preview', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const cutoffTs = rollbackService.parseCutoff(req.body?.cutoffTs);
      const preview = rollbackService.previewRollback(id, cutoffTs);
      res.json({ success: true, preview });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('already in progress')) {
        return res.status(409).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  app.post('/api/agents/:id/memory/rollback', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const cutoffTs = rollbackService.parseCutoff(req.body?.cutoffTs);
      const watcherWasRunning = runningWatchers.has(id);
      if (watcherWasRunning) {
        stopWatcher(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      let result;
      try {
        result = rollbackService.applyRollback(id, cutoffTs);
        ensureAgentDataDir(id);
        const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
        await rebuildContextFile({
          agentId: id,
          contextPath,
          scriptDir: scriptsDir
        });
      } finally {
        if (watcherWasRunning) {
          const restartResult = startWatcher(id);
          if (!restartResult.success) {
            return res.status(500).json({
              error: `Rollback applied but watcher failed to restart: ${restartResult.message || 'unknown error'}`
            });
          }
        }
      }

      res.json({
        success: true,
        agentId: id,
        cutoffTs,
        backupId: result.backupId,
        result: result.result,
        removed: result.removed,
        watcherWasRunning,
        rolledBackAt: new Date().toISOString()
      });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('already in progress')) {
        return res.status(409).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  app.post('/api/agents/:id/memory/rollback/restore/:backupId', async (req, res) => {
    const { id, backupId } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const watcherWasRunning = runningWatchers.has(id);
      if (watcherWasRunning) {
        stopWatcher(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      let restore;
      try {
        restore = rollbackService.restoreRollback(id, backupId);
        ensureAgentDataDir(id);
        const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
        await rebuildContextFile({
          agentId: id,
          contextPath,
          scriptDir: scriptsDir
        });
      } finally {
        if (watcherWasRunning) {
          const restartResult = startWatcher(id);
          if (!restartResult.success) {
            return res.status(500).json({
              error: `Backup restored but watcher failed to restart: ${restartResult.message || 'unknown error'}`
            });
          }
        }
      }

      res.json({
        success: true,
        agentId: id,
        backupId: restore.backupId,
        watcherWasRunning,
        restoredAt: new Date().toISOString()
      });
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('already in progress')) {
        return res.status(409).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  app.get('/api/agents/:id/memory/rollback/backups', (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    try {
      const backups = rollbackService.listBackups(id);
      const history = rollbackService.readHistory(id, 100);
      res.json({ success: true, backups, history });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerAgentMemoryRoutes
};
