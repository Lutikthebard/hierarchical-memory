function createMainRunner(deps) {
  const {
    processRef,
    acquireAgentLock,
    isSubagent,
    getActiveSessionInfo,
    loadLastSessionId,
    saveLastSessionId,
    runtimeState,
    getSessionsDir,
    path,
    saveLastSessionBinding,
    getDataDir,
    loadConfig,
    loadStore,
    loadAgentConfig,
    processExistingFile,
    refreshSessionCounterFromJsonl,
    getContextPath,
    execSync,
    scheduleContextInject,
    watchFile,
    checkThreshold,
    getThresholdForLevel,
    onThresholdReached,
    compactController,
    sendCompactMessage,
    drainThresholdSummarization,
    watchSessionDirectory,
    logger = console
  } = deps;

  return async function runMain() {
    const args = processRef.argv.slice(2);

    if (args.length < 1) {
      logger.log('Usage: node watch.js <agentId> [sessionId] [jsonlPath]');
      logger.log('');
      logger.log('Arguments:');
      logger.log('  agentId   - Agent identifier (e.g., main, council-architect)');
      logger.log('  sessionId - Optional: Session UUID (auto-detected if omitted)');
      logger.log('  jsonlPath - Optional: explicit path to JSONL file');
      logger.log('');
      logger.log('Example:');
      logger.log('  node watch.js main                    # auto-detect session');
      logger.log('  node watch.js main 58053277-6c68-...  # explicit session');
      processRef.exit(1);
    }

    const [agentId, explicitSessionId, explicitPath] = args;
    acquireAgentLock(agentId);

    const subagent = isSubagent(agentId);
    const resolved = explicitSessionId ? null : await getActiveSessionInfo(agentId);
    const sessionId = explicitSessionId || resolved.sessionId;
    const resolvedSource = explicitSessionId ? 'explicit' : (resolved?.source || 'unknown');

    const lastSessionId = loadLastSessionId(agentId);
    const isNewSession = lastSessionId !== sessionId;

    runtimeState.currentSessionId = sessionId;
    runtimeState.currentSessionKey = resolved?.sessionKey || (subagent ? null : `agent:${agentId}:main`);
    if (subagent && !runtimeState.currentSessionKey) {
      throw new Error(`Subagent ${agentId} cannot start without resolved session key`);
    }

    saveLastSessionId(agentId, sessionId);

    const sessionsDir = getSessionsDir(agentId);
    const jsonlPath = explicitPath || resolved?.jsonlPath || path.join(sessionsDir, `${sessionId}.jsonl`);
    runtimeState.currentJsonlPath = jsonlPath;
    saveLastSessionBinding(agentId, getDataDir(), {
      sessionId,
      sessionKey: runtimeState.currentSessionKey,
      jsonlPath
    });

    logger.log('='.repeat(60));
    logger.log('HIERARCHICAL MEMORY WATCHER');
    logger.log('='.repeat(60));
    logger.log(`Agent:    ${agentId}`);
    logger.log(`Session:  ${sessionId}`);
    logger.log(`Source:   ${resolvedSource}`);
    logger.log(`Key:      ${runtimeState.currentSessionKey || 'N/A'}`);
    logger.log(`JSONL:    ${jsonlPath}`);

    const config = loadConfig();
    logger.log(`Threshold L1: ${config.thresholds.L1 || config.thresholds.default} messages`);
    logger.log('='.repeat(60));

    const storeRef = { current: loadStore(agentId) };
    runtimeState.currentStoreRef = storeRef;
    logger.log(`\nLoaded store: ${storeRef.current.messages.length} existing messages`);

    logger.log('\n📖 Reading existing messages from JSONL...');
    const added = await processExistingFile(agentId, storeRef, jsonlPath);
    logger.log(`   Added ${added} new messages (total: ${storeRef.current.messages.length})`);
    const syncedCount = refreshSessionCounterFromJsonl(jsonlPath, loadAgentConfig(agentId));
    logger.log(`   Synced autoCompact counter from JSONL: ${syncedCount}`);

    logger.log('\n📝 Generating CONTEXT.md...');
    const contextPath = getContextPath(agentId);
    try {
      execSync(`node ${__dirname}/../context.js generate ${agentId} --output ${contextPath}`, { stdio: 'inherit' });
      logger.log('   CONTEXT.md updated');
    } catch (err) {
      logger.error('   Failed to generate CONTEXT.md:', err.message);
    }

    const agentCfgForInject = loadAgentConfig(agentId);
    const autoInject = agentCfgForInject.autoInjectContext || {};
    if (autoInject.enabled && autoInject.onNewSession && isNewSession) {
      logger.log('\n📥 Scheduling context injection (new session detected)...');
      scheduleContextInject(agentId, 'new session', 5000);
    } else if (autoInject.enabled && autoInject.onNewSession && !isNewSession) {
      logger.log('\n⏭️  Skipping context injection (same session, watcher restart)');
    }

    watchFile(agentId, storeRef, jsonlPath, { verbose: true });

    const agentCfg = loadAgentConfig(agentId);
    setTimeout(async () => {
      const threshold = agentCfg.thresholds?.L1 || getThresholdForLevel(1);
      const check = checkThreshold(storeRef.current, 0, threshold, agentId);
      if (check.needed) {
        logger.log('\n⚠️ Threshold already reached with existing messages!');
        logger.log(`   Countable: ${check.countable || check.items.length}, Threshold: ${threshold}`);
        await drainThresholdSummarization(agentId, storeRef, threshold);
      }

      const compactState = compactController.getState();
      logger.log(`\n🔍 Checking autoCompact: sessionMessageCount=${compactState.sessionMessageCount}, awaitingCompaction=${compactState.awaitingCompaction}`);
      const autoCompactCfg = agentCfg.autoCompact || {};
      logger.log(`   autoCompact.enabled=${autoCompactCfg.enabled}, threshold=${autoCompactCfg.messageThreshold || 150}`);
      if (autoCompactCfg.enabled && !compactState.awaitingCompaction) {
        if (compactState.sessionMessageCount >= (autoCompactCfg.messageThreshold || 150)) {
          logger.log(`\n🗜️  AutoCompact threshold already reached: ${compactState.sessionMessageCount}/${autoCompactCfg.messageThreshold || 150}`);
          await compactController.maybeTriggerOrRetry({
            agentId,
            msg: { role: 'system', shouldCount: false },
            autoCompact: autoCompactCfg,
            postMessage: autoCompactCfg.postCompactMessage || '',
            sendFn: sendCompactMessage,
            log: logger.log
          });
        } else {
          logger.log(`   Not yet: ${compactState.sessionMessageCount} < ${autoCompactCfg.messageThreshold || 150}`);
        }
      } else {
        logger.log(`   Skipped: enabled=${autoCompactCfg.enabled}, awaiting=${compactState.awaitingCompaction}`);
      }
    }, 1000);

    setInterval(async () => {
      try {
        const latestCfg = loadAgentConfig(agentId);
        const threshold = latestCfg.thresholds?.L1 || getThresholdForLevel(1);
        const check = checkThreshold(storeRef.current, 0, threshold, agentId);
        if (check.needed) {
          await drainThresholdSummarization(agentId, storeRef, threshold);
        }
      } catch (err) {
        logger.error(`Threshold sweep failed for ${agentId}:`, err.message);
      }
    }, 3000);

    watchSessionDirectory(agentId, storeRef);
  };
}

module.exports = {
  createMainRunner
};
