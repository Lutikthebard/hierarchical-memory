async function resolveActionSession({
  agentId,
  isSubagentMode,
  openclawAgentsDir,
  listGatewaySessions,
  resolveActiveSession,
  loadLastSessionBinding,
  saveLastSessionBinding,
  dataDir,
  logger = () => {}
}) {
  const listSessions = isSubagentMode ? listGatewaySessions : null;
  const sessionInfo = await resolveActiveSession({
    agentId,
    isSubagent: isSubagentMode,
    openclawAgentsDir,
    listSessions,
    logger: (msg) => logger(`[session-action] ${agentId}: ${msg}`)
  });

  const pinned = loadLastSessionBinding(agentId, dataDir);
  const sessionId = sessionInfo?.sessionId || pinned.sessionId || null;
  const jsonlPath = sessionInfo?.jsonlPath || pinned.jsonlPath || null;
  const sessionKey = sessionInfo?.sessionKey || pinned.sessionKey || (isSubagentMode ? null : `agent:${agentId}:main`);

  if (!sessionKey) {
    throw new Error(`No session key resolved for ${agentId}`);
  }

  saveLastSessionBinding(agentId, dataDir, { sessionId, sessionKey, jsonlPath });
  return { sessionId, sessionKey, jsonlPath };
}

module.exports = {
  resolveActionSession
};
