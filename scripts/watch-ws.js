#!/usr/bin/env node
/**
 * watch-ws.js — WebSocket-based message watcher for hierarchical memory
 * 
 * Replaces tail -F approach with Gateway WebSocket chat.subscribe.
 * 
 * Usage: node watch-ws.js <agentId> [sessionKey]
 * 
 * ENV:
 *   GATEWAY_URL=ws://127.0.0.1:18789
 *   GATEWAY_TOKEN=... (if auth enabled)
 *   SESSION_KEY=main (fallback if not provided as arg)
 */

const path = require('path');
const { OpenClawClient } = require('./gateway-client');
const {
  loadStore,
  saveStore,
  addMessage,
  checkThreshold,
  getThresholdForLevel,
  loadConfig,
  formatTimestamp
} = require('./store');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? '';
const RECONNECT_DELAY_MS = 5000;

// Global state
let client = null;
let storeRef = { current: null };
let agentId = null;
let sessionKey = null;
let summarizationInProgress = false;

/**
 * Check if message matches our criteria
 * Returns true for user/assistant messages with content
 */
function matchesCriteria(msg) {
  const role = msg?.role;
  const content = msg?.content;
  
  if (role !== 'user' && role !== 'assistant') return false;
  if (typeof content !== 'string' || content.trim().length === 0) return false;
  
  return true;
}

/**
 * Extract content from various message formats
 */
function extractContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');
  }
  
  return '';
}

/**
 * Normalize incoming chat message
 */
function normalizeMessage(chatMsg) {
  const content = extractContent(chatMsg.content);
  
  return {
    role: chatMsg.role,
    content,
    timestamp: chatMsg.timestamp || new Date().toISOString()
  };
}

/**
 * Run summarization via sessions_send
 */
async function runSummarization(sourceLevel) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  const timestamp = new Date().toISOString();
  const scriptDir = __dirname;
  
  try {
    // Step 1: Run trigger-ws.js (uses WebSocket instead of CLI)
    console.log(`[${timestamp}] Running trigger-ws.js...`);
    
    const triggerCmd = sourceLevel === 0
      ? `node ${scriptDir}/trigger-ws.js l1 ${agentId} ${sessionKey}`
      : `node ${scriptDir}/trigger-ws.js aggregate ${agentId} ${sessionKey} ${sourceLevel}`;
    
    const { stdout: triggerOut, stderr: triggerErr } = await execAsync(triggerCmd, {
      cwd: scriptDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 360000, // 6 minutes
      env: {
        ...process.env,
        GATEWAY_URL,
        GATEWAY_TOKEN
      }
    });
    
    if (triggerOut) {
      console.log('✅ Trigger output:');
      console.log(triggerOut);
    }
    
    if (triggerErr) {
      console.error('⚠️  Trigger stderr:', triggerErr);
    }
    
    // Step 2: Generate context
    console.log(`\n[${new Date().toISOString()}] Generating CONTEXT.md...`);
    
    const contextCmd = `node ${scriptDir}/context.js generate ${agentId} --output ${scriptDir}/../data/${agentId}/CONTEXT.md`;
    
    const { stdout: contextOut, stderr: contextErr } = await execAsync(contextCmd, {
      cwd: scriptDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000
    });
    
    if (contextOut) {
      console.log('✅ Context output:');
      console.log(contextOut);
    }
    
    console.log(`\n✅ Automatic summarization completed!\n`);
    
    // Reload store to pick up new artifacts
    console.log('🔄 Reloading store...');
    storeRef.current = loadStore(agentId);
    console.log(`   Artifacts: L1=${(storeRef.current.artifacts[1] || []).length}`);
    
    // Recursive check for next level
    const targetLevel = sourceLevel + 1;
    const nextThreshold = getThresholdForLevel(targetLevel + 1);
    const nextCheck = checkThreshold(storeRef.current, targetLevel, nextThreshold);
    
    if (nextCheck.needed) {
      console.log(`\n🔄 Recursive: L${targetLevel}→L${targetLevel + 1} ready`);
      await runSummarization(targetLevel);
    }
    
  } catch (error) {
    console.error(`\n❌ Summarization error: ${error.message}`);
    if (error.stdout) console.error('Stdout:', error.stdout);
    if (error.stderr) console.error('Stderr:', error.stderr);
  }
}

/**
 * Handle threshold reached
 */
async function onThresholdReached(sourceLevel, items) {
  const targetLevel = sourceLevel + 1;
  console.log(`\n🔔 THRESHOLD REACHED!`);
  console.log(`   Source: L${sourceLevel} → Target: L${targetLevel}`);
  console.log(`   Items: ${items.length}`);
  
  if (sourceLevel === 0) {
    const startTs = formatTimestamp(items[0].timestamp);
    const endTs = formatTimestamp(items[items.length - 1].timestamp);
    console.log(`   Range: ${startTs} → ${endTs}`);
  }
  
  console.log(`   → Starting summarization...\n`);
  
  await runSummarization(sourceLevel);
}

/**
 * Process incoming chat message
 */
async function processMessage(chatMsg) {
  // Check criteria
  if (!matchesCriteria(chatMsg)) {
    return false;
  }
  
  // Normalize
  const msg = normalizeMessage(chatMsg);
  
  // Add to store
  const added = addMessage(storeRef.current, msg);
  
  // Log
  const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
  const ts = formatTimestamp(added.timestamp);
  console.log(`[${ts}] ${msg.role.toUpperCase()}: ${preview}${msg.content.length > 50 ? '...' : ''}`);
  
  // Save
  saveStore(agentId, storeRef.current);
  
  // Check threshold
  const threshold = getThresholdForLevel(1);
  const check = checkThreshold(storeRef.current, 0, threshold);
  
  if (check.needed && !summarizationInProgress) {
    summarizationInProgress = true;
    console.log('🔒 Lock acquired');
    
    try {
      await onThresholdReached(0, check.items);
    } catch (err) {
      console.error('Error in onThresholdReached:', err);
    } finally {
      summarizationInProgress = false;
      console.log('🔓 Lock released');
    }
  } else if (check.needed && summarizationInProgress) {
    console.log('⏭️  Threshold met but summarization in progress - skipping');
  }
  
  return true;
}

/**
 * Connect to Gateway and subscribe
 */
async function connectAndSubscribe() {
  console.log(`\n🔌 Connecting to Gateway: ${GATEWAY_URL}`);
  
  client = new OpenClawClient(GATEWAY_URL, GATEWAY_TOKEN);
  
  // Set up message handler
  client.onChatMessage = processMessage;
  
  // Set up disconnect handler for auto-reconnect
  client.onDisconnect = () => {
    console.log(`\n⚠️  Disconnected from Gateway`);
    console.log(`   Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
    
    setTimeout(() => {
      connectAndSubscribe().catch(err => {
        console.error('Reconnect failed:', err);
        process.exit(1);
      });
    }, RECONNECT_DELAY_MS);
  };
  
  // Connect
  await client.connect();
  console.log('✅ Connected to Gateway');
  
  // Subscribe to session
  console.log(`📡 Subscribing to session: ${sessionKey}`);
  await client.subscribeToChat(sessionKey);
  console.log('✅ Subscribed to chat');
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node watch-ws.js <agentId> [sessionKey]');
    console.log('');
    console.log('Arguments:');
    console.log('  agentId    - Agent identifier (e.g., main)');
    console.log('  sessionKey - Session key (default: agentId or SESSION_KEY env)');
    console.log('');
    console.log('Environment:');
    console.log('  GATEWAY_URL   - WebSocket URL (default: ws://127.0.0.1:18789)');
    console.log('  GATEWAY_TOKEN - Auth token (optional)');
    console.log('  SESSION_KEY   - Default session key');
    console.log('');
    console.log('Example:');
    console.log('  node watch-ws.js main');
    console.log('  GATEWAY_URL=ws://localhost:18789 node watch-ws.js main main');
    process.exit(1);
  }
  
  agentId = args[0];
  sessionKey = args[1] || process.env.SESSION_KEY || agentId;
  
  // Load config
  const config = loadConfig();
  
  console.log('='.repeat(60));
  console.log('HIERARCHICAL MEMORY WATCHER (WebSocket)');
  console.log('='.repeat(60));
  console.log(`Agent:     ${agentId}`);
  console.log(`Session:   ${sessionKey}`);
  console.log(`Gateway:   ${GATEWAY_URL}`);
  console.log(`Threshold: ${config.thresholds.L1 || config.thresholds.default} messages`);
  console.log('='.repeat(60));
  
  // Load store
  storeRef.current = loadStore(agentId);
  console.log(`\nLoaded store: ${storeRef.current.messages.length} existing messages`);
  
  // Check if threshold already reached
  const threshold = getThresholdForLevel(1);
  const check = checkThreshold(storeRef.current, 0, threshold);
  if (check.needed) {
    console.log(`\n⚠️  Threshold already reached!`);
    summarizationInProgress = true;
    try {
      await onThresholdReached(0, check.items);
    } finally {
      summarizationInProgress = false;
    }
  }
  
  // Connect and subscribe
  await connectAndSubscribe();
  
  console.log(`\n👁  Watching for new messages...`);
  console.log(`   Press Ctrl+C to stop\n`);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    if (client) {
      client.close();
    }
    console.log(`Final store: ${storeRef.current.messages.length} messages`);
    process.exit(0);
  });
}

// Export for testing
module.exports = {
  matchesCriteria,
  normalizeMessage,
  processMessage
};

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
