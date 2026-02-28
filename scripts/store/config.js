const fs = require('fs');
const path = require('path');
const { DEFAULT_CLASS_FILTERS } = require('../message-classifier');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

const DEFAULT_AGENT_CONFIG = {
  thresholds: { L1: 60, default: 5 },
  prompts: {
    l1: 'Summarize the following conversation into a concise memory artifact. Focus on: decisions made, problems solved, key insights, action items. Use markdown headers for structure. Be concise but complete.',
    aggregate: 'Aggregate these L{level} memory artifacts into a higher-level summary. Identify patterns, major themes, and important conclusions. Preserve key details while reducing redundancy.'
  },
  filters: {
    exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
    excludePatterns: [],
    countRoles: ['user', 'assistant'],
    storeRoles: ['user', 'assistant'],
    ...DEFAULT_CLASS_FILTERS
  },
  autoInjectContext: {
    enabled: false,
    onNewSession: false,
    onCompaction: false,
    preText: '',
    postText: '',
    preMdFiles: [],
    postMdFiles: []
  },
  autoCompact: {
    enabled: false,
    messageThreshold: 150,
    postCompactMessage: '',
    retries: 5,
    retryDelayMs: 3000
  }
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return {
    thresholds: { L1: 60, default: 5 },
    contextOverlap: 1,
    includeTimestamps: true,
    dataDir: './data',
    autoCompact: {
      postCompactMessage: ''
    }
  };
}

function getDataDir() {
  if (process.env.HM_DATA_DIR) {
    return path.resolve(process.env.HM_DATA_DIR);
  }
  const config = loadConfig();
  return path.resolve(path.dirname(CONFIG_PATH), config.dataDir);
}

function getAgentDir(agentId) {
  const dataDir = getDataDir();
  const agentDir = path.join(dataDir, agentId);
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  return agentDir;
}

function getStorePath(agentId) {
  return path.join(getAgentDir(agentId), 'store.json');
}

function getArtifactsRootDir(agentId) {
  return path.join(getAgentDir(agentId), 'artifacts');
}

function getArtifactsIndexPath(agentId) {
  return path.join(getAgentDir(agentId), 'artifacts-index.json');
}

function loadAgentConfig(agentId) {
  const globalConfig = loadConfig();
  const globalAutoCompact =
    globalConfig && typeof globalConfig.autoCompact === 'object' && globalConfig.autoCompact
      ? globalConfig.autoCompact
      : {};

  const configPath = path.join(getAgentDir(agentId), 'config.json');
  let agentConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`Failed to load agent config for ${agentId}:`, e.message);
    }
  }

  return {
    thresholds: { ...DEFAULT_AGENT_CONFIG.thresholds, ...agentConfig.thresholds },
    prompts: { ...DEFAULT_AGENT_CONFIG.prompts, ...agentConfig.prompts },
    filters: { ...DEFAULT_AGENT_CONFIG.filters, ...agentConfig.filters },
    autoInjectContext: { ...DEFAULT_AGENT_CONFIG.autoInjectContext, ...agentConfig.autoInjectContext },
    autoCompact: { ...DEFAULT_AGENT_CONFIG.autoCompact, ...globalAutoCompact, ...agentConfig.autoCompact }
  };
}

function saveAgentConfig(agentId, config) {
  const configPath = path.join(getAgentDir(agentId), 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = {
  DEFAULT_AGENT_CONFIG,
  loadConfig,
  loadAgentConfig,
  saveAgentConfig,
  getDataDir,
  getStorePath,
  getArtifactsRootDir,
  getArtifactsIndexPath
};
