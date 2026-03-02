const store = require('./store');
const triggerApi = require('./trigger-ws');
const { createFullSummarizationService } = require('./full-summarization-service');
const { toPositiveInt } = require('./summarization-thresholds');
const {
  normalizeThresholdOverrides,
  normalizePromptMap,
  mergeAgentConfigWithRuntime,
  composeLearnL1Prompt
} = require('./summarization-runtime-overrides');

function splitTextIntoWordBlocks(text, wordsPerBlock) {
  const rawWords = String(text || '')
    .replace(/\r/g, '\n')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (rawWords.length === 0) {
    return [];
  }

  const size = toPositiveInt(wordsPerBlock) || 180;
  const blocks = [];
  for (let i = 0; i < rawWords.length; i += size) {
    const words = rawWords.slice(i, i + size);
    blocks.push({
      blockIndex: blocks.length + 1,
      startWord: i + 1,
      endWord: i + words.length,
      text: words.join(' ')
    });
  }
  return blocks;
}

function sliceBlocks(blocks, fromBlock, toBlock) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];

  const from = toPositiveInt(fromBlock) || 1;
  const to = toPositiveInt(toBlock) || blocks.length;

  if (from > to) {
    throw new Error(`Invalid block range: fromBlock (${from}) > toBlock (${to})`);
  }
  if (from > blocks.length) {
    throw new Error(`fromBlock (${from}) is out of range (max ${blocks.length})`);
  }

  return blocks.filter((block) => block.blockIndex >= from && block.blockIndex <= to);
}

function createLearnContextService(deps = {}) {
  const runtime = {
    loadAgentConfig: deps.loadAgentConfig || store.loadAgentConfig,
    handleL1FromMessages: deps.handleL1FromMessages || triggerApi.handleL1FromMessages,
    runFullSummarization: deps.runFullSummarization || createFullSummarizationService().runFullSummarization,
    logger: deps.logger || console
  };

  async function runLearnContext({
    agentId,
    sessionKey,
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
  } = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }

    const blocks = splitTextIntoWordBlocks(text, wordsPerBlock);
    if (blocks.length === 0) {
      throw new Error('text must contain at least one word');
    }

    const selectedBlocks = sliceBlocks(blocks, fromBlock, toBlock);
    if (selectedBlocks.length === 0) {
      throw new Error('no blocks selected');
    }

    const baseAgentConfig = runtime.loadAgentConfig(agentId);
    const thresholdOverrides = normalizeThresholdOverrides(thresholds || {});
    const runtimeConfigOverrides = {
      thresholds: thresholdOverrides,
      prompts: {}
    };
    if (typeof aggregatePrompt === 'string' && aggregatePrompt.trim()) {
      runtimeConfigOverrides.prompts.aggregate = aggregatePrompt.trim();
    }
    const runtimeAgentConfig = mergeAgentConfigWithRuntime(baseAgentConfig, runtimeConfigOverrides);
    const aggregatePromptMap = normalizePromptMap(aggregatePromptsByLevel || {});
    const l1PromptOverride = composeLearnL1Prompt(
      runtimeAgentConfig?.prompts?.l1 || '',
      learningIntent,
      l1ArtifactPrompt
    );

    const createdL1Artifacts = [];
    const startedAt = Date.now();

    for (let idx = 0; idx < selectedBlocks.length; idx += 1) {
      const block = selectedBlocks[idx];
      const timestamp = new Date(startedAt + idx * 1000).toISOString();
      const created = await runtime.handleL1FromMessages(agentId, sessionKey, [
        {
          role: 'user',
          content: block.text,
          timestamp
        }
      ], {
        thresholdOverride: 1,
        agentConfigOverride: runtimeAgentConfig,
        l1PromptOverride
      });

      if (created) {
        createdL1Artifacts.push({
          blockIndex: block.blockIndex,
          artifactId: created.artifactId || null
        });
      }
    }

    const shouldRunFull = runFullSummarize !== false;
    let fullRun = null;
    if (shouldRunFull) {
      const parsedMaxTarget = toPositiveInt(maxTargetLevel) || 8;
      const parsedAggregateBatch = toPositiveInt(aggregateBatch);

      fullRun = await runtime.runFullSummarization({
        agentId,
        sessionKey,
        startSourceLevel: 1,
        maxTargetLevel: parsedMaxTarget,
        aggregateBatch: parsedAggregateBatch || undefined,
        runtimeConfigOverrides,
        aggregatePromptBySourceLevel: aggregatePromptMap
      });
    }

    return {
      agentId,
      blocks: {
        total: blocks.length,
        selected: selectedBlocks.length,
        from: selectedBlocks[0]?.blockIndex || null,
        to: selectedBlocks[selectedBlocks.length - 1]?.blockIndex || null,
        wordsPerBlock: toPositiveInt(wordsPerBlock) || 180
      },
      l1: {
        created: createdL1Artifacts.length,
        attempted: selectedBlocks.length,
        artifacts: createdL1Artifacts
      },
      fullSummarize: {
        enabled: shouldRunFull,
        run: fullRun
      },
      completedAt: new Date().toISOString()
    };
  }

  return {
    runLearnContext,
    splitTextIntoWordBlocks,
    sliceBlocks
  };
}

module.exports = {
  createLearnContextService,
  splitTextIntoWordBlocks,
  sliceBlocks
};
