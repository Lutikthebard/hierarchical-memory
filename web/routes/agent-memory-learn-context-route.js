const { toPositiveInt } = require('../../scripts/summarization-thresholds');

function registerAgentMemoryLearnContextRoute(app, ctx) {
  const {
    ensureAgentDataDir,
    getAgentDataDir,
    path,
    scriptsDir,
    runningWatchers,
    rebuildContextFile,
    resolveActionSession,
    runLearnContext,
    requireAgent
  } = ctx;

  const runningByAgent = new Set();
  const controllersByAgent = new Map();

  app.post('/api/agents/:id/memory/learn-context/stop', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    const controller = controllersByAgent.get(id);
    if (!controller) {
      return res.json({
        success: true,
        agentId: id,
        running: false,
        cancelRequested: false
      });
    }

    controller.cancelRequested = true;
    return res.json({
      success: true,
      agentId: id,
      running: true,
      cancelRequested: true
    });
  });

  app.post('/api/agents/:id/memory/learn-context', async (req, res) => {
    const { id } = req.params;
    const agent = requireAgent(id, res);
    if (!agent) return;

    if (runningByAgent.has(id)) {
      return res.status(409).json({ error: `Learn Context already in progress for ${id}` });
    }

    const text = String(req.body?.text || '');
    const wordsPerBlock = toPositiveInt(req.body?.wordsPerBlock) || 180;
    const fromBlock = toPositiveInt(req.body?.fromBlock) || null;
    const toBlock = toPositiveInt(req.body?.toBlock) || null;
    const learningIntent = String(req.body?.learningIntent || '');
    const l1ArtifactPrompt = String(req.body?.l1ArtifactPrompt || '');

    runningByAgent.add(id);
    const controller = {
      cancelRequested: false,
      startedAt: Date.now()
    };
    controllersByAgent.set(id, controller);

    try {
      const session = await resolveActionSession(id, agent.isSubagent || false);
      const learnResult = await runLearnContext({
        agentId: id,
        sessionKey: session.sessionKey,
        text,
        wordsPerBlock,
        fromBlock,
        toBlock,
        learningIntent,
        l1ArtifactPrompt,
        shouldCancel: () => controller.cancelRequested === true
      });

      ensureAgentDataDir(id);
      const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
      await rebuildContextFile({
        agentId: id,
        contextPath,
        scriptDir: scriptsDir
      });

      const watcherRunning = runningWatchers?.has(id) === true;

      return res.json({
        success: true,
        agentId: id,
        session,
        watcherWasRunning: watcherRunning,
        watcherRestarted: false,
        contextPath,
        run: learnResult,
        completedAt: new Date().toISOString()
      });
    } catch (e) {
      if (e && e.code === 'LEARN_CONTEXT_CANCELLED') {
        return res.status(409).json({
          success: false,
          cancelled: true,
          agentId: id,
          error: e.message,
          run: {
            sentToSession: Number(e.sentToSession) || 0,
            totalChunks: Number(e.totalChunks) || 0
          }
        });
      }
      return res.status(500).json({ error: e.message });
    } finally {
      runningByAgent.delete(id);
      controllersByAgent.delete(id);
    }
  });
}

module.exports = {
  registerAgentMemoryLearnContextRoute
};
