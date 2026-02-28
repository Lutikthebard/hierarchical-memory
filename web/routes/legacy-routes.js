function registerLegacyRoutes(app, deps) {
  const {
    handleAgentStatus,
    handleAgentStats,
    handleAgentStore,
    handleAgentContext,
    handleAgentLogs,
    handleArtifactDrilldown,
    startWatcher,
    stopWatcher
  } = deps;

  app.get('/api/status', (req, res) => {
    handleAgentStatus(res, 'main', { includeLegacySession: true });
  });

  app.get('/api/stats', async (req, res) => {
    try {
      await handleAgentStats(res, 'main', { legacy: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/store', (req, res) => {
    try {
      handleAgentStore(res, 'main');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/context', async (req, res) => {
    try {
      await handleAgentContext(res, 'main');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/logs', async (req, res) => {
    try {
      await handleAgentLogs(req, res, 'main');
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/artifact/:level/:index/messages', (req, res) => {
    try {
      const { level, index } = req.params;
      handleArtifactDrilldown(res, 'main', level, index);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/control', async (req, res) => {
    const { action } = req.body;

    if (action === 'start') {
      const result = startWatcher('main');
      res.json(result);
    } else if (action === 'stop') {
      const result = stopWatcher('main');
      res.json(result);
    } else if (action === 'restart') {
      stopWatcher('main');
      await new Promise((r) => setTimeout(r, 1000));
      const result = startWatcher('main');
      res.json(result);
    } else {
      res.status(400).json({ error: 'Invalid action' });
    }
  });
}

module.exports = {
  registerLegacyRoutes
};
