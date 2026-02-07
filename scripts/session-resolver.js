const fs = require('fs');
const path = require('path');

const { OpenClawClient } = require('./gateway-client');
const {
  getAgentKind,
  getGatewayCandidateKeys,
  getLookupSessionDirs,
  getFallbackSessionDirs
} = require('./session-policy');

function toEpoch(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function getCandidateKeys(agentId, isSubagent) {
  return getGatewayCandidateKeys(agentId, getAgentKind(agentId, isSubagent));
}

function chooseGatewaySession(sessions, candidateKeys) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  const keyPriority = new Map(candidateKeys.map((k, i) => [k, i]));

  const matched = sessions
    .filter((s) => s && keyPriority.has(s.key) && s.sessionId)
    .sort((a, b) => {
      const p1 = keyPriority.get(a.key);
      const p2 = keyPriority.get(b.key);
      if (p1 !== p2) return p1 - p2;
      return toEpoch(b.updatedAt) - toEpoch(a.updatedAt);
    });

  if (matched.length === 0) return null;
  return {
    sessionKey: matched[0].key,
    sessionId: matched[0].sessionId
  };
}

function findSessionPathById(sessionId, sessionDirs) {
  for (const dir of sessionDirs) {
    const fullPath = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function pickNewestSessionFile(sessionDirs) {
  const files = [];
  for (const dir of sessionDirs) {
    if (!fs.existsSync(dir)) continue;
    const dirFiles = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return {
          sessionId: f.replace('.jsonl', ''),
          jsonlPath: fullPath,
          mtime: stat.mtime.getTime()
        };
      });
    files.push(...dirFiles);
  }

  files.sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  return files[0];
}

function createGatewaySessionLister(clientFactory = () => new OpenClawClient()) {
  return async function listSessions() {
    const client = clientFactory();
    await client.connect();
    try {
      const result = await client.rpc('sessions.list', { limit: 200 });
      return result?.sessions || [];
    } finally {
      try {
        client.close();
      } catch (_e) {}
    }
  };
}

async function resolveActiveSession({
  agentId,
  isSubagent = false,
  openclawAgentsDir = path.join(process.env.HOME, '.openclaw', 'agents'),
  listSessions = null,
  logger = () => {}
}) {
  const kind = getAgentKind(agentId, isSubagent);
  const lookupDirs = getLookupSessionDirs(agentId, kind, openclawAgentsDir);
  const fallbackDirs = getFallbackSessionDirs(agentId, kind, openclawAgentsDir);
  const candidateKeys = getGatewayCandidateKeys(agentId, kind);

  if (kind === 'subagent' && typeof listSessions !== 'function') {
    throw new Error(`Gateway lookup is required for subagent ${agentId}`);
  }

  if (typeof listSessions === 'function') {
    try {
      const sessions = await listSessions();
      const gatewayChoice = chooseGatewaySession(sessions, candidateKeys);
      if (gatewayChoice) {
        const jsonlPath = findSessionPathById(gatewayChoice.sessionId, lookupDirs);
        if (jsonlPath) {
          return {
            ...gatewayChoice,
            jsonlPath,
            source: 'gateway'
          };
        }
        logger(`Gateway session found but JSONL missing: ${gatewayChoice.sessionId}`);
      }
      if (kind === 'subagent') {
        throw new Error(`No gateway session found for subagent: ${agentId}`);
      }
    } catch (err) {
      if (kind === 'subagent') {
        throw new Error(`Gateway lookup is required for subagent ${agentId}: ${err.message}`);
      }
      logger(`Gateway lookup failed (${err.message}), falling back to file mtime`);
    }
  }

  const newest = pickNewestSessionFile(fallbackDirs);
  if (!newest) {
    throw new Error(`No JSONL files found for agent=${agentId}`);
  }

  return {
    sessionKey: null,
    sessionId: newest.sessionId,
    jsonlPath: newest.jsonlPath,
    source: 'file-mtime'
  };
}

module.exports = {
  resolveActiveSession,
  createGatewaySessionLister,
  getCandidateKeys,
  chooseGatewaySession
};
