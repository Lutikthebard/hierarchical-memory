function registerAgentConfigRoutes(app, ctx) {
  const {
    store,
    validateAgentConfig,
    messageClasses
  } = ctx;

  app.get('/api/agents/:id/config', (req, res) => {
    const { id } = req.params;
    try {
      const config = store.loadAgentConfig(id);
      res.json(config);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/agents/:id/config', (req, res) => {
    const { id } = req.params;
    const config = req.body;

    try {
      const validationError = validateAgentConfig(config, messageClasses);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      store.saveAgentConfig(id, config);
      res.json({ success: true, config });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerAgentConfigRoutes
};
