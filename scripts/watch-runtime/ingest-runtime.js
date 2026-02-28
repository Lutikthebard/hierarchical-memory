const readline = require('readline');
const { createCompactionEventHandler } = require('./compaction-event');

function createIngestRuntime(deps) {
  const {
    state,
    fs,
    spawn,
    processRef,
    loadAgentConfig,
    parseMessage,
    addMessage,
    formatTimestamp,
    saveStore,
    scheduleContextRegenerate,
    compactController,
    checkThreshold,
    getThresholdForLevel,
    drainThresholdSummarization,
    sendCompactMessageBase,
    gatewayUrl,
    requireSessionKey,
    countSessionMessagesFromJsonl,
    scheduleContextInject,
    onRawLine,
    logger = console
  } = deps;

  async function processLine(agentId, storeRef, line, options = {}) {
    if (typeof onRawLine === 'function') {
      try {
        onRawLine({
          agentId,
          line,
          sessionKey: state.currentSessionKey || null
        });
      } catch (err) {
        logger.error('onRawLine hook failed:', err?.message || err);
      }
    }

    const agentConfig = options.agentConfig || loadAgentConfig(agentId);

    const msg = parseMessage(line, agentConfig);
    if (!msg) return false;

    const added = addMessage(storeRef.current, msg);
    if (!added) return false;

    if (msg.shouldCount) {
      compactController.markMessageProcessed(true);
    }

    if (options.verbose) {
      const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
      const ts = formatTimestamp(added.timestamp);
      logger.log(`[${ts}] ${msg.role.toUpperCase()}: ${preview}${msg.content.length > 50 ? '...' : ''}`);
    }

    if (!options.skipPersistence) {
      saveStore(agentId, storeRef.current);
    }

    if (!options.skipContextRegenerate) {
      scheduleContextRegenerate(agentId);
    }

    const agentCfg = options.agentConfig || loadAgentConfig(agentId);
    const autoCompact = agentCfg.autoCompact || {};

    if (autoCompact.enabled && !options.skipAutoCompact) {
      await compactController.maybeTriggerOrRetry({
        agentId,
        msg,
        autoCompact,
        postMessage: autoCompact.postCompactMessage || '',
        sendFn: sendCompactMessage,
        log: logger.log
      });
    }

    if (!options.skipThresholdCheck) {
      const threshold = agentCfg.thresholds?.L1 || getThresholdForLevel(1);
      const check = checkThreshold(storeRef.current, 0, threshold, agentId);
      if (check.needed) {
        drainThresholdSummarization(agentId, storeRef, threshold).catch((err) => {
          logger.error('Error in threshold summarization:', err?.message || err);
        });
      }
    }

    return true;
  }

  async function forceSyncSessionToStore(agentId) {
    if (!state.currentStoreRef || !state.currentJsonlPath || !fs.existsSync(state.currentJsonlPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(state.currentJsonlPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      let added = 0;

      for (const line of lines) {
        if (await processLine(agentId, state.currentStoreRef, line, {
          verbose: false,
          skipThresholdCheck: true,
          skipAutoCompact: true,
          skipContextRegenerate: true,
          skipPersistence: true
        })) {
          added++;
        }
      }

      if (added > 0) {
        saveStore(agentId, state.currentStoreRef.current);
        logger.log(`   🔄 Pre-compact sync: +${added} messages from JSONL`);
      }
    } catch (err) {
      logger.log(`   ⚠️  Pre-compact sync failed: ${err.message}`);
    }
  }

  async function sendCompactMessage(agentId, message) {
    try {
      const compactSessionKey = requireSessionKey(agentId);
      logger.log(`   → Sending /compact to sessionKey: ${compactSessionKey}`);
      const postCompactMessage = String(message || '').startsWith('/compact')
        ? String(message || '').replace(/^\/compact\s*/, '')
        : '';
      await sendCompactMessageBase({
        agentId,
        sessionKey: compactSessionKey,
        postCompactMessage,
        gatewayUrl,
        beforeSend: async () => {
          await forceSyncSessionToStore(agentId);
        }
      });
      logger.log('   📤 /compact command sent');
      return true;
    } catch (err) {
      logger.log(`   ⚠️  Failed to send /compact: ${err.message}`);
      return false;
    }
  }

  function refreshSessionCounterFromJsonl(jsonlPath, agentConfig) {
    const count = countSessionMessagesFromJsonl(jsonlPath, agentConfig);
    compactController.setSessionMessageCount(count);
    return count;
  }

  const checkForCompaction = createCompactionEventHandler({
    compactController,
    loadAgentConfig,
    scheduleContextInject,
    log: logger.log
  });

  function watchFile(agentId, storeRef, jsonlPath, options = {}) {
    logger.log('\n👁 Watching for new messages (tail -F)...');
    logger.log('   Press Ctrl+C to stop\n');

    const tail = spawn('tail', ['-F', '-n', '0', jsonlPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    state.currentTailProcess = tail;

    const rl = readline.createInterface({
      input: tail.stdout,
      crlfDelay: Infinity
    });

    let lineProcessing = Promise.resolve();
    rl.on('line', (line) => {
      lineProcessing = lineProcessing
        .then(async () => {
          checkForCompaction(line, agentId);
          await processLine(agentId, storeRef, line, { verbose: true });
        })
        .catch((err) => {
          logger.error('Error processing tailed line:', err?.message || err);
        });
    });

    tail.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('file truncated')) {
        logger.error(`tail stderr: ${msg}`);
      }
    });

    tail.on('close', (code) => {
      if (state.currentTailProcess === tail) {
        logger.log(`\ntail exited with code ${code}`);
        processRef.exit(code);
      } else {
        logger.log('   Old tail process ended (hot-swap)');
      }
    });

    if (!options.skipSignalHandler) {
      processRef.on('SIGINT', () => {
        logger.log('\n\nShutting down...');
        if (state.currentTailProcess) state.currentTailProcess.kill();
        logger.log(`Final store state: ${storeRef.current.messages.length} messages`);
        processRef.exit(0);
      });
    }

    return tail;
  }

  return {
    processLine,
    forceSyncSessionToStore,
    sendCompactMessage,
    refreshSessionCounterFromJsonl,
    watchFile
  };
}

module.exports = {
  createIngestRuntime
};
