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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveThresholdForLevel, toPositiveInt } = require('./summarization-thresholds');
const { createLLMAdapterFromEnv } = require('./llm-adapter');
const {
  loadStore,
  saveStore,
  addArtifact,
  selectSummarizationBatch,
  checkThreshold,
  getThresholdForLevel,
  formatTimestamp,
  loadAgentConfig,
  getDataDir
} = require('./store');
let llmAdapter = null;
let adapterMode = 'openclaw';

function setAdapter(adapter, mode = 'custom') {
  llmAdapter = adapter || null;
  adapterMode = mode;
}

function safePreview(text, maxLen = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function getArtifactTagName(level) {
  const normalizedLevel = Number(level);
  if (!Number.isInteger(normalizedLevel) || normalizedLevel < 1) {
    throw new Error(`Invalid artifact level: ${level}`);
  }
  return `memory_artifact_L${normalizedLevel}`;
}

function getTelemetryPath(agentId) {
  return path.join(getDataDir(), agentId, 'summarization-events.jsonl');
}

function logTelemetry(agentId, payload) {
  const telemetryPath = getTelemetryPath(agentId);
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  });
  fs.appendFileSync(telemetryPath, `${line}\n`, 'utf8');
}

function resolveOverrideThreshold(override, configuredThreshold) {
  return toPositiveInt(override) || configuredThreshold;
}

/**
 * Create L1 summarization prompt
 */
function createL1Prompt(messages, agentConfig = null, options = {}) {
  const startTs = messages[0].timestamp;
  const endTs = messages[messages.length - 1].timestamp;
  const startFormatted = formatTimestamp(startTs);
  const endFormatted = formatTimestamp(endTs);
  
  // Get custom prompt or use default
  const customPrompt = String(options.promptOverride || '').trim() || agentConfig?.prompts?.l1 || '';
  const promptInstructions = customPrompt ||
    'Summarize messages into a concise memory artifact. Focus on: decisions made, problems solved, key insights, action items. Use markdown headers for structure. Be concise but complete.';
  
  const artifactTag = getArtifactTagName(1);

  return `🧠 MEMORY TASK: This is a system message.

Summarize ${messages.length} messages from: ${startFormatted} → ${endFormatted}.

${promptInstructions}

Your answer to this message will be stored as a summary.

Wrap your entire response in <${artifactTag}>...</${artifactTag}> tags.
  Reply with ONLY the summary inside the tags.
  Add NO_REPLY at the end of the message.`;
}

/**
 * Create aggregation prompt for Ln→Ln+1
 */
function createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig = null, options = {}) {
  const startFormatted = formatTimestamp(artifacts[0].startTimestamp);
  const endFormatted = formatTimestamp(artifacts[artifacts.length - 1].endTimestamp);
  
  const artifactsText = artifacts.map((a, idx) => {
    return `[${idx + 1}] ${a.content}`;
  }).join('\n\n');
  
  // Get custom prompt or use default, replace {level} placeholder
  let customPrompt = String(options.promptOverride || '').trim() || agentConfig?.prompts?.aggregate || '';
  customPrompt = customPrompt.replace('{level}', sourceLevel);
  const promptInstructions = customPrompt ||
    `Create a concise higher-level memory artifact from L${sourceLevel} summaries. Focus on: recurring themes, major decisions, unresolved issues, durable insights. Use markdown headers for structure. Be concise but complete.`;
  
  const artifactTag = getArtifactTagName(targetLevel);

  return `🧠 MEMORY TASK: This is a system message.

Aggregate ${artifacts.length} L${sourceLevel} summaries into L${targetLevel} for: ${startFormatted} → ${endFormatted}.

${artifactsText}

${promptInstructions}

Your answer to this message will be stored as a summary.

Wrap your entire response in <${artifactTag}>...</${artifactTag}> tags.
  Reply with ONLY the summary inside the tags.
  Add NO_REPLY at the end of the message.`;
}

/**
 * Create retry prompt after failed attempt
 */
function createRetryPrompt(errorMessage, previousResponse, originalPrompt) {
  return `${originalPrompt}

(Previous attempt was empty or invalid. Please provide a clear summary.)`;
}

/**
 * Parse agent response - extract content from <memory_artifact_L{N}> tags
 */
function parseAgentResponse(text, expectedLevel) {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty response');
  }

  const artifactTag = getArtifactTagName(expectedLevel);
  const pattern = new RegExp(`<${artifactTag}>([\\s\\S]*?)<\\/${artifactTag}>`);

  // Extract content from level-specific artifact tags
  const match = text.match(pattern);
  if (match) {
    return match[1].trim();
  }

  throw new Error(`Missing required artifact tag <${artifactTag}>...</${artifactTag}>`);
}

function getAdapter() {
  if (!llmAdapter) {
    const config = createLLMAdapterFromEnv();
    adapterMode = config.mode;
    llmAdapter = config.adapter;
    console.log(`[trigger] LLM adapter mode: ${adapterMode}`);
  }
  return llmAdapter;
}

async function closeAdapter() {
  if (llmAdapter && typeof llmAdapter.close === 'function') {
    await llmAdapter.close();
  }
  llmAdapter = null;
}

/**
 * Send message to agent via sessions.send and wait for response
 */
async function sendToAgent(agentId, message, sessionKey = null, targetLevel = null) {
  console.log(`[trigger] Sending to agent: ${agentId}`);
  const adapter = getAdapter();
  const reply = await adapter.send(agentId, message, { sessionKey, targetLevel });
  const captureInfo = adapter.lastCaptureInfo;

  console.log(`[trigger] Got response (${reply.length} chars, capture: ${captureInfo?.method ?? 'unknown'}, collected: ${captureInfo?.collectedCount ?? '?'})`);

  return { reply, captureInfo };
}

/**
 * Handle status command
 */
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
  
  // Show artifacts
  const levels = Object.keys(store.artifacts).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
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

/**
 * Handle test command (preview prompt without sending)
 */
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

  const store = loadStore(agentId);
  const requestId = crypto.randomUUID();
  const ordered = [...messages].sort(
    (a, b) => new Date(a?.timestamp || 0).getTime() - new Date(b?.timestamp || 0).getTime()
  );
  const startTs = ordered[0].timestamp;
  const endTs = ordered[ordered.length - 1].timestamp;
  const targetLevel = 1;
  const selectedCountable = Number.isFinite(selectedCount) ? selectedCount : ordered.length;
  const available = Number.isFinite(availableCount) ? availableCount : selectedCountable;

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
    threshold: Number.isFinite(threshold) ? threshold : ordered.length,
    availableCount: available,
    selectedCount: selectedCountable,
    windowStart: startTs,
    windowEnd: endTs
  });

  const originalPrompt = createL1Prompt(ordered, agentConfig, {
    promptOverride: l1PromptOverride
  });
  let currentPrompt = originalPrompt;

  const MAX_RETRIES = 3;
  let retries = 0;
  let artifact;
  let responseText;

  while (retries < MAX_RETRIES) {
    try {
      const attempt = retries + 1;
      console.log(`[trigger] Attempt ${attempt}/${MAX_RETRIES}`);
      logTelemetry(agentId, {
        eventType: 'memory_task_sent',
        requestId,
        taskKind: 'l1',
        sourceLevel,
        targetLevel,
        threshold: Number.isFinite(threshold) ? threshold : ordered.length,
        selectedCount: selectedCountable,
        windowStart: startTs,
        windowEnd: endTs,
        attempt,
        promptHash: crypto.createHash('sha1').update(currentPrompt).digest('hex'),
        promptPreview: safePreview(currentPrompt)
      });
      const sendResult = await sendToAgent(agentId, currentPrompt, sessionKey, targetLevel);
      responseText = sendResult.reply;
      logTelemetry(agentId, {
        eventType: 'memory_task_response',
        requestId,
        taskKind: 'l1',
        sourceLevel,
        targetLevel,
        attempt,
        responseLength: String(responseText || '').length,
        responsePreview: safePreview(responseText),
        captureMethod: sendResult.captureInfo?.method ?? null,
        captureCollectedCount: sendResult.captureInfo?.collectedCount ?? null
      });

      artifact = parseAgentResponse(responseText, targetLevel);
      console.log('[trigger] ✅ Successfully parsed artifact');
      break;
    } catch (error) {
      retries += 1;
      logTelemetry(agentId, {
        eventType: 'memory_task_attempt_failed',
        requestId,
        taskKind: 'l1',
        sourceLevel,
        targetLevel,
        attempt: retries,
        error: error.message
      });
      console.error(`[trigger] ❌ Attempt ${retries} failed: ${error.message}`);

      if (retries >= MAX_RETRIES) {
        console.error('[trigger] Max retries reached, giving up');
        console.error('[trigger] Last response:', responseText ? responseText.substring(0, 500) : 'No response');
        logTelemetry(agentId, {
          eventType: 'artifact_failed',
          requestId,
          taskKind: 'l1',
          sourceLevel,
          targetLevel,
          attemptsSent: retries,
          windowStart: startTs,
          windowEnd: endTs
        });
        return null;
      }

      console.log('[trigger] Retrying with error feedback...');
      currentPrompt = createRetryPrompt(error.message, responseText, originalPrompt);
    }
  }

  const createdArtifact = addArtifact(store, targetLevel, {
    content: artifact,
    startTimestamp: startTs,
    endTimestamp: endTs,
    messageCount: ordered.length
  });

  saveStore(agentId, store);
  logTelemetry(agentId, {
    eventType: createdArtifact ? 'artifact_processed' : 'artifact_duplicate',
    requestId,
    taskKind: 'l1',
    sourceLevel,
    targetLevel,
    attemptsBeforeProcessed: retries + 1,
    attemptsSent: retries + 1,
    artifactId: createdArtifact?.artifactId || null,
    windowStart: startTs,
    windowEnd: endTs,
    selectedCount: selectedCountable
  });

  console.log('[trigger] ✅ L1 artifact created');
  console.log(`[trigger]    Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  console.log(`[trigger]    Messages: ${ordered.length}`);

  return createdArtifact || null;
}

/**
 * Handle L1 summarization command
 */
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

  await runL1SummarizationTask({
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

/**
 * Handle aggregation command (Ln→Ln+1)
 */
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
  
  const levelPromptOverride = resolvePerLevelAggregatePrompt(sourceLevel, options, agentConfig);

  const originalPrompt = createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig, {
    promptOverride: levelPromptOverride || options.aggregatePromptOverride || null
  });
  let currentPrompt = originalPrompt;
  
  // Retry loop
  const MAX_RETRIES = 3;
  let retries = 0;
  let artifact;
  let responseText;
  
  while (retries < MAX_RETRIES) {
    try {
      const attempt = retries + 1;
      console.log(`[trigger] Attempt ${attempt}/${MAX_RETRIES}`);
      logTelemetry(agentId, {
        eventType: 'memory_task_sent',
        requestId,
        taskKind: 'aggregate',
        sourceLevel,
        targetLevel,
        threshold,
        selectedCount: artifacts.length,
        windowStart: startTs,
        windowEnd: endTs,
        attempt,
        promptHash: crypto.createHash('sha1').update(currentPrompt).digest('hex'),
        promptPreview: safePreview(currentPrompt)
      });
      const sendResult = await sendToAgent(agentId, currentPrompt, sessionKey, targetLevel);
      responseText = sendResult.reply;
      logTelemetry(agentId, {
        eventType: 'memory_task_response',
        requestId,
        taskKind: 'aggregate',
        sourceLevel,
        targetLevel,
        attempt,
        responseLength: String(responseText || '').length,
        responsePreview: safePreview(responseText),
        captureMethod: sendResult.captureInfo?.method ?? null,
        captureCollectedCount: sendResult.captureInfo?.collectedCount ?? null
      });

      artifact = parseAgentResponse(responseText, targetLevel);
      console.log('[trigger] ✅ Successfully parsed artifact');
      break;
      
    } catch (error) {
      retries++;
      logTelemetry(agentId, {
        eventType: 'memory_task_attempt_failed',
        requestId,
        taskKind: 'aggregate',
        sourceLevel,
        targetLevel,
        attempt: retries,
        error: error.message
      });
      console.error(`[trigger] ❌ Attempt ${retries} failed: ${error.message}`);
      
      if (retries >= MAX_RETRIES) {
        console.error('[trigger] Max retries reached, giving up');
        logTelemetry(agentId, {
          eventType: 'artifact_failed',
          requestId,
          taskKind: 'aggregate',
          sourceLevel,
          targetLevel,
          attemptsSent: retries,
          windowStart: startTs,
          windowEnd: endTs,
          selectedCount: artifacts.length
        });
        return;
      }
      
      console.log('[trigger] Retrying with error feedback...');
      currentPrompt = createRetryPrompt(error.message, responseText, originalPrompt);
    }
  }
  
  // Add to store - use known timestamps, artifact is just the content text
  const createdArtifact = addArtifact(store, targetLevel, {
    content: artifact,  // artifact is now just the summary text
    startTimestamp: startTs,
    endTimestamp: endTs,
    sourceLevel: sourceLevel,
    artifactCount: artifacts.length
  });
  
  saveStore(agentId, store);
  logTelemetry(agentId, {
    eventType: createdArtifact ? 'artifact_processed' : 'artifact_duplicate',
    requestId,
    taskKind: 'aggregate',
    sourceLevel,
    targetLevel,
    attemptsBeforeProcessed: retries + 1,
    attemptsSent: retries + 1,
    artifactId: createdArtifact?.artifactId || null,
    windowStart: startTs,
    windowEnd: endTs,
    selectedCount: artifacts.length
  });
  
  console.log(`[trigger] ✅ L${targetLevel} artifact created`);
  console.log(`[trigger]    Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  console.log(`[trigger]    Aggregated: ${artifacts.length} L${sourceLevel} artifacts`);
  
  // Check if we need to recurse
  const nextCheck = checkThreshold(store, targetLevel, getThresholdForLevel(targetLevel + 1));
  if (nextCheck.needed) {
    console.log(`[trigger] ⚠️  Recursive: L${targetLevel}→L${targetLevel + 1} also ready`);
  }
}

/**
 * Main
 */
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
  main().catch(err => {
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
