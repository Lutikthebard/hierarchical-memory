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

const { OpenClawClient } = require('./gateway-client');
const {
  loadStore,
  saveStore,
  addArtifact,
  checkThreshold,
  getThresholdForLevel,
  formatTimestamp,
  loadConfig,
  loadAgentConfig
} = require('./store');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';
const TIMEOUT_SECONDS = parseInt(process.env.TRIGGER_TIMEOUT_SEC, 10) || 300; // 5 minutes

// Global client
let client = null;

/**
 * Create L1 summarization prompt
 */
function createL1Prompt(messages, agentConfig = null) {
  const startTs = messages[0].timestamp;
  const endTs = messages[messages.length - 1].timestamp;
  const startFormatted = formatTimestamp(startTs);
  const endFormatted = formatTimestamp(endTs);
  
  // Get custom prompt or use default
  const customPrompt = agentConfig?.prompts?.l1 || '';
  const promptInstructions = customPrompt || 
    'Focus on: key decisions, important information, context worth remembering.';
  
  return `🧠 MEMORY TASK: Create L1 Summary

Summarize ${messages.length} messages from: ${startFormatted} → ${endFormatted}

${promptInstructions}

**Wrap your entire response in <memory_artifact>...</memory_artifact> tags.**
Reply with ONLY the summary inside the tags. No JSON, no extra formatting.

After the closing </memory_artifact> tag, add a single line containing only: NO_REPLY`;
}

/**
 * Create aggregation prompt for Ln→Ln+1
 */
function createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig = null) {
  const startFormatted = formatTimestamp(artifacts[0].startTimestamp);
  const endFormatted = formatTimestamp(artifacts[artifacts.length - 1].endTimestamp);
  
  const artifactsText = artifacts.map((a, idx) => {
    return `[${idx + 1}] ${a.content}`;
  }).join('\n\n');
  
  // Get custom prompt or use default, replace {level} placeholder
  let customPrompt = agentConfig?.prompts?.aggregate || '';
  customPrompt = customPrompt.replace('{level}', sourceLevel);
  const promptInstructions = customPrompt || 
    'Combine into a higher-level summary. Focus on patterns, themes, key information.';
  
  return `🧠 MEMORY TASK: Create L${targetLevel} Summary

Aggregate ${artifacts.length} L${sourceLevel} summaries (${startFormatted} → ${endFormatted}):

${artifactsText}

${promptInstructions}

**Wrap your entire response in <memory_artifact>...</memory_artifact> tags.**
Reply with ONLY the summary inside the tags. No JSON, no extra formatting.

After the closing </memory_artifact> tag, add a single line containing only: NO_REPLY`;
}

/**
 * Create retry prompt after failed attempt
 */
function createRetryPrompt(errorMessage, previousResponse, originalPrompt) {
  return `${originalPrompt}

(Previous attempt was empty or invalid. Please provide a clear summary.)`;
}

/**
 * Parse agent response - extract content from <memory_artifact> tags
 */
function parseAgentResponse(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty response');
  }
  
  // Extract content from <memory_artifact> tags
  const match = text.match(/<memory_artifact>([\s\S]*?)<\/memory_artifact>/);
  if (match) {
    return match[1].trim();
  }
  
  // Fallback: if no tags, return trimmed text (for backwards compatibility)
  return text.trim();
}

/**
 * Connect to Gateway
 */
async function connectGateway() {
  // Always close old connection and create new one
  if (client) {
    try {
      await client.close();
    } catch (e) {
      // ignore close errors
    }
  }
  
  console.log(`[trigger] Connecting to Gateway: ${GATEWAY_URL}`);
  client = new OpenClawClient(GATEWAY_URL, GATEWAY_TOKEN);
  await client.connect();
  console.log('[trigger] Connected');
}

/**
 * Close Gateway connection
 */
function closeGateway() {
  if (client) {
    client.close();
    client = null;
  }
}

/**
 * Send message to agent via sessions.send and wait for response
 */
async function sendToAgent(agentId, message) {
  console.log(`[trigger] Sending to agent: ${agentId}`);
  
  await connectGateway();
  
  const reply = await client.sendToAgent(agentId, message, TIMEOUT_SECONDS);
  
  console.log(`[trigger] Got response (${reply.length} chars)`);
  
  return reply;
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

/**
 * Handle L1 summarization command
 */
async function handleL1(agentId, sessionKey) {
  console.log('[trigger] L1 summarization for agent:', agentId);
  
  // Load agent-specific config
  const agentConfig = loadAgentConfig(agentId);
  const threshold = agentConfig.thresholds?.L1 || getThresholdForLevel(1);
  
  const store = loadStore(agentId);
  const check = checkThreshold(store, 0, threshold);
  
  if (!check.needed) {
    console.log(`❌ Not ready: ${check.items.length}/${threshold} messages`);
    return;
  }
  
  const messages = check.items;
  const startTs = messages[0].timestamp;
  const endTs = messages[messages.length - 1].timestamp;
  
  console.log(`[trigger] L1 trigger: ${messages.length} messages`);
  console.log(`[trigger] Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  
  // Create initial prompt with agent config
  const originalPrompt = createL1Prompt(messages, agentConfig);
  let currentPrompt = originalPrompt;
  
  // Retry loop (max 3 attempts)
  const MAX_RETRIES = 3;
  let retries = 0;
  let artifact;
  let responseText;
  
  while (retries < MAX_RETRIES) {
    try {
      console.log(`[trigger] Attempt ${retries + 1}/${MAX_RETRIES}`);
      responseText = await sendToAgent(agentId, currentPrompt);
      
      // Parse artifact
      artifact = parseAgentResponse(responseText);
      console.log('[trigger] ✅ Successfully parsed artifact');
      break;
      
    } catch (error) {
      retries++;
      console.error(`[trigger] ❌ Attempt ${retries} failed: ${error.message}`);
      
      if (retries >= MAX_RETRIES) {
        console.error('[trigger] Max retries reached, giving up');
        console.error('[trigger] Last response:', responseText ? responseText.substring(0, 500) : 'No response');
        return;
      }
      
      // Create retry prompt
      console.log('[trigger] Retrying with error feedback...');
      currentPrompt = createRetryPrompt(error.message, responseText, originalPrompt);
    }
  }
  
  // Add to store - use known timestamps, artifact is just the content text
  addArtifact(store, 1, {
    content: artifact,  // artifact is now just the summary text
    startTimestamp: startTs,
    endTimestamp: endTs,
    messageCount: messages.length
  });
  
  saveStore(agentId, store);
  
  console.log('[trigger] ✅ L1 artifact created');
  console.log(`[trigger]    Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  console.log(`[trigger]    Messages: ${messages.length}`);
}

/**
 * Handle aggregation command (Ln→Ln+1)
 */
async function handleAggregate(agentId, sessionKey, sourceLevel) {
  console.log(`[trigger] L${sourceLevel}→L${sourceLevel + 1} aggregation for agent: ${agentId}`);
  
  // Load agent-specific config
  const agentConfig = loadAgentConfig(agentId);
  const threshold = agentConfig.thresholds?.default || getThresholdForLevel(sourceLevel + 1);
  
  const store = loadStore(agentId);
  const check = checkThreshold(store, sourceLevel, threshold);
  
  if (!check.needed) {
    console.log(`❌ Not ready: ${check.items.length}/${threshold} artifacts at L${sourceLevel}`);
    return;
  }
  
  const artifacts = check.items;
  const targetLevel = sourceLevel + 1;
  const startTs = artifacts[0].startTimestamp;
  const endTs = artifacts[artifacts.length - 1].endTimestamp;
  
  console.log(`[trigger] Aggregation: ${artifacts.length} L${sourceLevel} artifacts`);
  console.log(`[trigger] Time range: ${formatTimestamp(startTs)} → ${formatTimestamp(endTs)}`);
  
  // Create initial prompt with agent config
  const originalPrompt = createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig);
  let currentPrompt = originalPrompt;
  
  // Retry loop
  const MAX_RETRIES = 3;
  let retries = 0;
  let artifact;
  let responseText;
  
  while (retries < MAX_RETRIES) {
    try {
      console.log(`[trigger] Attempt ${retries + 1}/${MAX_RETRIES}`);
      responseText = await sendToAgent(agentId, currentPrompt);
      
      artifact = parseAgentResponse(responseText);
      console.log('[trigger] ✅ Successfully parsed artifact');
      break;
      
    } catch (error) {
      retries++;
      console.error(`[trigger] ❌ Attempt ${retries} failed: ${error.message}`);
      
      if (retries >= MAX_RETRIES) {
        console.error('[trigger] Max retries reached, giving up');
        return;
      }
      
      console.log('[trigger] Retrying with error feedback...');
      currentPrompt = createRetryPrompt(error.message, responseText, originalPrompt);
    }
  }
  
  // Add to store - use known timestamps, artifact is just the content text
  addArtifact(store, targetLevel, {
    content: artifact,  // artifact is now just the summary text
    startTimestamp: startTs,
    endTimestamp: endTs,
    sourceLevel: sourceLevel,
    artifactCount: artifacts.length
  });
  
  saveStore(agentId, store);
  
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
    console.log('  GATEWAY_URL   - WebSocket URL (default: ws://127.0.0.1:18789)');
    console.log('  GATEWAY_TOKEN - Auth token (optional)');
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
    closeGateway();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  closeGateway();
  process.exit(1);
});
