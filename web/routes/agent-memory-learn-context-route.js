const { toPositiveInt } = require('../../scripts/summarization-thresholds');

function normalizeAggregatePromptMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};

  for (const [key, value] of Object.entries(raw)) {
    const prompt = String(value || '').trim();
    if (!prompt) continue;

    const rawKey = String(key || '').trim();
    const fromLabel = rawKey.match(/^L(\d+)$/i);
    const parsed = fromLabel ? Number(fromLabel[1]) : Number(rawKey);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    out[String(Math.floor(parsed))] = prompt;
  }

  return out;
}

function registerAgentMemoryLearnContextRoute(app, ctx) {
  const {
    ensureAgentDataDir,
    getAgentDataDir,
    path,
    scriptsDir,
    watcherMaintenance,
    rebuildContextFile,
    resolveActionSession,
    runLearnContext,
    requireAgent
  } = ctx;

  const runningByAgent = new Set();

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
    const aggregatePrompt = String(req.body?.aggregatePrompt || '');
    const thresholds = req.body?.thresholds && typeof req.body.thresholds === 'object'
      ? req.body.thresholds
      : {};
    const aggregatePromptsByLevel = normalizeAggregatePromptMap(req.body?.aggregatePromptsByLevel || {});

    const fullOptions = req.body?.fullSummarize && typeof req.body.fullSummarize === 'object'
      ? req.body.fullSummarize
      : {};
    const runFullSummarize = req.body?.runFullSummarize === false
      ? false
      : fullOptions.enabled !== false;
    const maxTargetLevel = toPositiveInt(req.body?.maxTargetLevel) || toPositiveInt(fullOptions.maxTargetLevel) || null;
    const aggregateBatch = toPositiveInt(req.body?.aggregateBatch) || toPositiveInt(fullOptions.aggregateBatch) || null;

    runningByAgent.add(id);
    try {
      const session = await resolveActionSession(id, agent.isSubagent || false);
      const run = await watcherMaintenance.withPausedWatcher(
        id,
        async () => {
          const learnResult = await runLearnContext({
            agentId: id,
            sessionKey: session.sessionKey,
            text,
            wordsPerBlock,
            fromBlock,
            toBlock,
            learningIntent,
            l1ArtifactPrompt,
            thresholds,
            aggregatePrompt,
            aggregatePromptsByLevel,
            runFullSummarize,
            maxTargetLevel,
            aggregateBatch
          });

          ensureAgentDataDir(id);
          const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
          await rebuildContextFile({
            agentId: id,
            contextPath,
            scriptDir: scriptsDir
          });

          return {
            learnResult,
            contextPath
          };
        },
        { restartErrorPrefix: 'Learn Context completed but watcher failed to restart' }
      );

      return res.json({
        success: true,
        agentId: id,
        session,
        watcherWasRunning: run.watcherWasRunning,
        watcherRestarted: run.watcherRestarted,
        contextPath: run.result.contextPath,
        run: run.result.learnResult,
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
  registerAgentMemoryLearnContextRoute,
  normalizeAggregatePromptMap
};
