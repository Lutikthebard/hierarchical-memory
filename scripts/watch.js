#!/usr/bin/env node
/**
 * Watch JSONL session file and track messages into hierarchical memory store
 * 
 * Usage: node watch.js <agentId> <sessionId> [jsonlPath]
 * 
 * - Reads existing JSONL file on startup
 * - Uses tail -F to watch for new messages
 * - Filters: type === "message" && (role === "user" || role === "assistant")
 * - Adds messages to store via addMessage()
 * - Checks threshold after each addition
 * - Calls onThresholdReached when threshold is met
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  loadStore,
  saveStore,
  addMessage,
  checkThreshold,
  getThresholdForLevel,
  loadConfig,
  loadAgentConfig,
  formatTimestamp,
  getDataDir
} = require('./store');
const { execSync } = require('child_process');
const { OpenClawClient } = require('./gateway-client');
const { parseMessage, extractContent } = require('./message-parser');
const { CompactController } = require('./compact-controller');
const { createSummarizationOrchestrator } = require('./summarization-orchestrator');

// Default paths
const OPENCLAW_DIR = path.join(process.env.HOME, '.openclaw');
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';
const AGENTS_CONFIG_PATH = path.join(__dirname, '..', 'agents.json');

// Global lock to prevent parallel summarizations
let summarizationInProgress = false;

const compactController = new CompactController();

/**
 * Load agents.json configuration
 */
function loadAgentsConfigFile() {
  try {
    if (fs.existsSync(AGENTS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(AGENTS_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load agents.json:', e.message);
  }
  return { agents: [] };
}

/**
 * Check if agent is a subagent (reads from agents.json)
 */
function isSubagent(agentId) {
  const config = loadAgentsConfigFile();
  const agent = config.agents.find(a => a.id === agentId);
  return agent?.isSubagent || false;
}

/**
 * Get sessions directory path for agent
 * Subagents use main's sessions directory
 */
function getSessionsDir(agentId) {
  const effectiveAgentId = isSubagent(agentId) ? 'main' : agentId;
  return path.join(OPENCLAW_DIR, 'agents', effectiveAgentId, 'sessions');
}

// Debounce for context regeneration
let contextRegenerateTimeout = null;
const CONTEXT_DEBOUNCE_MS = 10000; // 10 seconds

// Current session tracking for hot-swap
let currentTailProcess = null;
let currentSessionId = null;

/**
 * Save last known session ID to prevent duplicate context injections on restart
 */
function saveLastSessionId(agentId, sessionId) {
  const dataDir = getDataDir();
  const lastSessionPath = path.join(dataDir, agentId, 'last-session.json');
  try {
    fs.writeFileSync(lastSessionPath, JSON.stringify({ sessionId, timestamp: Date.now() }, null, 2));
  } catch (e) {
    // Silent fail
  }
}

/**
 * Load last known session ID
 */
function loadLastSessionId(agentId) {
  const dataDir = getDataDir();
  const lastSessionPath = path.join(dataDir, agentId, 'last-session.json');
  try {
    if (fs.existsSync(lastSessionPath)) {
      const data = JSON.parse(fs.readFileSync(lastSessionPath, 'utf8'));
      return data.sessionId;
    }
  } catch (e) {
    // Silent fail
  }
  return null;
}

function getContextPath(agentId) {
  return path.join(getDataDir(), agentId, 'CONTEXT.md');
}

const { onThresholdReached } = createSummarizationOrchestrator({
  scriptDir: __dirname,
  loadStore,
  saveStore,
  archiveMessages: require('./store').archiveMessages,
  removeSummarizedMessages: require('./store').removeSummarizedMessages,
  getLastSummarizedTimestamp: require('./store').getLastSummarizedTimestamp,
  checkThreshold,
  getThresholdForLevel,
  formatTimestamp,
  getContextPath
});

/**
 * Regenerate CONTEXT.md (debounced)
 */
function scheduleContextRegenerate(agentId) {
  if (contextRegenerateTimeout) {
    clearTimeout(contextRegenerateTimeout);
  }
  contextRegenerateTimeout = setTimeout(() => {
    const scriptDir = __dirname;
    const contextPath = getContextPath(agentId);
    try {
      execSync(`node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`, { stdio: 'ignore' });
    } catch (err) {
      // Silently ignore context generation errors
    }
  }, CONTEXT_DEBOUNCE_MS);
}

// Debounce for context injection (prevent multiple injections)
let contextInjectTimeout = null;
let lastInjectedSessionId = null;

/**
 * Inject CONTEXT.md into agent session via WebSocket
 */
async function injectContext(agentId, reason = 'manual') {
  const agentConfig = loadAgentConfig(agentId);
  const autoInject = agentConfig.autoInjectContext || {};
  
  if (!autoInject.enabled) {
    console.log(`[inject] Auto-inject disabled for ${agentId}`);
    return;
  }
  
  // Read CONTEXT.md
  const contextPath = getContextPath(agentId);
  if (!fs.existsSync(contextPath)) {
    console.log(`[inject] No CONTEXT.md found for ${agentId}`);
    return;
  }
  
  const contextContent = fs.readFileSync(contextPath, 'utf8');
  if (!contextContent.trim()) {
    console.log(`[inject] CONTEXT.md is empty for ${agentId}`);
    return;
  }
  
  console.log(`\n📥 Injecting CONTEXT.md (${reason})...`);
  console.log(`   Size: ${contextContent.length} bytes`);
  
  try {
    const crypto = require('crypto');
    const client = new OpenClawClient(GATEWAY_URL);
    await client.connect();
    
    // Send context as user message (agent will see it)
    const message = `📚 **Hierarchical Memory Context** (auto-injected after ${reason})\n\n${contextContent}`;
    const targetSessionKey = `agent:${agentId}:main`;
    
    console.log(`   → Sending to sessionKey: ${targetSessionKey}`);
    const sendResult = await client.rpc('chat.send', {
      sessionKey: targetSessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
      timeoutMs: 30000
    });
    
    await client.close();
    console.log(`✅ Context injected successfully`);
  } catch (err) {
    console.error(`❌ Failed to inject context:`, err.message);
  }
}

/**
 * Schedule context injection with debounce
 */
function scheduleContextInject(agentId, reason, delayMs = 2000) {
  if (contextInjectTimeout) {
    clearTimeout(contextInjectTimeout);
  }
  contextInjectTimeout = setTimeout(() => {
    injectContext(agentId, reason);
  }, delayMs);
}

/**
 * Get current line count in JSONL
 */
function getJsonlLineCount(jsonlPath) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    return content.split('\n').filter(l => l.trim()).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Check if compaction occurred by reading new lines after startLine
 */
async function checkCompactionOccurred(jsonlPath, startLine) {
  try {
    const content = await require('fs').promises.readFile(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // Read only lines after startLine
    const newLines = lines.slice(startLine);
    
    for (const line of newLines) {
      try {
        const data = JSON.parse(line);
        if (data.type === 'compaction') {
          return true;
        }
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Send /compact command (non-blocking, no retry loop)
 * Retry happens naturally on each assistant message via awaitingCompaction flag
 * Throttled to max 1 command per 5 seconds
 */
async function sendCompactMessage(agentId, message) {
  try {
    const crypto = require('crypto');
    const client = new OpenClawClient(GATEWAY_URL);
    await client.connect();
    
    // Send /compact command via WebSocket
    const compactSessionKey = `agent:${agentId}:main`;
    console.log(`   → Sending /compact to sessionKey: ${compactSessionKey}`);
    await client.rpc('chat.send', {
      sessionKey: compactSessionKey,
      message: message,
      idempotencyKey: crypto.randomUUID(),
      timeoutMs: 30000
    });
    
    await client.close();
    console.log(`   📤 /compact command sent`);
    return true;
  } catch (err) {
    console.log(`   ⚠️  Failed to send /compact: ${err.message}`);
    return false;
  }
}

/**
 * Check if line contains compaction event
 * Returns true if compaction detected
 */
function checkForCompaction(line, agentId) {
  if (!line.trim()) return false;
  
  try {
    const data = JSON.parse(line);
    
    // Compaction is recorded as type:"compaction" in JSONL
    if (data.type === 'compaction') {
      const agentConfig = loadAgentConfig(agentId);
      const autoInject = agentConfig.autoInjectContext || {};
      
      if (autoInject.enabled && autoInject.onCompaction) {
        console.log(`\n🔄 Compaction detected! (${data.tokensBefore} tokens before)`);
        scheduleContextInject(agentId, 'compaction', 3000);
      }

      const stateBefore = compactController.getState();
      console.log(`   Resetting session message counter (was ${stateBefore.sessionMessageCount})`);
      if (stateBefore.awaitingCompaction) {
        console.log(`   ✅ Auto-compact completed (${stateBefore.compactRetryCount} retries)`);
      }
      compactController.resetAfterCompaction();
      
      return true;
    }
  } catch (e) {
    // Not JSON or parse error
  }
  return false;
}


/**
 * Process a message line: parse, add to store, check threshold
 * storeRef is {current: store} to allow updates from async callbacks
 */
async function processLine(agentId, storeRef, line, options = {}) {
  // Load agent config for filtering
  const agentConfig = options.agentConfig || loadAgentConfig(agentId);
  
  const msg = parseMessage(line, agentConfig);
  if (!msg) return false;
  
  const added = addMessage(storeRef.current, msg);

  // Skip duplicate timestamps safely
  if (!added) {
    return false;
  }

  // Increment session message counter (only for newly added countable messages)
  if (msg.shouldCount) {
    compactController.markMessageProcessed(true);
  }

  if (options.verbose) {
    const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
    const ts = formatTimestamp(added.timestamp);
    console.log(`[${ts}] ${msg.role.toUpperCase()}: ${preview}${msg.content.length > 50 ? '...' : ''}`);
  }

  // Save store after each new message
  if (!options.skipPersistence) {
    saveStore(agentId, storeRef.current);
  }

  // Schedule CONTEXT.md regeneration (debounced)
  if (!options.skipContextRegenerate) {
    scheduleContextRegenerate(agentId);
  }

  // AutoCompact: check threshold and retry strategy
  const agentCfg = options.agentConfig || loadAgentConfig(agentId);
  const autoCompact = agentCfg.autoCompact || {};
  
  if (autoCompact.enabled) {
    await compactController.maybeTriggerOrRetry({
      agentId,
      msg,
      autoCompact,
      postMessage: autoCompact.postCompactMessage || '',
      sendFn: sendCompactMessage,
      log: console.log
    });
  }
  
  // Check threshold for L0 → L1 (use agent config)
  // Skip during initial file processing (let main() handle it asynchronously)
  if (!options.skipThresholdCheck) {
    const threshold = agentCfg.thresholds?.L1 || getThresholdForLevel(1);
    const check = checkThreshold(storeRef.current, 0, threshold, agentId);
    
    if (check.needed && !summarizationInProgress) {
      // Set lock to prevent parallel summarizations
      summarizationInProgress = true;
      console.log(`🔒 Lock acquired for summarization`);
      
      try {
        const updatedStore = await onThresholdReached(agentId, storeRef.current, 0, check.items);
        if (updatedStore) {
          storeRef.current = updatedStore; // Update reference
      }
    } catch (err) {
      console.error('Error in onThresholdReached:', err);
    } finally {
      // Always release lock
      summarizationInProgress = false;
      console.log(`🔓 Lock released`);
    }
    } else if (check.needed && summarizationInProgress) {
      // Threshold met but summarization already in progress - skip
      console.log(`⏭️  Threshold met but summarization already in progress - skipping`);
    }
  }  // end skipThresholdCheck
  
  return true;
}

/**
 * Read existing JSONL file and process all messages
 */
async function processExistingFile(agentId, storeRef, jsonlPath, options = {}) {
  if (!fs.existsSync(jsonlPath)) {
    console.log(`File not found: ${jsonlPath}`);
    return 0;
  }
  
  // First pass: find last compaction event
  const content = fs.readFileSync(jsonlPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  let lastCompactionIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(lines[i]);
      if (data.type === 'compaction') {
        lastCompactionIndex = i;
        console.log(`   Found compaction at line ${i+1}, counting messages after it`);
        // Reset counter since we're starting fresh from this compaction
        compactController.resetCounterOnly();
        break;
      }
    } catch (e) {}
  }
  
  // Second pass: process only messages after last compaction (or all if no compaction)
  const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
  let count = 0;
  
  for (let i = startIndex; i < lines.length; i++) {
    if (await processLine(agentId, storeRef, lines[i], { verbose: false, skipThresholdCheck: true })) {
      count++;
    }
  }
  
  // Save final state
  saveStore(agentId, storeRef.current);
  
  return count;
}

/**
 * Watch JSONL file for new lines using tail -F
 * Returns tail process for management
 */
function watchFile(agentId, storeRef, jsonlPath, options = {}) {
  console.log(`\n👁 Watching for new messages (tail -F)...`);
  console.log(`   Press Ctrl+C to stop\n`);
  
  const tail = spawn('tail', ['-F', '-n', '0', jsonlPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  // Track globally for hot-swap
  currentTailProcess = tail;
  
  const rl = readline.createInterface({
    input: tail.stdout,
    crlfDelay: Infinity
  });
  
  rl.on('line', async (line) => {
    // Check for compaction event (before processing)
    checkForCompaction(line, agentId);
    
    // Process message normally
    await processLine(agentId, storeRef, line, { verbose: true });
  });
  
  tail.stderr.on('data', (data) => {
    const msg = data.toString();
    if (!msg.includes('file truncated')) {
      console.error(`tail stderr: ${msg}`);
    }
  });
  
  tail.on('close', (code) => {
    // Only exit if this is still the current tail (not hot-swapped)
    if (currentTailProcess === tail) {
      console.log(`\ntail exited with code ${code}`);
      process.exit(code);
    } else {
      console.log(`   Old tail process ended (hot-swap)`);
    }
  });
  
  // Handle graceful shutdown (only register once)
  if (!options.skipSignalHandler) {
    process.on('SIGINT', () => {
      console.log(`\n\nShutting down...`);
      if (currentTailProcess) currentTailProcess.kill();
      console.log(`Final store state: ${storeRef.current.messages.length} messages`);
      process.exit(0);
    });
  }
  
  return tail;
}

/**
 * Switch to a new session (hot-swap)
 * Kills old tail, loads new store, starts new tail
 */
async function switchToSession(agentId, newSessionId, storeRef) {
  console.log(`\n🔄 SESSION CHANGE DETECTED!`);
  console.log(`   Old: ${currentSessionId}`);
  console.log(`   New: ${newSessionId}`);
  
  // Kill old tail process
  if (currentTailProcess) {
    console.log(`   Stopping old watcher...`);
    currentTailProcess.kill();
  }
  
  // Update current session
  currentSessionId = newSessionId;
  const sessionsDir = getSessionsDir(agentId);
  const newJsonlPath = path.join(sessionsDir, `${newSessionId}.jsonl`);
  
  // Load fresh store (keep artifacts, reset messages for new session)
  storeRef.current = loadStore(agentId);
  const artifactCount = Object.values(storeRef.current.artifacts || {}).reduce((sum, arr) => sum + (arr?.length || 0), 0);
  console.log(`   Loaded store: ${storeRef.current.messages.length} messages, ${artifactCount} artifacts`);
  
  // Process existing file
  console.log(`   Reading existing messages from new JSONL...`);
  const added = await processExistingFile(agentId, storeRef, newJsonlPath);
  console.log(`   Added ${added} new messages (total: ${storeRef.current.messages.length})`);
  
  // Generate fresh CONTEXT.md
  console.log(`   Regenerating CONTEXT.md...`);
  const scriptDir = __dirname;
  const contextPath = getContextPath(agentId);
  try {
    execSync(`node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`, { stdio: 'pipe' });
  } catch (err) {
    console.error(`   Failed to generate CONTEXT.md:`, err.message);
  }
  
  // Save session ID to prevent duplicate injections on restart
  saveLastSessionId(agentId, newSessionId);
  
  // Auto-inject context for new session
  const agentConfig = loadAgentConfig(agentId);
  const autoInject = agentConfig.autoInjectContext || {};
  if (autoInject.enabled && autoInject.onNewSession) {
    console.log(`   Scheduling context injection...`);
    scheduleContextInject(agentId, 'new session', 3000);
  }
  
  // Start new watcher
  watchFile(agentId, storeRef, newJsonlPath, { skipSignalHandler: true });
  console.log(`   ✅ Switched to new session\n`);
}

/**
 * Watch sessions directory for new JSONL files
 * Automatically switch to newer sessions when they appear
 */
function watchSessionDirectory(agentId, storeRef) {
  const sessionsDir = getSessionsDir(agentId);
  
  if (!fs.existsSync(sessionsDir)) {
    console.log(`⚠️  Sessions directory not found: ${sessionsDir}`);
    return;
  }
  
  console.log(`\n👁️  Watching ${sessionsDir} for new sessions...`);
  
  // Debounce to avoid rapid-fire events
  let checkTimeout = null;
  
  const checkForNewSession = async () => {
    if (checkTimeout) clearTimeout(checkTimeout);
    
    checkTimeout = setTimeout(async () => {
      try {
        const activeSessionId = await getActiveSession(agentId, { quiet: true });
        
        if (activeSessionId && activeSessionId !== currentSessionId) {
          console.log(`\n🔄 New session detected: ${activeSessionId}`);
          await switchToSession(agentId, activeSessionId, storeRef);
        }
      } catch (err) {
        // Silently ignore errors
      }
    }, 2000); // 2 second debounce
  };
  
  fs.watch(sessionsDir, { persistent: true }, (eventType, filename) => {
    if (filename && filename.endsWith('.jsonl')) {
      checkForNewSession();
    }
  });
}

/**
 * Auto-detect active session for agent
 * Uses file-based detection only (reads from correct sessions directory)
 */
async function getActiveSession(agentId, options = {}) {
  const quiet = options.quiet || false;
  
  // Find most recently modified JSONL file in correct directory
  const sessionsDir = getSessionsDir(agentId);
  if (!fs.existsSync(sessionsDir)) {
    throw new Error(`Sessions directory not found: ${sessionsDir}`);
  }
  
  let files = fs.readdirSync(sessionsDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(sessionsDir, f),
      sessionId: f.replace('.jsonl', ''),
      mtime: fs.statSync(path.join(sessionsDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);
  
  // For subagents: query gateway to find the correct session file
  if (isSubagent(agentId)) {
    const targetKey = `agent:${agentId}`;
    let client;
    try {
      client = new OpenClawClient();
      await client.connect();
      const result = await client.rpc('sessions.list', { limit: 100 });
      const sessions = result?.sessions || [];
      const match = sessions.find(s => s.key === targetKey);
      if (match) {
        const sessionId = match.sessionId;
        const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
        if (fs.existsSync(jsonlPath)) {
          // Found via gateway — use only this file
          const stat = fs.statSync(jsonlPath);
          files = [{
            name: `${sessionId}.jsonl`,
            path: jsonlPath,
            sessionId,
            mtime: stat.mtime.getTime()
          }];
        } else {
          if (!quiet) console.log(`⚠️ Gateway found session ${sessionId} but JSONL not found at ${jsonlPath}`);
          files = [];
        }
      } else {
        if (!quiet) console.log(`⚠️ No gateway session found with key=${targetKey}`);
        files = [];
      }
    } catch (err) {
      if (!quiet) console.log(`⚠️ Gateway lookup failed (${err.message}), falling back to file mtime`);
      // On gateway failure, keep files as-is (sorted by mtime) — best effort
    } finally {
      if (client) {
        try { client.close(); } catch {}
      }
    }
  }

  if (files.length === 0) {
    throw new Error(`No JSONL files found in ${sessionsDir}${isSubagent(agentId) ? ` matching agent:${agentId}` : ''}`);
  }
  
  const newest = files[0];
  const sessionId = newest.sessionId;
  if (!quiet) {
    console.log(`🔍 Auto-detected session via file mtime`);
    console.log(`   Directory: ${sessionsDir}`);
    console.log(`   File: ${newest.name}`);
    console.log(`   Modified: ${new Date(newest.mtime).toISOString()}`);
  }
  return sessionId;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('Usage: node watch.js <agentId> [sessionId] [jsonlPath]');
    console.log('');
    console.log('Arguments:');
    console.log('  agentId   - Agent identifier (e.g., main, council-architect)');
    console.log('  sessionId - Optional: Session UUID (auto-detected if omitted)');
    console.log('  jsonlPath - Optional: explicit path to JSONL file');
    console.log('');
    console.log('Example:');
    console.log('  node watch.js main                    # auto-detect session');
    console.log('  node watch.js main 58053277-6c68-...  # explicit session');
    process.exit(1);
  }
  
  const [agentId, explicitSessionId, explicitPath] = args;
  
  // Auto-detect session if not provided
  const sessionId = explicitSessionId || await getActiveSession(agentId);
  
  // Check if session changed since last run
  const lastSessionId = loadLastSessionId(agentId);
  const isNewSession = lastSessionId !== sessionId;
  
  // Track current session for hot-swap
  currentSessionId = sessionId;
  
  // Save current session ID
  saveLastSessionId(agentId, sessionId);
  
  // Determine JSONL path
  const sessionsDir = getSessionsDir(agentId);
  const jsonlPath = explicitPath || 
    path.join(sessionsDir, `${sessionId}.jsonl`);
  
  console.log('='.repeat(60));
  console.log('HIERARCHICAL MEMORY WATCHER');
  console.log('='.repeat(60));
  console.log(`Agent:    ${agentId}`);
  console.log(`Session:  ${sessionId}`);
  console.log(`JSONL:    ${jsonlPath}`);
  
  // Load config
  const config = loadConfig();
  console.log(`Threshold L1: ${config.thresholds.L1 || config.thresholds.default} messages`);
  console.log('='.repeat(60));
  
  // Load or create store and wrap in reference object
  // CRITICAL: storeRef allows async callbacks to update the store
  const storeRef = { current: loadStore(agentId) };
  const initialCount = storeRef.current.messages.length;
  console.log(`\nLoaded store: ${initialCount} existing messages`);
  
  // Process existing file
  console.log(`\n📖 Reading existing messages from JSONL...`);
  const added = await processExistingFile(agentId, storeRef, jsonlPath);
  console.log(`   Added ${added} new messages (total: ${storeRef.current.messages.length})`);
  
  // Generate initial CONTEXT.md
  console.log(`\n📝 Generating CONTEXT.md...`);
  const scriptDir = __dirname;
  const contextPath = getContextPath(agentId);
  try {
    execSync(`node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`, { stdio: 'inherit' });
    console.log(`   CONTEXT.md updated`);
  } catch (err) {
    console.error(`   Failed to generate CONTEXT.md:`, err.message);
  }
  
  // Auto-inject context ONLY if session actually changed
  const agentCfgForInject = loadAgentConfig(agentId);
  const autoInject = agentCfgForInject.autoInjectContext || {};
  if (autoInject.enabled && autoInject.onNewSession && isNewSession) {
    console.log(`\n📥 Scheduling context injection (new session detected)...`);
    // Delayed inject to let agent settle
    scheduleContextInject(agentId, 'new session', 5000);
  } else if (autoInject.enabled && autoInject.onNewSession && !isNewSession) {
    console.log(`\n⏭️  Skipping context injection (same session, watcher restart)`);
  }
  
  // Start watching for new messages FIRST (non-blocking)
  // This ensures tail -F is running even during summarization
  watchFile(agentId, storeRef, jsonlPath, { verbose: true });
  
  // Check thresholds asynchronously after watchFile is running
  const agentCfg = loadAgentConfig(agentId);
  
  // Use setTimeout to not block - watchFile needs to be running to track new messages
  setTimeout(async () => {
    // Check if L1 threshold is already reached
    const threshold = agentCfg.thresholds?.L1 || getThresholdForLevel(1);
    const check = checkThreshold(storeRef.current, 0, threshold, agentId);
    if (check.needed) {
      console.log(`\n⚠️ Threshold already reached with existing messages!`);
      console.log(`   Countable: ${check.countable || check.items.length}, Threshold: ${threshold}`);
      const updatedStore = await onThresholdReached(agentId, storeRef.current, 0, check.items);
      if (updatedStore) {
        storeRef.current = updatedStore;
      }
    }
    
    // Check autoCompact threshold
    const compactState = compactController.getState();
    console.log(`\n🔍 Checking autoCompact: sessionMessageCount=${compactState.sessionMessageCount}, awaitingCompaction=${compactState.awaitingCompaction}`);
    const autoCompact = agentCfg.autoCompact || {};
    console.log(`   autoCompact.enabled=${autoCompact.enabled}, threshold=${autoCompact.messageThreshold || 150}`);
    if (autoCompact.enabled && !compactState.awaitingCompaction) {
      if (compactState.sessionMessageCount >= (autoCompact.messageThreshold || 150)) {
        console.log(`\n🗜️  AutoCompact threshold already reached: ${compactState.sessionMessageCount}/${autoCompact.messageThreshold || 150}`);
        await compactController.maybeTriggerOrRetry({
          agentId,
          msg: { role: 'system', shouldCount: false },
          autoCompact,
          postMessage: autoCompact.postCompactMessage || '',
          sendFn: sendCompactMessage,
          log: console.log
        });
      } else {
        console.log(`   Not yet: ${compactState.sessionMessageCount} < ${autoCompact.messageThreshold || 150}`);
      }
    } else {
      console.log(`   Skipped: enabled=${autoCompact.enabled}, awaiting=${compactState.awaitingCompaction}`);
    }
  }, 1000);  // 1 second delay to let tail -F establish
  
  // Watch sessions directory for new sessions (auto-switch on /new)
  watchSessionDirectory(agentId, storeRef);
}

// Export for testing
module.exports = {
  parseMessage,
  extractContent,
  processLine,
  onThresholdReached
};

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
