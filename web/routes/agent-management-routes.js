const { buildArtifactCounts } = require('../services/artifact-levels');

function registerAgentManagementRoutes(app, ctx) {
  const {
    store,
    fsSync,
    openclawAgentsDir,
    loadAgentsConfig,
    saveAgentsConfig,
    ensureAgentDataDir,
    getWatcherStatus,
    startWatcher,
    stopWatcher,
    handleAgentStats,
    handleAgentStore,
    handleAgentContext,
    handleAgentLogs
  } = ctx;

  app.get('/api/agents/available', (req, res) => {
    try {
      if (!fsSync.existsSync(openclawAgentsDir)) {
        return res.json({ agents: [] });
      }

      const dirs = fsSync.readdirSync(openclawAgentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      res.json({ agents: dirs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents', (req, res) => {
    const config = loadAgentsConfig();
    const agents = config.agents.map((agent) => {
      const status = getWatcherStatus(agent.id);

      let stats = { messages: 0, artifacts: {} };
      try {
        const s = store.loadStore(agent.id);
        stats.messages = s.messages?.length || 0;
        stats.artifacts = buildArtifactCounts(s.artifacts);
      } catch (_e) {}

      return {
        ...agent,
        ...status,
        stats
      };
    });

    res.json({ agents });
  });

  app.post('/api/agents', (req, res) => {
    const { id, name, isSubagent } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Agent id required' });
    }

    const config = loadAgentsConfig();
    if (config.agents.find((a) => a.id === id)) {
      return res.status(400).json({ error: 'Agent already exists' });
    }

    const newAgent = {
      id,
      name: name || id,
      enabled: false,
      isSubagent: isSubagent || false
    };

    config.agents.push(newAgent);
    saveAgentsConfig(config);
    ensureAgentDataDir(id);

    res.json({ success: true, agent: newAgent });
  });

  app.delete('/api/agents/:id', (req, res) => {
    const { id } = req.params;
    stopWatcher(id);

    const config = loadAgentsConfig();
    config.agents = config.agents.filter((a) => a.id !== id);
    saveAgentsConfig(config);

    res.json({ success: true });
  });

  app.post('/api/agents/:id/enable', (req, res) => {
    const { id } = req.params;

    const config = loadAgentsConfig();
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    agent.enabled = true;
    saveAgentsConfig(config);

    const result = startWatcher(id);
    res.json({ success: true, ...result });
  });

  app.post('/api/agents/:id/disable', (req, res) => {
    const { id } = req.params;

    const config = loadAgentsConfig();
    const agent = config.agents.find((a) => a.id === id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    agent.enabled = false;
    saveAgentsConfig(config);

    const result = stopWatcher(id);
    res.json({ success: true, ...result });
  });

  app.get('/api/agents/:id/status', (req, res) => {
    const { id } = req.params;
    const status = getWatcherStatus(id);
    res.json({ agentId: id, ...status });
  });

  app.get('/api/agents/:id/stats', async (req, res) => {
    const { id } = req.params;
    try {
      await handleAgentStats(res, id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/store', (req, res) => {
    const { id } = req.params;
    try {
      handleAgentStore(res, id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/context', async (req, res) => {
    const { id } = req.params;
    try {
      await handleAgentContext(res, id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/logs', async (req, res) => {
    const { id } = req.params;
    try {
      await handleAgentLogs(req, res, id);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/messages/:date', (req, res) => {
    const { id, date } = req.params;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    try {
      const startTimestamp = `${date}T00:00:00.000Z`;
      const endTimestamp = `${date}T23:59:59.999Z`;
      const messages = store.getArchivedMessages(id, startTimestamp, endTimestamp);

      res.json({ date, messages, count: messages.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/messages-dates', (req, res) => {
    const { id } = req.params;

    try {
      const messagesDir = store.getMessagesDir(id);
      const files = fsSync.readdirSync(messagesDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace('.jsonl', ''))
        .sort()
        .reverse();

      res.json({ dates: files });
    } catch (e) {
      res.json({ dates: [] });
    }
  });
}

module.exports = {
  registerAgentManagementRoutes
};
