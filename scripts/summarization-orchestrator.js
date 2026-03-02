const { exec } = require('child_process');
const { promisify } = require('util');
const { resolveThresholdForLevel } = require('./summarization-thresholds');
const { archiveSummarizedL0Messages } = require('./summarization-l0-archive');

function createSummarizationOrchestrator(deps) {
  const execAsync = promisify(exec);

  const {
    scriptDir,
    triggerApi,
    resolveSessionKey,
    loadStore,
    saveStore,
    updateStore,
    loadAgentConfig,
    archiveMessages,
    checkThreshold,
    getThresholdForLevel,
    formatTimestamp,
    getContextPath
  } = deps;

  function resolveThreshold(agentId, level) {
    const agentConfig = loadAgentConfig ? loadAgentConfig(agentId) : null;
    return resolveThresholdForLevel(agentConfig, level, getThresholdForLevel(level));
  }

  async function runSummarization(agentId, sourceLevel) {
    const timestamp = new Date().toISOString();

    try {
      console.log(`[${timestamp}] Running trigger-ws.js...`);
      if (!triggerApi || typeof triggerApi.handleL1 !== 'function' || typeof triggerApi.handleAggregate !== 'function') {
        throw new Error('triggerApi is required (fallback execution path removed)');
      }
      if (typeof resolveSessionKey !== 'function') {
        throw new Error('resolveSessionKey is required (fallback execution path removed)');
      }

      const sessionKey = resolveSessionKey(agentId);
      let l1Result = null;
      if (sourceLevel === 0) {
        l1Result = await triggerApi.handleL1(agentId, sessionKey);
      } else {
        await triggerApi.handleAggregate(agentId, sessionKey, sourceLevel);
      }

      console.log(`\n[${new Date().toISOString()}] Generating CONTEXT.md...`);
      const contextPath = getContextPath(agentId);
      const contextCmd = `node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`;

      const { stdout: contextOut, stderr: contextErr } = await execAsync(contextCmd, {
        cwd: scriptDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000
      });

      if (contextOut) {
        console.log('✅ Context.js output:');
        console.log(contextOut);
      }
      if (contextErr) {
        console.error('⚠️  Context.js stderr:', contextErr);
      }

      console.log('\n✅ Automatic summarization completed successfully!\n');
      console.log('🔄 Reloading store to pick up new artifacts...');

      let updatedStore = loadStore(agentId);
      console.log(`   Artifacts now: L1=${(updatedStore.artifacts[1] || []).length}`);

      if (sourceLevel === 0) {
        await archiveSummarizedL0Messages(agentId, updatedStore, {
          archiveMessages,
          saveStore,
          loadStore,
          updateStore,
          summarizedMessageTimestamps: l1Result?.summarizedMessageTimestamps || [],
          logger: console
        });
        updatedStore = loadStore(agentId);
      }

      const targetLevel = sourceLevel + 1;
      const nextLevel = targetLevel + 1;
      const nextThreshold = resolveThreshold(agentId, nextLevel);
      const nextCheck = checkThreshold(updatedStore, targetLevel, nextThreshold);

      if (nextCheck.needed) {
        console.log(`\n🔄 Recursive check: L${targetLevel}→L${nextLevel} also ready (${nextCheck.items.length}/${nextThreshold})`);
        console.log('   → Starting recursive summarization...\n');
        const recursiveStore = await runSummarization(agentId, targetLevel);
        return recursiveStore || updatedStore;
      }

      return updatedStore;
    } catch (error) {
      console.error('\n❌ Error during automatic summarization:');
      console.error(`   ${error.message}`);
      if (error.stdout) console.error('\nStdout:', error.stdout);
      if (error.stderr) console.error('\nStderr:', error.stderr);
      console.error('\n⚠️  Continuing to watch for new messages...\n');
      return null;
    }
  }

  async function onThresholdReached(agentId, store, sourceLevel, items) {
    const targetLevel = sourceLevel + 1;
    console.log('\n🔔 THRESHOLD REACHED!');
    console.log(`   Source level: L${sourceLevel} → Target: L${targetLevel}`);
    console.log(`   Items to summarize: ${items.length}`);

    if (sourceLevel === 0) {
      const startTs = formatTimestamp(items[0].timestamp);
      const endTs = formatTimestamp(items[items.length - 1].timestamp);
      console.log(`   Time range: ${startTs} → ${endTs}`);
    } else {
      console.log(`   Artifacts: ${items.length} at level ${sourceLevel}`);
    }

    console.log('   → Starting automatic summarization...\n');
    return runSummarization(agentId, sourceLevel);
  }

  return {
    runSummarization,
    onThresholdReached
  };
}

module.exports = {
  createSummarizationOrchestrator
};
