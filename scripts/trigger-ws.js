#!/usr/bin/env node
/**
 * trigger-ws.js — WebSocket-based summarization trigger
 *
 * Uses sessions_send RPC instead of openclaw agent CLI.
 *
 * Usage:
 *   node trigger-ws.js status <agentId>
 *   node trigger-ws.js test <agentId>
 *   node trigger-ws.js l1 <agentId> <sessionKey>
 *   node trigger-ws.js aggregate <agentId> <sessionKey> <sourceLevel>
 *
 * ENV:
 *   GATEWAY_URL=ws://127.0.0.1:18789
 *   GATEWAY_TOKEN=... (if auth enabled)
 */

const crypto = require('crypto');
const { resolveThresholdForLevel, toPositiveInt } = require('./summarization-thresholds');
const {
  loadStore,
  saveStore,
  updateStore,
  addArtifact,
  selectSummarizationBatch,
  checkThreshold,
  getThresholdForLevel,
  formatTimestamp,
  loadAgentConfig
} = require('./store');
const {
  createL1Prompt,
  createAggregationPrompt,
  createRetryPrompt,
  parseAgentResponse
} = require('./trigger/prompt-factory');
const { safePreview, logTelemetry } = require('./trigger/telemetry');
const { setAdapter, closeAdapter, sendToAgent } = require('./trigger/adapter-runtime');
const { runMemoryTask } = require('./trigger/task-runner');

function resolveOverrideThreshold(override, configuredThreshold) {
  return toPositiveInt(override) || configuredThreshold;
}

async function persistArtifact(agentId, targetLevel, payload) {
  if (typeof updateStore === 'function') {
    const committed = await updateStore(agentId, (latestStore) => {
      const createdArtifact = addArtifact(latestStore, targetLevel, payload);
      return { createdArtifact };
    });
    return committed?.result?.createdArtifact || null;
  }

  const latestStore = loadStore(agentId);
  const createdArtifact = addArtifact(latestStore, targetLevel, payload);
  saveStore(agentId, latestStore);
  return createdArtifact || null;
}

function resolveAgentConfig(agentId, options = {}) {
  const baseConfig = loadAgentConfig(agentId);
  const override = options.agentConfigOverride;
  if (!override || typeof override !== 'object') {
    return baseConfig;
  }

  return {
    ...baseConfig,
    ...override,
    thresholds: {
      ...(baseConfig.thresholds || {}),
      ...(override.thresholds || {})
    },
    prompts: {
      ...(baseConfig.prompts || {}),
      ...(override.prompts || {})
    }
  };
}

function resolvePerLevelAggregatePrompt(sourceLevel, options = {}, agentConfig = null) {
  const level = Number(sourceLevel);
  if (!Number.isInteger(level) || level <= 0) return null;

  const fromMap = (map) => {
    if (!map || typeof map !== 'object') return null;
    const byNumeric = String(map[String(level)] || '').trim();
    if (byNumeric) return byNumeric;
    const byLabel = String(map[`L${level}`] || map[`l${level}`] || '').trim();
    return byLabel || null;
  };

  const fromOptions = fromMap(options.aggregatePromptBySourceLevel);
  if (fromOptions) return fromOptions;

  const fromConfig = fromMap(agentConfig?.prompts?.aggregateBySourceLevel);
  if (fromConfig) return fromConfig;

  return null;
}

function handleStatus(agentId) {
  const store = loadStore(agentId);
  const threshold = getThresholdForLevel(1);
  const check = checkThreshold(store, 0, threshold);

  console.log('='.repeat(60));
  console.log(`Store Status for ${agentId}`);
  console.log('='.repeat(60));
  console.log(`Messages (L0): ${store.messages.length}`);
  console.log('');

  if (store.messages.length > 0) {
    const first = store.messages[0];
    const last = store.messages[store.messages.length - 1];
    console.log(`First message: ${formatTimestamp(first.timestamp)}`);
    console.log(`Last message:  ${formatTimestamp(last.timestamp)}`);
    console.log('');
  }

  console.log(`L0→L1: ${check.items.length}/${threshold} messages (${check.needed ? 'READY ✅' : 'waiting ⏳'})`);

  if (check.needed) {
    const startTs = formatTimestamp(check.items[0].timestamp);
    const endTs = formatTimestamp(check.items[check.items.length - 1].timestamp);
    console.log(`  Time range: ${startTs} → ${endTs}`);
  }

  console.log('');

  const levels = Object.keys(store.artifacts).map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (levels.length > 0) {
    console.log('Artifacts:');
    for (const level of levels) {
      const artifacts = store.artifacts[level];
      console.log(`  L${level}: ${artifacts.length} artifact(s)`);
      if (artifacts.length > 0) {
        const last = artifacts[artifacts.length - 1];
        console.log(`    Last: ${formatTimestamp(last.startTimestamp)} → ${formatTimestamp(last.endTimestamp)}`);
      }
    }
  } else {
    console.log('Artifacts: none yet');
  }

  console.log('='.repeat(60));
}

function handleTest(agentId) {
  const store = loadStore(agentId);
  const threshold = getThresholdForLevel(1);
  const check = checkThreshold(store, 0, threshold);

  if (!check.needed) {
    console.log(`❌ Not ready: ${check.items.length}/${threshold} messages`);
    return;
  }

  const prompt = createL1Prompt(check.items);
  console.log('='.repeat(60));
  console.log('L1 SUMMARIZATION PROMPT PREVIEW');
  console.log('='.repeat(60));
  console.log(prompt);
  console.log('='.repeat(60));
  console.log(`Messages: ${check.items.length}`);
  console.log(`Prompt length: ${prompt.length} chars`);
}

async function runL1SummarizationTask({
  agentId,
  sessionKey,
  messages,
  agentConfig,
  threshold,
  availableCount,
  selectedCount,
  l1PromptOverride,
  sourceLevel = 0
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages are required for L1 summarization');
  }

  const requestId = crypto.randomUUID();
  const ordered = [...messages].sort(
    (a, b) => new Date(a?.timestamp || 0).getTime() - new Date(b?.timestamp || 0).getTime()
  );
  const startTs = ordered[0].timestamp;
  const endTs = ordered[ordered.length - 1].timestamp;
  const targetLevel = 1;
  const selectedCountable = Number.isFinite(selectedCount) ? selectedCount : ordered.length;
  const available = Number.isFinite(availableCount) ? availableCount : selectedCountable;
  const resolvedThreshold = Number.isFinite(threshold) ? threshold : ordered.length;

  console.log(`[trigger] L1 trigger: ${ordered.length} messages`);
  if (Number.isFinite(availableCount)) {
    console.log(`[trigger] Countable available: ${available}, selected: ${selectedCountable}`);
  }
  console.log(`[trigger] Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  logTelemetry(agentId, {
    eventType: 'memory_task_started',
    requestId,
    taskKind: 'l1',
    sourceLevel,
    targetLevel,
    threshold: resolvedThreshold,
    availableCount: available,
    selectedCount: selectedCountable,
    windowStart: startTs,
    windowEnd: endTs
  });

  const taskResult = await runMemoryTask({
    agentId,
    requestId,
    taskKind: 'l1',
    sourceLevel,
    targetLevel,
    threshold: resolvedThreshold,
    selectedCount: selectedCountable,
    windowStart: startTs,
    windowEnd: endTs,
    createPrompt: () => createL1Prompt(ordered, agentConfig, { promptOverride: l1PromptOverride }),
    createRetryPrompt,
    sendToAgent: (prompt) => sendToAgent(agentId, prompt, sessionKey, targetLevel),
    parseAgentResponse,
    logTelemetry,
    safePreview,
    logLastResponseOnFailure: true
  });

  if (!taskResult) {
    return null;
  }

  const createdArtifact = await persistArtifact(agentId, targetLevel, {
    content: taskResult.artifactText,
    startTimestamp: startTs,
    endTimestamp: endTs,
    messageCount: ordered.length
  });

  logTelemetry(agentId, {
    eventType: createdArtifact ? 'artifact_processed' : 'artifact_duplicate',
    requestId,
    taskKind: 'l1',
    sourceLevel,
    targetLevel,
    attemptsBeforeProcessed: taskResult.attemptsSent,
    attemptsSent: taskResult.attemptsSent,
    artifactId: createdArtifact?.artifactId || null,
    windowStart: startTs,
    windowEnd: endTs,
    selectedCount: selectedCountable
  });

  console.log('[trigger] ✅ L1 artifact created');
  console.log(`[trigger]    Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  console.log(`[trigger]    Messages: ${ordered.length}`);

  return {
    artifact: createdArtifact || null,
    summarizedMessageTimestamps: ordered.map((message) => message.timestamp).filter(Boolean),
    startTimestamp: startTs,
    endTimestamp: endTs
  };
}

async function handleL1(agentId, sessionKey, options = {}) {
  console.log('[trigger] L1 summarization for agent:', agentId);

  const agentConfig = resolveAgentConfig(agentId, options);
  const configuredThreshold = resolveThresholdForLevel(agentConfig, 1, getThresholdForLevel(1));
  const threshold = resolveOverrideThreshold(options.thresholdOverride, configuredThreshold);
  const requestId = crypto.randomUUID();

  const store = loadStore(agentId);
  const selected = selectSummarizationBatch(store, 0, threshold, agentId);
  const available = selected.countable ?? selected.items.length;

  if (!selected.needed) {
    logTelemetry(agentId, {
      eventType: 'memory_task_skipped',
      requestId,
      taskKind: 'l1',
      sourceLevel: 0,
      targetLevel: 1,
      reason: 'threshold_not_met',
      threshold,
      availableCount: available,
      selectedCount: 0
    });
    console.log(`❌ Not ready: ${available}/${threshold} messages`);
    return;
  }

  return runL1SummarizationTask({
    agentId,
    sessionKey,
    messages: selected.batch,
    agentConfig,
    threshold,
    availableCount: available,
    selectedCount: Array.isArray(selected.countableBatch) ? selected.countableBatch.length : selected.batch.length,
    l1PromptOverride: options.l1PromptOverride,
    sourceLevel: 0
  });
}

async function handleL1FromMessages(agentId, sessionKey, messages, options = {}) {
  console.log('[trigger] L1 summarization from provided messages for agent:', agentId);
  const agentConfig = resolveAgentConfig(agentId, options);
  const configuredThreshold = resolveThresholdForLevel(agentConfig, 1, getThresholdForLevel(1));
  const threshold = resolveOverrideThreshold(options.thresholdOverride, configuredThreshold);

  return runL1SummarizationTask({
    agentId,
    sessionKey,
    messages,
    agentConfig,
    threshold,
    availableCount: Array.isArray(messages) ? messages.length : 0,
    selectedCount: Array.isArray(messages) ? messages.length : 0,
    l1PromptOverride: options.l1PromptOverride,
    sourceLevel: 0
  });
}

async function handleAggregate(agentId, sessionKey, sourceLevel, options = {}) {
  console.log(`[trigger] L${sourceLevel}→L${sourceLevel + 1} aggregation for agent: ${agentId}`);

  const agentConfig = resolveAgentConfig(agentId, options);
  const targetLevel = sourceLevel + 1;
  const configuredThreshold = resolveThresholdForLevel(agentConfig, targetLevel, getThresholdForLevel(targetLevel));
  const threshold = resolveOverrideThreshold(options.thresholdOverride, configuredThreshold);
  const requestId = crypto.randomUUID();

  const store = loadStore(agentId);
  const selected = selectSummarizationBatch(store, sourceLevel, threshold);

  if (!selected.needed) {
    logTelemetry(agentId, {
      eventType: 'memory_task_skipped',
      requestId,
      taskKind: 'aggregate',
      sourceLevel,
      targetLevel,
      reason: 'threshold_not_met',
      threshold,
      availableCount: selected.items.length,
      selectedCount: 0
    });
    console.log(`❌ Not ready: ${selected.items.length}/${threshold} artifacts at L${sourceLevel}`);
    return;
  }

  const artifacts = selected.batch;
  const startTs = artifacts[0].startTimestamp;
  const endTs = artifacts[artifacts.length - 1].endTimestamp;
  const levelPromptOverride = resolvePerLevelAggregatePrompt(sourceLevel, options, agentConfig);

  console.log(`[trigger] Aggregation: ${artifacts.length} L${sourceLevel} artifacts`);
  console.log(`[trigger] Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  logTelemetry(agentId, {
    eventType: 'memory_task_started',
    requestId,
    taskKind: 'aggregate',
    sourceLevel,
    targetLevel,
    threshold,
    availableCount: selected.items.length,
    selectedCount: artifacts.length,
    windowStart: startTs,
    windowEnd: endTs
  });

  const taskResult = await runMemoryTask({
    agentId,
    requestId,
    taskKind: 'aggregate',
    sourceLevel,
    targetLevel,
    threshold,
    selectedCount: artifacts.length,
    windowStart: startTs,
    windowEnd: endTs,
    createPrompt: () => createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig, {
      promptOverride: levelPromptOverride || options.aggregatePromptOverride || null
    }),
    createRetryPrompt,
    sendToAgent: (prompt) => sendToAgent(agentId, prompt, sessionKey, targetLevel),
    parseAgentResponse,
    logTelemetry,
    safePreview,
    includeSelectedCountInFailure: true
  });

  if (!taskResult) {
    return;
  }

  const createdArtifact = await persistArtifact(agentId, targetLevel, {
    content: taskResult.artifactText,
    startTimestamp: startTs,
    endTimestamp: endTs,
    sourceLevel,
    artifactCount: artifacts.length
  });

  logTelemetry(agentId, {
    eventType: createdArtifact ? 'artifact_processed' : 'artifact_duplicate',
    requestId,
    taskKind: 'aggregate',
    sourceLevel,
    targetLevel,
    attemptsBeforeProcessed: taskResult.attemptsSent,
    attemptsSent: taskResult.attemptsSent,
    artifactId: createdArtifact?.artifactId || null,
    windowStart: startTs,
    windowEnd: endTs,
    selectedCount: artifacts.length
  });

  console.log(`[trigger] ✅ L${targetLevel} artifact created`);
  console.log(`[trigger]    Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  console.log(`[trigger]    Aggregated: ${artifacts.length} L${sourceLevel} artifacts`);

  const nextCheck = checkThreshold(store, targetLevel, getThresholdForLevel(targetLevel + 1));
  if (nextCheck.needed) {
    console.log(`[trigger] ⚠️  Recursive: L${targetLevel}→L${targetLevel + 1} also ready`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage:');
    console.log('  node trigger-ws.js status <agentId>');
    console.log('  node trigger-ws.js test <agentId>');
    console.log('  node trigger-ws.js l1 <agentId> <sessionKey>');
    console.log('  node trigger-ws.js aggregate <agentId> <sessionKey> <sourceLevel>');
    console.log('');
    console.log('Environment:');
    console.log('  HM_LLM_MODE=mock|openclaw (default: openclaw)');
    console.log('  GATEWAY_URL/GATEWAY_TOKEN/TRIGGER_TIMEOUT_SEC for openclaw mode');
    process.exit(1);
  }

  const command = args[0];
  const agentId = args[1];
  const sessionKey = args[2];
  const sourceLevel = args[3] ? parseInt(args[3], 10) : undefined;

  try {
    switch (command) {
      case 'status':
        handleStatus(agentId);
        break;

      case 'test':
        handleTest(agentId);
        break;

      case 'l1':
        if (!sessionKey) {
          console.error('Error: sessionKey required for l1 command');
          process.exit(1);
        }
        await handleL1(agentId, sessionKey);
        break;

      case 'aggregate':
        if (!sessionKey || sourceLevel === undefined) {
          console.error('Error: sessionKey and sourceLevel required for aggregate command');
          process.exit(1);
        }
        await handleAggregate(agentId, sessionKey, sourceLevel);
        break;

      default:
        console.error('Unknown command:', command);
        process.exit(1);
    }
  } finally {
    await closeAdapter();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    closeAdapter().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  createL1Prompt,
  createAggregationPrompt,
  parseAgentResponse,
  setAdapter,
  handleL1,
  handleL1FromMessages,
  handleAggregate,
  closeAdapter
};
