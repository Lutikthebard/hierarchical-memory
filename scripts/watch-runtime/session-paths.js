function createSessionPathHelpers({
  fs,
  path,
  agentsConfigPath,
  openclawDir,
  getAgentKind,
  getWatchSessionDirs
}) {
  function loadAgentsConfigFile() {
    try {
      if (fs.existsSync(agentsConfigPath)) {
        return JSON.parse(fs.readFileSync(agentsConfigPath, 'utf8'));
      }
    } catch (e) {
      console.error('Failed to load agents.json:', e.message);
    }
    return { agents: [] };
  }

  function isSubagent(agentId) {
    const config = loadAgentsConfigFile();
    const agent = config.agents.find((a) => a.id === agentId);
    return agent?.isSubagent || false;
  }

  function getSessionsDir(agentId) {
    const kind = getAgentKind(agentId, isSubagent(agentId));
    const dirs = getWatchSessionDirs(agentId, kind, path.join(openclawDir, 'agents'));
    return dirs[0] || path.join(openclawDir, 'agents', agentId, 'sessions');
  }

  function getSessionDirsForAgent(agentId) {
    const kind = getAgentKind(agentId, isSubagent(agentId));
    return getWatchSessionDirs(agentId, kind, path.join(openclawDir, 'agents'));
  }

  function findSessionPathInDirs(sessionId, dirs) {
    for (const dir of dirs) {
      const candidate = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  return {
    loadAgentsConfigFile,
    isSubagent,
    getSessionsDir,
    getSessionDirsForAgent,
    findSessionPathInDirs
  };
}

module.exports = {
  createSessionPathHelpers
};
