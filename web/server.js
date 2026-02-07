const express = require('express');
const { WebSocketServer } = require('ws');
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

// Import store API
const store = require('../scripts/store');
const { extractContent } = require('../scripts/message-parser');
const { OpenClawClient } = require('../scripts/gateway-client');
const { resolveActiveSession, createGatewaySessionLister } = require('../scripts/session-resolver');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const app = express();
const PORT = parseInt(process.env.PORT || '3458', 10);

// Paths
const BASE_DIR = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts');
const AGENTS_CONFIG_PATH = process.env.HM_AGENTS_CONFIG_PATH || path.join(BASE_DIR, 'agents.json');
const OPENCLAW_AGENTS_DIR = process.env.OPENCLAW_AGENTS_DIR || path.join(process.env.HOME, '.openclaw', 'agents');
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const listGatewaySessions = createGatewaySessionLister(() => new OpenClawClient(GATEWAY_URL));

// Process Manager - tracks running watchers
const runningWatchers = new Map(); // agentId -> { process, pid, startTime }

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// AGENTS CONFIG
// ============================================================

function loadAgentsConfig() {
  try {
    if (fsSync.existsSync(AGENTS_CONFIG_PATH)) {
      return JSON.parse(fsSync.readFileSync(AGENTS_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load agents config:', e.message);
  }
  return { agents: [] };
}

function saveAgentsConfig(config) {
  fsSync.writeFileSync(AGENTS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getAgentDataDir(agentId) {
  return path.join(store.getDataDir(), agentId);
}

function ensureAgentDataDir(agentId) {
  const dir = getAgentDataDir(agentId);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getLastSessionBindingPath(agentId) {
  return path.join(getAgentDataDir(agentId), 'last-session.json');
}

function saveLastSessionBinding(agentId, binding = {}) {
  ensureAgentDataDir(agentId);
  const payload = {
    sessionId: binding.sessionId || null,
    sessionKey: binding.sessionKey || null,
    jsonlPath: binding.jsonlPath || null,
    timestamp: Date.now()
  };
  fsSync.writeFileSync(getLastSessionBindingPath(agentId), JSON.stringify(payload, null, 2));
  return payload;
}

// ============================================================
// PROCESS MANAGER
// ============================================================

function startWatcher(agentId) {
  if (runningWatchers.has(agentId)) {
    console.log(`[PM] Watcher for ${agentId} already running`);
    return { success: false, message: 'Already running' };
  }

  ensureAgentDataDir(agentId);
  const logPath = path.join(getAgentDataDir(agentId), 'watch.log');
  const logStream = fsSync.createWriteStream(logPath, { flags: 'a' });

  const proc = spawn('node', ['watch.js', agentId], {
    cwd: SCRIPTS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('exit', (code) => {
    console.log(`[PM] Watcher ${agentId} exited with code ${code}`);
    runningWatchers.delete(agentId);
    logStream.end();
  });

  proc.on('error', (err) => {
    console.error(`[PM] Watcher ${agentId} error:`, err.message);
    runningWatchers.delete(agentId);
    logStream.end();
  });

  runningWatchers.set(agentId, {
    process: proc,
    pid: proc.pid,
    startTime: Date.now()
  });

  console.log(`[PM] Started watcher for ${agentId} (PID: ${proc.pid})`);
  return { success: true, pid: proc.pid };
}

function stopWatcher(agentId) {
  const watcher = runningWatchers.get(agentId);
  if (!watcher) {
    return { success: false, message: 'Not running' };
  }

  try {
    process.kill(watcher.pid, 'SIGTERM');
    runningWatchers.delete(agentId);
    console.log(`[PM] Stopped watcher for ${agentId}`);
    return { success: true };
  } catch (err) {
    console.error(`[PM] Failed to stop ${agentId}:`, err.message);
    runningWatchers.delete(agentId);
    return { success: false, message: err.message };
  }
}

function getWatcherStatus(agentId) {
  const watcher = runningWatchers.get(agentId);
  if (!watcher) {
    return { running: false };
  }

  const uptimeMs = Date.now() - watcher.startTime;
  const minutes = Math.floor(uptimeMs / 60000);
  const seconds = Math.floor((uptimeMs % 60000) / 1000);
  
  return {
    running: true,
    pid: watcher.pid,
    uptime: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  };
}

// Start enabled watchers on server startup
function initializeWatchers() {
  const config = loadAgentsConfig();
  for (const agent of config.agents) {
    if (agent.enabled) {
      console.log(`[PM] Auto-starting watcher for ${agent.id}`);
      startWatcher(agent.id);
    }
  }
}

// ============================================================
// API: AGENTS MANAGEMENT
// ============================================================

// GET /api/agents/available - list agents from OpenClaw
app.get('/api/agents/available', (req, res) => {
  try {
    if (!fsSync.existsSync(OPENCLAW_AGENTS_DIR)) {
      return res.json({ agents: [] });
    }
    
    const dirs = fsSync.readdirSync(OPENCLAW_AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    
    res.json({ agents: dirs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents - list all agents with status
app.get('/api/agents', (req, res) => {
  const config = loadAgentsConfig();
  const agents = config.agents.map(agent => {
    const status = getWatcherStatus(agent.id);
    
    // Get store stats
    let stats = { messages: 0, artifacts: {} };
    try {
      const s = store.loadStore(agent.id);
      stats.messages = s.messages?.length || 0;
      stats.artifacts = {
        L1: (s.artifacts?.[1] || []).length,
        L2: (s.artifacts?.[2] || []).length,
        L3: (s.artifacts?.[3] || []).length
      };
    } catch (e) {}

    return {
      ...agent,
      ...status,
      stats
    };
  });

  res.json({ agents });
});

// POST /api/agents - add new agent
app.post('/api/agents', (req, res) => {
  const { id, name, isSubagent } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Agent id required' });
  }

  const config = loadAgentsConfig();
  if (config.agents.find(a => a.id === id)) {
    return res.status(400).json({ error: 'Agent already exists' });
  }

  const newAgent = { 
    id, 
    name: name || id, 
    enabled: false,
    isSubagent: isSubagent || false
  };
  
  config.agents.push(newAgent);
  saveAgentsConfig(config);
  ensureAgentDataDir(id);

  res.json({ success: true, agent: newAgent });
});

// DELETE /api/agents/:id - remove agent
app.delete('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  
  // Stop watcher if running
  stopWatcher(id);

  const config = loadAgentsConfig();
  config.agents = config.agents.filter(a => a.id !== id);
  saveAgentsConfig(config);

  res.json({ success: true });
});

// POST /api/agents/:id/enable - enable agent memory
app.post('/api/agents/:id/enable', (req, res) => {
  const { id } = req.params;
  
  const config = loadAgentsConfig();
  const agent = config.agents.find(a => a.id === id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  agent.enabled = true;
  saveAgentsConfig(config);
  
  const result = startWatcher(id);
  res.json({ success: true, ...result });
});

// POST /api/agents/:id/disable - disable agent memory
app.post('/api/agents/:id/disable', (req, res) => {
  const { id } = req.params;
  
  const config = loadAgentsConfig();
  const agent = config.agents.find(a => a.id === id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  agent.enabled = false;
  saveAgentsConfig(config);
  
  const result = stopWatcher(id);
  res.json({ success: true, ...result });
});

// POST /api/agents/:id/session/sync - resolve active session via gateway and pin it
app.post('/api/agents/:id/session/sync', async (req, res) => {
  const { id } = req.params;
  const config = loadAgentsConfig();
  const agent = config.agents.find(a => a.id === id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const sessionInfo = await resolveActiveSession({
      agentId: id,
      isSubagent: agent.isSubagent || false,
      openclawAgentsDir: OPENCLAW_AGENTS_DIR,
      listSessions: listGatewaySessions,
      logger: (msg) => console.log(`[session-sync] ${id}: ${msg}`)
    });

    if (!sessionInfo || sessionInfo.source !== 'gateway') {
      console.warn(`[session-sync] agent=${id} source=${sessionInfo?.source || 'none'} result=rejected`);
      return res.status(502).json({ error: 'Failed to resolve active session from gateway' });
    }
    if (!sessionInfo.sessionId || !sessionInfo.jsonlPath) {
      return res.status(500).json({ error: 'Resolved session is incomplete' });
    }

    const binding = saveLastSessionBinding(id, sessionInfo);
    console.log(
      `[session-sync] agent=${id} source=${sessionInfo.source} sessionId=${sessionInfo.sessionId} sessionKey=${sessionInfo.sessionKey || 'N/A'}`
    );

    // Keep file-mtime path in sync for non-subagent resolver behavior.
    let touchedJsonl = false;
    if (fsSync.existsSync(sessionInfo.jsonlPath)) {
      const now = new Date();
      try {
        fsSync.utimesSync(sessionInfo.jsonlPath, now, now);
        touchedJsonl = true;
      } catch (_e) {}
    }

    let watcherRestarted = false;
    const wasRunning = runningWatchers.has(id);
    if (wasRunning) {
      stopWatcher(id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const restartResult = startWatcher(id);
      watcherRestarted = restartResult.success === true;
      if (!watcherRestarted) {
        return res.status(500).json({ error: `Session pinned but watcher restart failed: ${restartResult.message || 'unknown error'}` });
      }
    }

    res.json({
      success: true,
      session: {
        sessionId: sessionInfo.sessionId,
        sessionKey: sessionInfo.sessionKey || null,
        jsonlPath: sessionInfo.jsonlPath
      },
      source: sessionInfo.source,
      binding,
      watcherRestarted,
      touchedJsonl
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/session/active - resolve active session for selected agent
app.get('/api/agents/:id/session/active', async (req, res) => {
  const { id } = req.params;
  const config = loadAgentsConfig();
  const agent = config.agents.find(a => a.id === id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const sessionInfo = await resolveActiveSession({
      agentId: id,
      isSubagent: agent.isSubagent || false,
      openclawAgentsDir: OPENCLAW_AGENTS_DIR,
      listSessions: listGatewaySessions,
      logger: (msg) => console.log(`[session-active] ${id}: ${msg}`)
    });
    console.log(
      `[session-active] agent=${id} source=${sessionInfo?.source || 'none'} sessionId=${sessionInfo?.sessionId || 'N/A'} sessionKey=${sessionInfo?.sessionKey || 'N/A'}`
    );

    res.json({
      agentId: id,
      sessionId: sessionInfo?.sessionId || null,
      sessionKey: sessionInfo?.sessionKey || null,
      jsonlPath: sessionInfo?.jsonlPath || null,
      source: sessionInfo?.source || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// API: AGENT DATA (with agentId parameter)
// ============================================================

// GET /api/agents/:id/status
app.get('/api/agents/:id/status', (req, res) => {
  const { id } = req.params;
  const status = getWatcherStatus(id);
  res.json({ agentId: id, ...status });
});

// Helper: count messages in active JSONL session (with filters)
async function getSessionMessageCount(agentId) {
  try {
    const config = loadAgentsConfig();
    const agent = config.agents.find(a => a.id === agentId);
    const isSubagentMode = agent?.isSubagent || false;

    const sessionInfo = await resolveActiveSession({
      agentId,
      isSubagent: isSubagentMode,
      openclawAgentsDir: OPENCLAW_AGENTS_DIR,
      listSessions: listGatewaySessions,
      logger: (msg) => console.log(`[session-resolver] ${agentId}: ${msg}`)
    });
    console.log(
      `[session-count] agent=${agentId} source=${sessionInfo?.source || 'none'} sessionId=${sessionInfo?.sessionId || 'N/A'}`
    );
    const jsonlPath = sessionInfo?.jsonlPath;
    if (!jsonlPath || !fsSync.existsSync(jsonlPath)) return 0;

    const content = await fs.readFile(jsonlPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    
    // Load agent config for filters
    const agentConfig = store.loadAgentConfig(agentId);
    const countRoles = agentConfig.filters?.countRoles || ['user', 'assistant'];
    const excludePatterns = agentConfig.filters?.excludePatterns || [];
    const exclude = agentConfig.filters?.exclude || [];
    
    // Find last compaction event - count only messages after it
    let lastCompactionIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        if (data.type === 'compaction') {
          lastCompactionIndex = i;
          break;
        }
      } catch (e) {}
    }
    
    // Start counting after last compaction (or from beginning if no compaction)
    const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
    
    // Count messages that match countRoles and pass filters
    let count = 0;
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      try {
        const data = JSON.parse(line);
        if (data.type !== 'message') continue;
        
        const msg = data.message || data;
        const role = msg.role;
        
        // Check if role should be counted
        if (!countRoles.includes(role)) continue;
        
        // Extract content
        const content = extractContent(msg.content);
        
        if (!content) continue;
        
        // Apply exclude filters
        let excluded = false;
        for (const excludeStr of exclude) {
          if (content.includes(excludeStr)) {
            excluded = true;
            break;
          }
        }
        if (excluded) continue;
        
        // Apply exclude patterns
        for (const pattern of excludePatterns) {
          try {
            if (new RegExp(pattern).test(content)) {
              excluded = true;
              break;
            }
          } catch (e) {}
        }
        if (excluded) continue;
        
        count++;
      } catch (e) {}
    }
    return count;
  } catch (e) {
    console.error('Error counting session messages:', e.message);
    return 0;
  }
}

function handleAgentStatus(res, agentId, options = {}) {
  const status = getWatcherStatus(agentId);
  const payload = { agentId, ...status };
  if (options.includeLegacySession) {
    payload.sessionId = null;
  }
  res.json(payload);
}

async function handleAgentStats(res, agentId, options = {}) {
  const legacy = options.legacy === true;
  const s = store.loadStore(agentId);
  const agentConfig = store.loadAgentConfig(agentId);
  const threshold = agentConfig.thresholds?.L1 || 60;

  const unsummarizedItems = store.getUnsummarized(s, 0, agentId);
  const countable = store.filterForCounting(unsummarizedItems, agentConfig);
  const unsummarized = legacy ? (s.messages?.length || 0) : countable.length;

  const payload = {
    messagesCount: s.messages?.length || 0,
    artifacts: {
      L1: (s.artifacts?.[1] || []).length,
      L2: (s.artifacts?.[2] || []).length,
      L3: (s.artifacts?.[3] || []).length
    },
    threshold,
    unsummarized,
    progress: Math.min(1, unsummarized / threshold)
  };

  if (!legacy) {
    const sessionMessageCount = await getSessionMessageCount(agentId);
    const compactThreshold = agentConfig.autoCompact?.messageThreshold || 150;
    payload.sessionMessageCount = sessionMessageCount;
    payload.compactThreshold = compactThreshold;
    payload.compactProgress = Math.min(1, sessionMessageCount / compactThreshold);
  }

  res.json(payload);
}

function handleAgentStore(res, agentId) {
  const s = store.loadStore(agentId);
  const recentMessages = (s.messages || []).slice(-20);

  res.json({
    artifacts: {
      L1: s.artifacts?.[1] || [],
      L2: s.artifacts?.[2] || [],
      L3: s.artifacts?.[3] || []
    },
    recentMessages
  });
}

async function handleAgentContext(res, agentId) {
  const contextPath = path.join(getAgentDataDir(agentId), 'CONTEXT.md');
  try {
    const content = await fs.readFile(contextPath, 'utf8');
    const sections = parseContextSections(content);
    res.json({ content, sections });
  } catch (_e) {
    res.json({ content: '', sections: [] });
  }
}

async function handleAgentLogs(req, res, agentId) {
  const logPath = path.join(getAgentDataDir(agentId), 'watch.log');
  const lines = parseInt(req.query.lines) || 50;
  try {
    const content = await fs.readFile(logPath, 'utf8');
    const allLines = content.split('\n');
    res.json({ logs: allLines.slice(-lines) });
  } catch (_e) {
    res.json({ logs: [] });
  }
}

function handleArtifactDrilldown(res, agentId, level, index) {
  const levelNum = parseInt(level);
  const indexNum = parseInt(index);

  const s = store.loadStore(agentId);
  const levelArtifacts = s.artifacts?.[String(levelNum)] || [];

  if (indexNum < 0 || indexNum >= levelArtifacts.length) {
    return res.status(404).json({ error: 'Artifact not found' });
  }

  const artifact = levelArtifacts[indexNum];
  if (levelNum === 1) {
    const messages = store.getArchivedMessages(agentId, artifact.startTimestamp, artifact.endTimestamp);
    return res.json({ artifact, messages, source: 'archive' });
  }

  const sourceLevel = levelNum - 1;
  const sourceArtifacts = (s.artifacts?.[String(sourceLevel)] || []).filter(a =>
    new Date(a.endTimestamp) >= new Date(artifact.startTimestamp) &&
    new Date(a.startTimestamp) <= new Date(artifact.endTimestamp)
  );
  return res.json({ artifact, sourceArtifacts, source: `L${sourceLevel}` });
}

// GET /api/agents/:id/stats
app.get('/api/agents/:id/stats', async (req, res) => {
  const { id } = req.params;
  try {
    await handleAgentStats(res, id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/store
app.get('/api/agents/:id/store', (req, res) => {
  const { id } = req.params;
  try {
    handleAgentStore(res, id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/context
app.get('/api/agents/:id/context', async (req, res) => {
  const { id } = req.params;
  try {
    await handleAgentContext(res, id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/agents/:id/context/rebuild - regenerate CONTEXT.md for agent
app.post('/api/agents/:id/context/rebuild', async (req, res) => {
  const { id } = req.params;
  const config = loadAgentsConfig();
  const agent = config.agents.find(a => a.id === id);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    ensureAgentDataDir(id);
    const contextPath = path.join(getAgentDataDir(id), 'CONTEXT.md');
    const contextScript = path.join(SCRIPTS_DIR, 'context.js');

    await execFileAsync('node', [contextScript, 'generate', id, '--output', contextPath], {
      cwd: SCRIPTS_DIR
    });

    const content = await fs.readFile(contextPath, 'utf8');
    const sections = parseContextSections(content);
    res.json({
      success: true,
      contextPath,
      sections,
      generatedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/logs
app.get('/api/agents/:id/logs', async (req, res) => {
  const { id } = req.params;
  try {
    await handleAgentLogs(req, res, id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/config - get agent configuration
app.get('/api/agents/:id/config', (req, res) => {
  const { id } = req.params;
  try {
    const config = store.loadAgentConfig(id);
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/agents/:id/config - update agent configuration
app.put('/api/agents/:id/config', (req, res) => {
  const { id } = req.params;
  const config = req.body;
  
  try {
    // Validate config structure
    if (config.thresholds && typeof config.thresholds !== 'object') {
      return res.status(400).json({ error: 'thresholds must be an object' });
    }
    if (config.prompts && typeof config.prompts !== 'object') {
      return res.status(400).json({ error: 'prompts must be an object' });
    }
    if (config.filters && typeof config.filters !== 'object') {
      return res.status(400).json({ error: 'filters must be an object' });
    }
    
    store.saveAgentConfig(id, config);
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/messages/:date - get archived messages for a specific date
app.get('/api/agents/:id/messages/:date', (req, res) => {
  const { id, date } = req.params;
  
  // Validate date format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  
  try {
    const startTimestamp = `${date}T00:00:00.000Z`;
    const endTimestamp = `${date}T23:59:59.999Z`;
    const messages = store.getArchivedMessages(id, startTimestamp, endTimestamp);
    
    res.json({ date, messages, count: messages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/agents/:id/messages-dates - list available message dates
app.get('/api/agents/:id/messages-dates', (req, res) => {
  const { id } = req.params;
  
  try {
    const messagesDir = store.getMessagesDir(id);
    const files = fsSync.readdirSync(messagesDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse(); // Most recent first
    
    res.json({ dates: files });
  } catch (e) {
    // No messages directory yet
    res.json({ dates: [] });
  }
});

// GET /api/agents/:id/artifact/:level/:index/messages - drill-down
app.get('/api/agents/:id/artifact/:level/:index/messages', (req, res) => {
  const { id, level, index } = req.params;
  try {
    handleArtifactDrilldown(res, id, level, index);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// LEGACY API (backwards compatibility, uses 'main' agent)
// ============================================================

app.get('/api/status', (req, res) => {
  handleAgentStatus(res, 'main', { includeLegacySession: true });
});

app.get('/api/stats', async (req, res) => {
  try {
    await handleAgentStats(res, 'main', { legacy: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/store', (req, res) => {
  try {
    handleAgentStore(res, 'main');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/context', async (req, res) => {
  try {
    await handleAgentContext(res, 'main');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    await handleAgentLogs(req, res, 'main');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/artifact/:level/:index/messages', (req, res) => {
  try {
    const { level, index } = req.params;
    handleArtifactDrilldown(res, 'main', level, index);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/control', async (req, res) => {
  const { action } = req.body;
  
  if (action === 'start') {
    const result = startWatcher('main');
    res.json(result);
  } else if (action === 'stop') {
    const result = stopWatcher('main');
    res.json(result);
  } else if (action === 'restart') {
    stopWatcher('main');
    await new Promise(r => setTimeout(r, 1000));
    const result = startWatcher('main');
    res.json(result);
  } else {
    res.status(400).json({ error: 'Invalid action' });
  }
});

// ============================================================
// HELPERS
// ============================================================

function parseContextSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentSection = null;
  let inArtifact = false;

  for (const line of lines) {
    // Detect main sections: ## MEMORY or ## RECENT
    if (line.startsWith('## MEMORY') || line.startsWith('## RECENT')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { title: line.substring(3).trim(), content: '' };
      inArtifact = false;
    } 
    // Artifact headers start with ### and timestamp pattern
    else if (line.startsWith('### ') && line.includes('→') && currentSection) {
      inArtifact = true;
      currentSection.content += line + '\n';
    }
    // Other ## inside artifacts are just content
    else if (currentSection) {
      currentSection.content += line + '\n';
    }
  }
  if (currentSection) sections.push(currentSection);
  return sections;
}

// ============================================================
// WEBSOCKET FOR LOGS
// ============================================================

const server = app.listen(PORT, () => {
  console.log(`\n🧠 Hierarchical Memory Server`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/agents\n`);
  
  // Initialize watchers for enabled agents
  initializeWatchers();
});

const wss = new WebSocketServer({ server, path: '/ws/logs' });

wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected');
  
  // Default to first configured agent in multi-agent/demo mode.
  const initialAgentId = (() => {
    const config = loadAgentsConfig();
    const first = Array.isArray(config.agents) && config.agents[0] ? config.agents[0].id : null;
    return first || 'main';
  })();
  let agentId = initialAgentId;
  let tail = null;

  function startTail(id) {
    if (tail) {
      tail.unwatch();
    }
    
    const logPath = path.join(getAgentDataDir(id), 'watch.log');
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    if (!fsSync.existsSync(logPath)) {
      fsSync.writeFileSync(logPath, '');
    }

    try {
      const Tail = require('tail').Tail;
      tail = new Tail(logPath, { follow: true, fromBeginning: false });
      tail.on('line', (line) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'log', line }));
        }
      });
      tail.on('error', (err) => {
        console.error('Tail error:', err);
      });
    } catch (e) {
      console.error('Failed to start tail:', e.message);
    }
  }

  startTail(agentId);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.agentId && msg.agentId !== agentId) {
        agentId = msg.agentId;
        startTail(agentId);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    if (tail) tail.unwatch();
  });
});

// Cleanup on exit
process.on('SIGTERM', () => {
  console.log('\n[PM] Shutting down...');
  for (const [agentId] of runningWatchers) {
    stopWatcher(agentId);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[PM] Shutting down...');
  for (const [agentId] of runningWatchers) {
    stopWatcher(agentId);
  }
  process.exit(0);
});
