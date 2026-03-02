const store = require('./store');
const triggerApi = require('./trigger-ws');
const { resolveThresholdForLevel, toPositiveInt } = require('./summarization-thresholds');
const { archiveSummarizedL0Messages } = require('./summarization-l0-archive');
const {
  mergeAgentConfigWithRuntime,
  normalizePromptMap
} = require('./summarization-runtime-overrides');

function getHighestArtifactLevel(artifactsMap) {
  const levels = Object.entries(artifactsMap || {})
    .filter(([, artifacts]) => Array.isArray(artifacts) && artifacts.length > 0)
    .map(([level]) => Number(level))
    .filter((level) => Number.isInteger(level) && level > 0);
  if (levels.length === 0) return 0;
  return Math.max(...levels);
}

function countAvailableUnsummarized(currentStore, sourceLevel, agentConfig, deps) {
  const unsummarized = deps.getUnsummarized(
    currentStore,
    sourceLevel,
    sourceLevel === 0 ? deps.agentId : null
  );
  if (sourceLevel === 0) {
    return deps.filterForCounting(unsummarized, agentConfig).length;
  }
  return unsummarized.length;
}

function createFullSummarizationService(deps = {}) {
  const runtime = {
    loadStore: deps.loadStore || store.loadStore,
    loadAgentConfig: deps.loadAgentConfig || store.loadAgentConfig,
    getUnsummarized: deps.getUnsummarized || store.getUnsummarized,
    filterForCounting: deps.filterForCounting || store.filterForCounting,
    getThresholdForLevel: deps.getThresholdForLevel || store.getThresholdForLevel,
    archiveMessages: deps.archiveMessages || store.archiveMessages,
    saveStore: deps.saveStore || store.saveStore,
    updateStore: deps.updateStore || store.updateStore,
    handleL1: deps.handleL1 || triggerApi.handleL1,
    handleAggregate: deps.handleAggregate || triggerApi.handleAggregate,
    logger: deps.logger || console
  };

  async function runFullSummarization({
    agentId,
    sessionKey,
    maxTargetLevel,
    aggregateBatch,
    startSourceLevel,
    runtimeConfigOverrides,
    aggregatePromptBySourceLevel
  } = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }

    const initialStore = runtime.loadStore(agentId);
    const initialMaxLevel = Math.max(1, getHighestArtifactLevel(initialStore.artifacts));
    const parsedMaxLevel = toPositiveInt(maxTargetLevel);
    const effectiveMaxLevel = parsedMaxLevel || initialMaxLevel;
    const configuredAggregateBatch = toPositiveInt(aggregateBatch);
    const parsedStartSourceLevel = Number(startSourceLevel);
    const effectiveStartSourceLevel = Number.isFinite(parsedStartSourceLevel) && parsedStartSourceLevel >= 0
      ? Math.floor(parsedStartSourceLevel)
      : 0;
    const aggregatePromptsByLevel = normalizePromptMap(aggregatePromptBySourceLevel || {});

    const result = {
      agentId,
      sessionKey,
      maxTargetLevel: effectiveMaxLevel,
      aggregateBatch: configuredAggregateBatch || null,
      startSourceLevel: effectiveStartSourceLevel,
      initialMaxLevel,
      passes: [],
      warnings: [],
      completedAt: null
    };

    for (let sourceLevel = effectiveStartSourceLevel; sourceLevel < effectiveMaxLevel; sourceLevel += 1) {
      const targetLevel = sourceLevel + 1;
      let levelRuns = 0;

      while (true) {
        const currentStore = runtime.loadStore(agentId);
        const agentConfig = mergeAgentConfigWithRuntime(
          runtime.loadAgentConfig(agentId),
          runtimeConfigOverrides || {}
        );
        const available = countAvailableUnsummarized(currentStore, sourceLevel, agentConfig, {
          getUnsummarized: runtime.getUnsummarized,
          filterForCounting: runtime.filterForCounting,
          agentId
        });

        if (available <= 0) break;

        const configuredThreshold = resolveThresholdForLevel(
          agentConfig,
          targetLevel,
          runtime.getThresholdForLevel(targetLevel)
        );
        const targetBatch = sourceLevel === 0
          ? configuredThreshold
          : (configuredAggregateBatch || configuredThreshold);
        const thresholdOverride = Math.max(1, Math.min(targetBatch, available));

        if (sourceLevel === 0) {
          const l1Result = await runtime.handleL1(agentId, sessionKey, {
            thresholdOverride,
            agentConfigOverride: agentConfig,
            l1PromptOverride: runtimeConfigOverrides?.prompts?.l1
          });
          const refreshedStore = runtime.loadStore(agentId);
          await archiveSummarizedL0Messages(agentId, refreshedStore, {
            archiveMessages: runtime.archiveMessages,
            saveStore: runtime.saveStore,
            loadStore: runtime.loadStore,
            updateStore: runtime.updateStore,
            summarizedMessageTimestamps: l1Result?.summarizedMessageTimestamps || [],
            logger: runtime.logger
          });
        } else {
          await runtime.handleAggregate(agentId, sessionKey, sourceLevel, {
            thresholdOverride,
            agentConfigOverride: agentConfig,
            aggregatePromptOverride: runtimeConfigOverrides?.prompts?.aggregate,
            aggregatePromptBySourceLevel: aggregatePromptsByLevel
          });
        }

        const nextStore = runtime.loadStore(agentId);
        const remaining = countAvailableUnsummarized(nextStore, sourceLevel, agentConfig, {
          getUnsummarized: runtime.getUnsummarized,
          filterForCounting: runtime.filterForCounting,
          agentId
        });

        result.passes.push({
          sourceLevel,
          targetLevel,
          batchSize: thresholdOverride,
          availableBefore: available,
          availableAfter: remaining
        });
        levelRuns += 1;

        if (remaining >= available) {
          result.warnings.push(
            `No progress on L${sourceLevel} -> L${targetLevel}; stopping this level to avoid loop`
          );
          break;
        }
      }

      runtime.logger.log(`[full-summarization] L${sourceLevel} -> L${targetLevel}: runs=${levelRuns}`);
    }

    result.completedAt = new Date().toISOString();
    return result;
  }

  return {
    runFullSummarization
  };
}

module.exports = {
  createFullSummarizationService,
  getHighestArtifactLevel
};
