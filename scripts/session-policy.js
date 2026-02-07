const path = require('path');

function uniqueDirs(dirs) {
  return dirs.filter((d, i, arr) => d && arr.indexOf(d) === i);
}

function getAgentKind(agentId, isSubagent) {
  if (agentId === 'main') return 'main';
  return isSubagent ? 'subagent' : 'agent';
}

function getGatewayCandidateKeys(agentId, kind) {
  if (kind === 'subagent') {
    return [
      `agent:${agentId}`,
      `agent:${agentId}:main`
    ];
  }
  return [
    `agent:${agentId}:main`,
    `agent:${agentId}`
  ];
}

function getLookupSessionDirs(agentId, kind, openclawAgentsDir) {
  const directDir = path.join(openclawAgentsDir, agentId, 'sessions');
  const mainDir = path.join(openclawAgentsDir, 'main', 'sessions');
  if (kind === 'main') return [mainDir];
  if (kind === 'subagent') return uniqueDirs([mainDir, directDir]);
  // Regular agents usually keep own sessions; include main as secondary
  // for cases where gateway points to a moved/copied JSONL file.
  return uniqueDirs([directDir, mainDir]);
}

function getFallbackSessionDirs(agentId, kind, openclawAgentsDir) {
  const directDir = path.join(openclawAgentsDir, agentId, 'sessions');
  const mainDir = path.join(openclawAgentsDir, 'main', 'sessions');
  if (kind === 'main') return [mainDir];
  // No fallback to main for non-main agents.
  return [directDir];
}

function getWatchSessionDirs(agentId, kind, openclawAgentsDir) {
  const directDir = path.join(openclawAgentsDir, agentId, 'sessions');
  const mainDir = path.join(openclawAgentsDir, 'main', 'sessions');
  if (kind === 'main') return [mainDir];
  if (kind === 'subagent') return uniqueDirs([mainDir, directDir]);
  return [directDir];
}

module.exports = {
  getAgentKind,
  getGatewayCandidateKeys,
  getLookupSessionDirs,
  getFallbackSessionDirs,
  getWatchSessionDirs
};
