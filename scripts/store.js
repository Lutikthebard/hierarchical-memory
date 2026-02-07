/**
 * Store module for hierarchical memory system (timestamp-based)
 * 
 * Store structure:
 * {
 *   messages: [{role, content, timestamp}],
 *   artifacts: {1: [...], 2: [...], ...}
 * }
 * 
 * Key: timestamp (ISO string) is the unique identifier
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CLASS_FILTERS,
  classifyMessage,
  normalizeText,
  normalizeClassFilters,
  commandAllowed,
  isClassIncludedForTarget
} = require('./message-classifier');

const CONFIG_PATH = path.join(__dirname, '../config.json');

// Default agent config
const DEFAULT_AGENT_CONFIG = {
  thresholds: { L1: 60, default: 5 },
  prompts: {
    l1: "Summarize the following conversation into a concise memory artifact. Focus on: decisions made, problems solved, key insights, action items. Use markdown headers for structure. Be concise but complete.",
    aggregate: "Aggregate these L{level} memory artifacts into a higher-level summary. Identify patterns, major themes, and important conclusions. Preserve key details while reducing redundancy."
  },
  filters: {
    exclude: ["HEARTBEAT_OK", "NO_REPLY"],
    excludePatterns: [],
    countRoles: ["user", "assistant"],
    storeRoles: ["user", "assistant"],
    ...DEFAULT_CLASS_FILTERS
  },
  autoInjectContext: {
    enabled: false,
    onNewSession: false,
    onCompaction: false
  },
  autoCompact: {
    enabled: false,
    messageThreshold: 150,
    retries: 5,
    retryDelayMs: 3000
  }
};

/**
 * Load global configuration
 */
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return {
    thresholds: { L1: 60, default: 5 },
    contextOverlap: 1,
    includeTimestamps: true,
    dataDir: './data'
  };
}

/**
 * Load agent-specific configuration (with defaults)
 */
function loadAgentConfig(agentId) {
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, agentId, 'config.json');
  
  let agentConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`Failed to load agent config for ${agentId}:`, e.message);
    }
  }
  
  // Deep merge with defaults
  return {
    thresholds: { ...DEFAULT_AGENT_CONFIG.thresholds, ...agentConfig.thresholds },
    prompts: { ...DEFAULT_AGENT_CONFIG.prompts, ...agentConfig.prompts },
    filters: { ...DEFAULT_AGENT_CONFIG.filters, ...agentConfig.filters },
    autoInjectContext: { ...DEFAULT_AGENT_CONFIG.autoInjectContext, ...agentConfig.autoInjectContext },
    autoCompact: { ...DEFAULT_AGENT_CONFIG.autoCompact, ...agentConfig.autoCompact }
  };
}

/**
 * Save agent-specific configuration
 */
function saveAgentConfig(agentId, config) {
  const dataDir = getDataDir();
  const agentDir = path.join(dataDir, agentId);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  const configPath = path.join(agentDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Get data directory path
 */
function getDataDir() {
  if (process.env.HM_DATA_DIR) {
    return path.resolve(process.env.HM_DATA_DIR);
  }
  const config = loadConfig();
  return path.resolve(path.dirname(CONFIG_PATH), config.dataDir);
}

/**
 * Get store path for agent
 */
function getStorePath(agentId) {
  const dataDir = getDataDir();
  const agentDir = path.join(dataDir, agentId);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  return path.join(agentDir, 'store.json');
}

/**
 * Create empty store
 */
function createEmptyStore() {
  return {
    messages: [],
    artifacts: {}
  };
}

/**
 * Load store for agent (create if not exists)
 */
function loadStore(agentId) {
  const storePath = getStorePath(agentId);
  if (fs.existsSync(storePath)) {
    const data = fs.readFileSync(storePath, 'utf8');
    const store = JSON.parse(data);
    // Ensure artifacts field exists (for backward compat)
    if (!store.artifacts) {
      store.artifacts = {};
    }
    
    // Load artifacts from separate file if it exists
    const artifactsPath = path.join(path.dirname(storePath), 'artifacts.json');
    if (fs.existsSync(artifactsPath)) {
      try {
        const artifactsData = fs.readFileSync(artifactsPath, 'utf8');
        const artifacts = JSON.parse(artifactsData);
        // Merge with store artifacts
        store.artifacts = { ...store.artifacts, ...artifacts };
      } catch (err) {
        console.warn(`Failed to load artifacts.json for ${agentId}:`, err.message);
      }
    }
    
    return store;
  }
  return createEmptyStore();
}

/**
 * Save store for agent
 */
function saveStore(agentId, store) {
  const storePath = getStorePath(agentId);
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * Compare timestamps (ISO strings)
 * Returns: -1 if ts1 < ts2, 0 if equal, 1 if ts1 > ts2
 */
function compareTimestamps(ts1, ts2) {
  if (!ts1 && !ts2) return 0;
  if (!ts1) return -1;
  if (!ts2) return 1;
  
  const t1 = new Date(ts1).getTime();
  const t2 = new Date(ts2).getTime();
  
  if (isNaN(t1) || isNaN(t2)) {
    throw new Error(`Invalid timestamp: ts1=${ts1}, ts2=${ts2}`);
  }
  
  if (t1 < t2) return -1;
  if (t1 > t2) return 1;
  return 0;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp) {
  if (!timestamp) return 'N/A';
  
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }
  
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

/**
 * Add message to L0
 * Timestamp is the unique identifier
 */
function addMessage(store, { role, content, timestamp, messageClass }) {
  // Ensure timestamp is ISO string
  const ts = typeof timestamp === 'number' 
    ? new Date(timestamp).toISOString()
    : (timestamp || new Date().toISOString());
  
  // Check for duplicate by timestamp
  if (store.messages.some(m => m.timestamp === ts)) {
    return null; // Skip duplicate
  }
  
  const message = {
    role,
    content,
    timestamp: ts
  };
  if (messageClass) {
    message.messageClass = messageClass;
  }
  
  store.messages.push(message);
  return message;
}

/**
 * Add artifact to level
 * Uses timestamps instead of IDs
 */
function addArtifact(store, level, { content, startTimestamp, endTimestamp, messageCount, sourceLevel, artifactCount }) {
  if (!store.artifacts[level]) {
    store.artifacts[level] = [];
  }
  
  // Check for duplicate (same start/end timestamp)
  const isDuplicate = store.artifacts[level].some(a => 
    a.startTimestamp === startTimestamp && a.endTimestamp === endTimestamp
  );
  if (isDuplicate) {
    console.log(`[store] Skipping duplicate artifact: ${startTimestamp} → ${endTimestamp}`);
    return null;
  }
  
  const artifact = {
    content,
    level,
    startTimestamp,
    endTimestamp,
    createdAt: new Date().toISOString()
  };
  
  // Optional metadata
  if (messageCount !== undefined) {
    artifact.messageCount = messageCount;
  }
  if (sourceLevel !== undefined) {
    artifact.sourceLevel = sourceLevel;
    artifact.artifactCount = artifactCount;
  }
  
  store.artifacts[level].push(artifact);
  return artifact;
}

/**
 * Get last summarized timestamp for target level
 * Returns null if no artifacts exist at target level
 */
function getLastSummarizedTimestamp(store, targetLevel) {
  const artifacts = store.artifacts[targetLevel];
  if (!artifacts || artifacts.length === 0) {
    return null;
  }
  
  // Find max endTimestamp among all artifacts at this level
  const timestamps = artifacts
    .filter(a => a.endTimestamp)
    .map(a => a.endTimestamp);
  
  if (timestamps.length === 0) {
    return null;
  }
  
  // Sort and return latest
  return timestamps.sort((a, b) => compareTimestamps(a, b))[timestamps.length - 1];
}

/**
 * Get unsummarized items from source level
 * sourceLevel=0 → messages, sourceLevel>0 → artifacts[sourceLevel]
 * Returns items with timestamp > lastSummarizedTimestamp of targetLevel
 * Also filters by config.startFromTimestamp if set (ignores old messages)
 */
function getUnsummarized(store, sourceLevel, agentId = null) {
  const config = loadConfig();
  const targetLevel = sourceLevel + 1;
  const lastTimestamp = getLastSummarizedTimestamp(store, targetLevel);
  const startFromTimestamp = config.startFromTimestamp || null;
  
  if (sourceLevel === 0) {
    // L0: filter messages by timestamp
    let messages = store.messages;
    
    // Filter by lastSummarized
    if (lastTimestamp) {
      messages = messages.filter(m => compareTimestamps(m.timestamp, lastTimestamp) > 0);
    }
    
    // Filter by startFromTimestamp (ignore old messages)
    if (startFromTimestamp) {
      messages = messages.filter(m => compareTimestamps(m.timestamp, startFromTimestamp) >= 0);
    }
    
    return messages;
  } else {
    // Ln: filter artifacts by endTimestamp
    const artifacts = store.artifacts[sourceLevel] || [];
    if (!lastTimestamp) {
      return artifacts; // All artifacts are unaggregated
    }
    return artifacts.filter(a => compareTimestamps(a.endTimestamp, lastTimestamp) > 0);
  }
}

/**
 * Filter messages for counting based on agent config
 * Applies exclude strings, patterns, and countRoles
 */
function filterForCounting(messages, agentConfig) {
  if (!agentConfig) return messages;
  
  const filters = { ...(agentConfig.filters || {}), ...normalizeClassFilters(agentConfig.filters || {}) };
  const exclude = filters.exclude || [];
  const excludePatterns = filters.excludePatterns || [];
  const countRoles = filters.countRoles || ['user', 'assistant'];
  
  return messages.filter(m => {
    // Check role
    if (!countRoles.includes(m.role)) return false;
    
    const content = normalizeText(m.content || '');
    if (!content) return false;
    const messageClass = m.messageClass || classifyMessage(m.role, content);
    if (!isClassIncludedForTarget(messageClass, filters, 'count')) return false;
    if (!commandAllowed(content, filters.commandAllowlist || [])) return false;
    
    // Check exclude strings
    for (const ex of exclude) {
      if (content.includes(ex)) return false;
    }
    
    // Check exclude patterns
    for (const pattern of excludePatterns) {
      try {
        if (new RegExp(pattern).test(content)) return false;
      } catch (e) {}
    }
    
    return true;
  });
}

function filterForContext(messages, agentConfig) {
  if (!agentConfig) return messages;

  const filters = { ...(agentConfig.filters || {}), ...normalizeClassFilters(agentConfig.filters || {}) };
  const exclude = filters.exclude || [];
  const excludePatterns = filters.excludePatterns || [];
  const storeRoles = filters.storeRoles || ['user', 'assistant'];

  return messages.filter((m) => {
    if (!storeRoles.includes(m.role)) return false;

    const content = normalizeText(m.content || '');
    if (!content) return false;

    const messageClass = m.messageClass || classifyMessage(m.role, content);
    if (!isClassIncludedForTarget(messageClass, filters, 'context')) return false;
    if (!commandAllowed(content, filters.commandAllowlist || [])) return false;

    for (const ex of exclude) {
      if (content.includes(ex)) return false;
    }

    for (const pattern of excludePatterns) {
      try {
        if (new RegExp(pattern).test(content)) return false;
      } catch (e) {}
    }

    return true;
  });
}

/**
 * Check if summarization is needed for source level
 * Returns {needed: boolean, items: [...]}
 */
function checkThreshold(store, sourceLevel, threshold, agentId = null) {
  const items = getUnsummarized(store, sourceLevel, agentId);
  
  // For L0, apply counting filters from agent config
  if (sourceLevel === 0 && agentId) {
    const agentConfig = loadAgentConfig(agentId);
    const countable = filterForCounting(items, agentConfig);
    return {
      needed: countable.length >= threshold,
      items,  // Return all items for summarization
      countable: countable.length  // Number that count toward threshold
    };
  }
  
  return {
    needed: items.length >= threshold,
    items
  };
}

/**
 * Get threshold for level from config
 */
function getThresholdForLevel(level) {
  const config = loadConfig();
  const key = `L${level}`;
  return config.thresholds[key] || config.thresholds.default || 3;
}

/**
 * Get messages directory path for agent
 */
function getMessagesDir(agentId) {
  const dataDir = getDataDir();
  const messagesDir = path.join(dataDir, agentId, 'messages');
  if (!fs.existsSync(messagesDir)) {
    fs.mkdirSync(messagesDir, { recursive: true });
  }
  return messagesDir;
}

/**
 * Get date string from timestamp (YYYY-MM-DD)
 */
function getDateFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

/**
 * Archive messages to daily files
 * Appends messages to messages/YYYY-MM-DD.jsonl
 */
function archiveMessages(agentId, messages) {
  if (!messages || messages.length === 0) return;
  
  const messagesDir = getMessagesDir(agentId);
  
  // Group messages by date
  const byDate = {};
  for (const msg of messages) {
    const date = getDateFromTimestamp(msg.timestamp);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(msg);
  }
  
  // Append to each daily file
  for (const [date, msgs] of Object.entries(byDate)) {
    const filePath = path.join(messagesDir, `${date}.jsonl`);
    const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.appendFileSync(filePath, lines, 'utf8');
  }
  
  return Object.keys(byDate).length; // Return number of files updated
}

/**
 * Get archived messages for a time range (for drill-down)
 * Reads from daily JSONL files
 */
function getArchivedMessages(agentId, startTimestamp, endTimestamp) {
  const messagesDir = getMessagesDir(agentId);
  
  // Determine which date files to read
  const startDate = getDateFromTimestamp(startTimestamp);
  const endDate = getDateFromTimestamp(endTimestamp);
  
  // Get all dates between start and end
  const dates = [];
  let current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }
  
  // Read messages from each file
  const messages = [];
  for (const date of dates) {
    const filePath = path.join(messagesDir, `${date}.jsonl`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(l => l);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          // Filter by exact timestamp range
          if (compareTimestamps(msg.timestamp, startTimestamp) >= 0 &&
              compareTimestamps(msg.timestamp, endTimestamp) <= 0) {
            messages.push(msg);
          }
        } catch (e) {
          // Skip invalid lines
        }
      }
    }
  }
  
  // Sort by timestamp
  messages.sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));
  return messages;
}

/**
 * Remove summarized messages from store
 * Keeps only messages after the given timestamp
 */
function removeSummarizedMessages(store, beforeTimestamp) {
  if (!store.messages) return 0;
  
  const before = store.messages.length;
  store.messages = store.messages.filter(m => 
    compareTimestamps(m.timestamp, beforeTimestamp) > 0
  );
  return before - store.messages.length;
}

module.exports = {
  loadStore,
  saveStore,
  addMessage,
  addArtifact,
  getUnsummarized,
  checkThreshold,
  filterForCounting,
  filterForContext,
  getLastSummarizedTimestamp,
  getThresholdForLevel,
  loadConfig,
  loadAgentConfig,
  saveAgentConfig,
  getDataDir,
  createEmptyStore,
  compareTimestamps,
  formatTimestamp,
  // New functions for daily archive
  archiveMessages,
  getArchivedMessages,
  removeSummarizedMessages,
  getMessagesDir,
  // Constants
  DEFAULT_AGENT_CONFIG
};
