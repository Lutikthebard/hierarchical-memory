const fs = require('fs');
const path = require('path');

function getLastSessionBindingPath(agentId, dataDir) {
  return path.join(dataDir, agentId, 'last-session.json');
}

function normalizeBinding(data) {
  if (typeof data === 'string') {
    return {
      sessionId: data || null,
      sessionKey: null,
      jsonlPath: null,
      timestamp: null
    };
  }

  if (!data || typeof data !== 'object') {
    return {};
  }

  return {
    sessionId: data.sessionId || null,
    sessionKey: data.sessionKey || null,
    jsonlPath: data.jsonlPath || null,
    timestamp: data.timestamp || null
  };
}

function loadLastSessionBinding(agentId, dataDir) {
  const bindingPath = getLastSessionBindingPath(agentId, dataDir);
  if (!fs.existsSync(bindingPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    return normalizeBinding(parsed);
  } catch (_e) {
    return {};
  }
}

function saveLastSessionBinding(agentId, dataDir, binding = {}) {
  try {
    const bindingPath = getLastSessionBindingPath(agentId, dataDir);
    fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
    const payload = {
      sessionId: binding.sessionId || null,
      sessionKey: binding.sessionKey || null,
      jsonlPath: binding.jsonlPath || null,
      timestamp: Date.now()
    };
    fs.writeFileSync(bindingPath, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  getLastSessionBindingPath,
  loadLastSessionBinding,
  saveLastSessionBinding
};
