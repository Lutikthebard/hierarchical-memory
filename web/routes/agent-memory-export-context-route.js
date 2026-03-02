const { toPositiveInt } = require('../../scripts/summarization-thresholds');

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return defaultValue;
}

function registerAgentMemoryExportContextRoute(app, ctx) {
  const {
    runExportLearnedContext,
    requireAgent
  } = ctx;

  const runningByAgent = new Set();

  app.post('/api/agents/:id/memory/export-context', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    if (runningByAgent.has(id)) {
      return res.status(409).json({ error: `Export Context already in progress for ${id}` });
    }

    const fromLevel = toPositiveInt(req.body?.fromLevel) || undefined;
    const toLevel = toPositiveInt(req.body?.toLevel) || undefined;
    const dateFrom = req.body?.dateFrom ? String(req.body.dateFrom) : undefined;
    const dateTo = req.body?.dateTo ? String(req.body.dateTo) : undefined;
    const includeArchivedMessages = parseBoolean(req.body?.includeArchivedMessages, true);
    const outputFileName = req.body?.outputFileName ? String(req.body.outputFileName) : undefined;
    const maxNodes = toPositiveInt(req.body?.maxNodes) || undefined;

    runningByAgent.add(id);
    try {
      const run = await runExportLearnedContext({
        agentId: id,
        fromLevel,
        toLevel,
        dateFrom,
        dateTo,
        includeArchivedMessages,
        outputFileName,
        maxNodes
      });

      return res.json({
        success: true,
        agentId: id,
        run,
        completedAt: new Date().toISOString()
      });
    } catch (e) {
      const msg = String(e.message || '');
      const isValidationError = /required|invalid|out of range|must be/i.test(msg);
      return res.status(isValidationError ? 400 : 500).json({ error: msg });
    } finally {
      runningByAgent.delete(id);
    }
  });
}

module.exports = {
  registerAgentMemoryExportContextRoute
};
