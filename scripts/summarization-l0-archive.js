function archiveSummarizedL0Messages(agentId, currentStore, deps = {}) {
  const {
    getLastSummarizedTimestamp,
    archiveMessages,
    removeSummarizedMessages,
    saveStore,
    logger = console
  } = deps;

  if (!agentId) {
    throw new Error('agentId is required');
  }
  if (!currentStore || typeof currentStore !== 'object') {
    throw new Error('currentStore is required');
  }

  const lastTs = getLastSummarizedTimestamp(currentStore, 1);
  if (!lastTs) {
    return { removed: 0, archived: 0, lastTimestamp: null };
  }

  const toArchive = (currentStore.messages || []).filter((message) => new Date(message.timestamp) <= new Date(lastTs));
  if (toArchive.length === 0) {
    return { removed: 0, archived: 0, lastTimestamp: lastTs };
  }

  archiveMessages(agentId, toArchive);
  const removed = removeSummarizedMessages(currentStore, lastTs);
  saveStore(agentId, currentStore);
  logger.log(`📦 Archived and removed ${removed} summarized L0 messages`);

  return {
    removed,
    archived: toArchive.length,
    lastTimestamp: lastTs
  };
}

module.exports = {
  archiveSummarizedL0Messages
};
