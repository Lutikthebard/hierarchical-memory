function buildSummarizedTimestampSet(summarizedMessageTimestamps) {
  return new Set(
    (Array.isArray(summarizedMessageTimestamps) ? summarizedMessageTimestamps : [])
      .map((ts) => String(ts || '').trim())
      .filter(Boolean)
  );
}

function summarizeArchiveResult(archivedMessages = [], removed = 0) {
  const lastTimestamp = archivedMessages
    .map((message) => String(message.timestamp || ''))
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    removed,
    archived: archivedMessages.length,
    lastTimestamp
  };
}

async function archiveSummarizedL0Messages(agentId, currentStore, deps = {}) {
  const {
    archiveMessages,
    saveStore,
    loadStore,
    updateStore,
    summarizedMessageTimestamps,
    logger = console
  } = deps;

  if (!agentId) {
    throw new Error('agentId is required');
  }
  if (typeof archiveMessages !== 'function') {
    throw new Error('archiveMessages is required');
  }

  const summarizedTsSet = buildSummarizedTimestampSet(summarizedMessageTimestamps);
  if (summarizedTsSet.size === 0) {
    return { removed: 0, archived: 0, lastTimestamp: null };
  }

  if (typeof updateStore === 'function') {
    const committed = await updateStore(agentId, (latestStore) => {
      const messages = Array.isArray(latestStore.messages) ? latestStore.messages : [];
      const toArchive = messages.filter((message) => summarizedTsSet.has(message.timestamp));
      if (toArchive.length === 0) {
        return { removed: 0, archived: 0, lastTimestamp: null };
      }

      archiveMessages(agentId, toArchive);
      latestStore.messages = messages.filter((message) => !summarizedTsSet.has(message.timestamp));
      const removed = messages.length - latestStore.messages.length;
      return summarizeArchiveResult(toArchive, removed);
    });

    const result = committed?.result || { removed: 0, archived: 0, lastTimestamp: null };
    if (result.removed > 0) {
      logger.log(`📦 Archived and removed ${result.removed} summarized L0 messages`);
    }
    return result;
  }

  const baseStore = (currentStore && typeof currentStore === 'object')
    ? currentStore
    : (typeof loadStore === 'function' ? loadStore(agentId) : null);
  if (!baseStore || typeof baseStore !== 'object') {
    throw new Error('currentStore is required');
  }

  const messages = Array.isArray(baseStore.messages) ? baseStore.messages : [];
  const toArchive = messages.filter((message) => summarizedTsSet.has(message.timestamp));
  if (toArchive.length === 0) {
    return { removed: 0, archived: 0, lastTimestamp: null };
  }

  archiveMessages(agentId, toArchive);
  baseStore.messages = messages.filter((message) => !summarizedTsSet.has(message.timestamp));
  const removed = messages.length - baseStore.messages.length;
  if (typeof saveStore === 'function') {
    saveStore(agentId, baseStore);
  }

  const result = summarizeArchiveResult(toArchive, removed);
  logger.log(`📦 Archived and removed ${result.removed} summarized L0 messages`);
  return result;
}

module.exports = {
  archiveSummarizedL0Messages
};
