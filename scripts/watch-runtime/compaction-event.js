function createCompactionEventHandler({
  compactController,
  loadAgentConfig,
  scheduleContextInject,
  log = console.log,
  now = () => Date.now(),
  dedupeWindowMs = 15000
}) {
  const lastCompactionByKey = new Map();

  function isDuplicateCompaction(agentId, line) {
    const key = `${agentId}:${line.trim()}`;
    const ts = now();
    const prevTs = lastCompactionByKey.get(key);
    if (typeof prevTs === 'number' && ts - prevTs <= dedupeWindowMs) {
      return true;
    }
    lastCompactionByKey.set(key, ts);

    // Keep memory bounded for long-running watcher processes.
    if (lastCompactionByKey.size > 500) {
      for (const [entryKey, entryTs] of lastCompactionByKey.entries()) {
        if (ts - entryTs > dedupeWindowMs) {
          lastCompactionByKey.delete(entryKey);
        }
      }
    }
    return false;
  }

  return function checkForCompaction(line, agentId) {
    if (!line.trim()) return false;

    try {
      const data = JSON.parse(line);

      if (data.type === 'compaction') {
        if (isDuplicateCompaction(agentId, line)) {
          log('   ↩️ Duplicate compaction event ignored (dedup)');
          return true;
        }

        const agentConfig = loadAgentConfig(agentId);
        const autoInject = agentConfig.autoInjectContext || {};

        if (autoInject.enabled && autoInject.onCompaction) {
          log(`\n🔄 Compaction detected! (${data.tokensBefore} tokens before)`);
          scheduleContextInject(agentId, 'compaction', 3000);
        }

        const stateBefore = compactController.getState();
        log(`   Resetting session message counter (was ${stateBefore.sessionMessageCount})`);
        if (stateBefore.awaitingCompaction) {
          log(`   ✅ Auto-compact completed (${stateBefore.compactRetryCount} retries)`);
        }
        compactController.resetAfterCompaction();

        return true;
      }
    } catch (_e) {
      // Not JSON or parse error
    }
    return false;
  };
}

module.exports = {
  createCompactionEventHandler
};
