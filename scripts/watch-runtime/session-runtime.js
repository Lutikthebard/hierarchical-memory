function createSessionRuntime(deps) {
  const {
    state,
    fs,
    path,
    openclawDir,
    listGatewaySessions,
    isSubagent,
    isSessionKeyForAgent,
    getSessionDirsForAgent,
    findSessionPathInDirs,
    getSessionsDir,
    getLookupSessionDirs,
    getAgentKind,
    resolveActiveSession,
    loadLastSessionBinding,
    saveLastSessionBinding,
    getDataDir,
    loadStore,
    loadAgentConfig,
    processExistingFile,
    refreshSessionCounterFromJsonl,
    getContextPath,
    execSync,
    scheduleContextInject,
    watchFile,
    logger = console
  } = deps;

  async function getActiveSession(agentId, options = {}) {
    const info = await getActiveSessionInfo(agentId, options);
    return info.sessionId;
  }

  async function getActiveSessionInfo(agentId, options = {}) {
    const quiet = options.quiet || false;
    const subagent = isSubagent(agentId);
    const openclawAgentsDir = options.openclawAgentsDir || path.join(openclawDir, 'agents');
    const listSessions = Object.prototype.hasOwnProperty.call(options, 'listSessions')
      ? options.listSessions
      : listGatewaySessions;
    const localLog = (msg) => {
      if (!quiet) {
        logger.log(`⚠️ ${msg}`);
      }
    };
    let info;

    try {
      info = await resolveActiveSession({
        agentId,
        isSubagent: subagent,
        openclawAgentsDir,
        listSessions,
        logger: localLog
      });
    } catch (err) {
      if (!subagent) throw err;
      const pinned = loadLastSessionBinding(agentId, getDataDir());
      const sessionDirs = getLookupSessionDirs(agentId, getAgentKind(agentId, subagent), openclawAgentsDir);
      const pinnedPath = pinned.jsonlPath && fs.existsSync(pinned.jsonlPath)
        ? pinned.jsonlPath
        : (pinned.sessionId ? findSessionPathInDirs(pinned.sessionId, sessionDirs) : null);
      if (!pinned.sessionId || !pinned.sessionKey || !pinnedPath) {
        throw err;
      }
      localLog(`Gateway unavailable for ${agentId}; using pinned session ${pinned.sessionId}`);
      info = {
        sessionId: pinned.sessionId,
        sessionKey: pinned.sessionKey,
        jsonlPath: pinnedPath,
        source: 'pinned-cache'
      };
    }

    if (info.sessionId && info.sessionKey) {
      saveLastSessionBinding(agentId, getDataDir(), {
        sessionId: info.sessionId,
        sessionKey: info.sessionKey,
        jsonlPath: info.jsonlPath
      });
    }

    if (!quiet) {
      logger.log(`🔍 Auto-detected session (${info.source})`);
      logger.log(`   Session ID: ${info.sessionId}`);
      logger.log(`   Session Key: ${info.sessionKey || 'N/A (file fallback)'}`);
      logger.log(`   JSONL: ${info.jsonlPath}`);
    }

    return info;
  }

  async function switchToSession(agentId, newSessionId, storeRef, resolvedInfo = null) {
    logger.log(`\n🔄 SESSION CHANGE DETECTED!`);
    logger.log(`   Old: ${state.currentSessionId}`);
    logger.log(`   New: ${newSessionId}`);

    if (state.currentTailProcess) {
      logger.log(`   Stopping old watcher...`);
      state.currentTailProcess.kill();
    }

    state.currentSessionId = newSessionId;
    state.currentSessionKey = resolvedInfo?.sessionKey || null;
    const resolvedSource = resolvedInfo?.source || 'unknown';
    const sessionDirs = getSessionDirsForAgent(agentId);
    const fallbackPath = findSessionPathInDirs(newSessionId, sessionDirs);
    const newJsonlPath = resolvedInfo?.jsonlPath || fallbackPath || path.join(getSessionsDir(agentId), `${newSessionId}.jsonl`);
    state.currentJsonlPath = newJsonlPath;

    if (!state.currentSessionKey) {
      try {
        const resolved = await getActiveSessionInfo(agentId, {
          quiet: true,
          listSessions: isSubagent(agentId) ? listGatewaySessions : null
        });
        if (resolved.sessionId === newSessionId && resolved.sessionKey) {
          state.currentSessionKey = resolved.sessionKey;
        }
      } catch (_e) {}
    }

    if (isSubagent(agentId) && !state.currentSessionKey) {
      const pinned = loadLastSessionBinding(agentId, getDataDir());
      if (pinned.sessionId === newSessionId && pinned.sessionKey) {
        state.currentSessionKey = pinned.sessionKey;
      } else {
        throw new Error(`Subagent ${agentId} has no session key for session ${newSessionId}`);
      }
    }

    if (isSubagent(agentId) && !isSessionKeyForAgent(agentId, state.currentSessionKey)) {
      throw new Error(`Subagent ${agentId} resolved invalid session key: ${state.currentSessionKey || 'N/A'}`);
    }

    saveLastSessionBinding(agentId, getDataDir(), {
      sessionId: newSessionId,
      sessionKey: state.currentSessionKey,
      jsonlPath: newJsonlPath
    });
    logger.log(`   Session binding: source=${resolvedSource}, key=${state.currentSessionKey || 'N/A'}`);

    storeRef.current = loadStore(agentId);
    state.currentStoreRef = storeRef;
    const artifactCount = Object.values(storeRef.current.artifacts || {}).reduce((sum, arr) => sum + (arr?.length || 0), 0);
    logger.log(`   Loaded store: ${storeRef.current.messages.length} messages, ${artifactCount} artifacts`);

    logger.log(`   Reading existing messages from new JSONL...`);
    const added = await processExistingFile(agentId, storeRef, newJsonlPath);
    logger.log(`   Added ${added} new messages (total: ${storeRef.current.messages.length})`);
    const cfgForCounter = loadAgentConfig(agentId);
    const syncedCount = refreshSessionCounterFromJsonl(newJsonlPath, cfgForCounter);
    logger.log(`   Synced autoCompact counter from JSONL: ${syncedCount}`);

    logger.log(`   Regenerating CONTEXT.md...`);
    const scriptDir = __dirname + '/..';
    const contextPath = getContextPath(agentId);
    try {
      execSync(`node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`, { stdio: 'pipe' });
    } catch (err) {
      logger.error(`   Failed to generate CONTEXT.md:`, err.message);
    }

    saveLastSessionBinding(agentId, getDataDir(), { sessionId: newSessionId });

    const agentConfig = loadAgentConfig(agentId);
    const autoInject = agentConfig.autoInjectContext || {};
    if (autoInject.enabled && autoInject.onNewSession) {
      logger.log(`   Scheduling context injection...`);
      scheduleContextInject(agentId, 'new session', 3000);
    }

    watchFile(agentId, storeRef, newJsonlPath, { skipSignalHandler: true });
    logger.log(`   ✅ Switched to new session\n`);
  }

  function watchSessionDirectory(agentId, storeRef) {
    const subagent = isSubagent(agentId);
    const sessionDirs = getSessionDirsForAgent(agentId).filter((d, i, arr) => arr.indexOf(d) === i);
    const existingDirs = sessionDirs.filter((d) => fs.existsSync(d));

    if (existingDirs.length === 0) {
      logger.log(`⚠️  Sessions directory not found for ${agentId}`);
      return;
    }

    logger.log(`\n👁️  Watching session dirs for ${agentId}: ${existingDirs.join(', ')}`);

    let checkTimeout = null;

    const checkForNewSession = async () => {
      if (checkTimeout) clearTimeout(checkTimeout);

      checkTimeout = setTimeout(async () => {
        try {
          const active = await getActiveSessionInfo(agentId, {
            quiet: true,
            listSessions: listGatewaySessions
          });

          if (active.source !== 'gateway') return;
          if (subagent && !isSessionKeyForAgent(agentId, active.sessionKey)) return;

          if (active.sessionId && active.sessionId !== state.currentSessionId) {
            logger.log(`\n🔄 New session detected: ${active.sessionId}`);
            await switchToSession(agentId, active.sessionId, storeRef, active);
          }
        } catch (_err) {}
      }, 2000);
    };

    for (const dir of existingDirs) {
      fs.watch(dir, { persistent: true }, (_eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) {
          checkForNewSession();
        }
      });
    }
  }

  return {
    getActiveSession,
    getActiveSessionInfo,
    switchToSession,
    watchSessionDirectory
  };
}

module.exports = {
  createSessionRuntime
};
