const { toPositiveInt } = require('../../scripts/summarization-thresholds');

function registerAgentMemoryFullSummarizationRoute(app, ctx) {
  const {
    ensureAgentDataDir,
    getAgentDataDir,
    path,
    scriptsDir,
    watcherMaintenance,
    rebuildContextFile,
    resolveActionSession,
    runFullSummarization,
    requireAgent
  } = ctx;

  const runningByAgent = new Set();

  app.post('/api/agents/:id/memory/summarize-full', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    if (runningByAgent.has(id)) {
      return res.status(409).json({ error: `Full summarization already in progress for ${id}` });
    }

    const parsedMaxLevel = toPositiveInt(req.body?.maxTargetLevel);
    const parsedAggregateBatch = toPositiveInt(req.body?.aggregateBatch);
    const injectContextAfter = req.body?.injectContextAfter === true;
    if (injectContextAfter) {
      return res.status(400).json({ error: 'injectContextAfter is not implemented yet' });
    }

    runningByAgent.add(id);
    try {
      const session = await resolveActionSession(id, agent.isSubagent || false);
      const run = await watcherMaintenance.withPausedWatcher(
        id,
        async () => {
          const runResult = await runFullSummarization({
            agentId: id,
            sessionKey: session.sessionKey,
            maxTargetLevel: parsedMaxLevel || undefined,
            aggregateBatch: parsedAggregateBatch || undefined
          });

          ensureAgentDataDir(id);
          const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
          await rebuildContextFile({
            agentId: id,
            contextPath,
            scriptDir: scriptsDir
          });
          return { runResult };
        },
        { restartErrorPrefix: 'Summarization completed but watcher failed to restart' }
      );
      const runResult = run.result.runResult;

      return res.json({
        success: true,
        agentId: id,
        session,
        options: {
          maxTargetLevel: parsedMaxLevel || null,
          aggregateBatch: parsedAggregateBatch || null
        },
        watcherWasRunning: run.watcherWasRunning,
        run: runResult,
        completedAt: new Date().toISOString()
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    } finally {
      runningByAgent.delete(id);
    }
  });
}

module.exports = {
  registerAgentMemoryFullSummarizationRoute
};
