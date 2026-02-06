const { exec } = require('child_process');
const { promisify } = require('util');

function createSummarizationOrchestrator(deps) {
  const execAsync = promisify(exec);

  const {
    scriptDir,
    loadStore,
    saveStore,
    archiveMessages,
    removeSummarizedMessages,
    getLastSummarizedTimestamp,
    checkThreshold,
    getThresholdForLevel,
    formatTimestamp,
    getContextPath
  } = deps;

  async function runSummarization(agentId, sourceLevel) {
    const timestamp = new Date().toISOString();

    try {
      console.log(`[${timestamp}] Running trigger-ws.js...`);

      const triggerCmd = sourceLevel === 0
        ? `node ${scriptDir}/trigger-ws.js l1 ${agentId} ${agentId}`
        : `node ${scriptDir}/trigger-ws.js aggregate ${agentId} ${agentId} ${sourceLevel}`;

      const { stdout: triggerOut, stderr: triggerErr } = await execAsync(triggerCmd, {
        cwd: scriptDir,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 360000
      });

      if (triggerOut) {
        console.log('✅ Trigger.js output:');
        console.log(triggerOut);
      }
      if (triggerErr) {
        console.error('⚠️  Trigger.js stderr:', triggerErr);
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

      const updatedStore = loadStore(agentId);
      console.log(`   Artifacts now: L1=${(updatedStore.artifacts[1] || []).length}`);

      if (sourceLevel === 0) {
        const lastTs = getLastSummarizedTimestamp(updatedStore, 1);
        if (lastTs) {
          const toArchive = updatedStore.messages.filter((m) => new Date(m.timestamp) <= new Date(lastTs));
          if (toArchive.length > 0) {
            console.log(`📦 Archiving ${toArchive.length} summarized messages...`);
            archiveMessages(agentId, toArchive);
            const removed = removeSummarizedMessages(updatedStore, lastTs);
            saveStore(agentId, updatedStore);
            console.log(`   Archived and removed ${removed} messages from store`);
          }
        }
      }

      const targetLevel = sourceLevel + 1;
      const nextThreshold = getThresholdForLevel(targetLevel + 1);
      const nextCheck = checkThreshold(updatedStore, targetLevel, nextThreshold);

      if (nextCheck.needed) {
        console.log(`\n🔄 Recursive check: L${targetLevel}→L${targetLevel + 1} also ready (${nextCheck.items.length}/${nextThreshold})`);
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
