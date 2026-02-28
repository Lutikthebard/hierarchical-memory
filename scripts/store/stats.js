function createStatsApi({ loadConfig, loadAgentConfig, compareTimestamps, filterForCounting }) {
  function normalizeThreshold(threshold) {
    const parsed = Number(threshold);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 1;
    }
    return Math.floor(parsed);
  }

  function sortMessagesChronologically(messages) {
    return [...(Array.isArray(messages) ? messages : [])].sort((a, b) =>
      compareTimestamps(a?.timestamp, b?.timestamp)
    );
  }

  function sortArtifactsChronologically(artifacts) {
    return [...(Array.isArray(artifacts) ? artifacts : [])].sort((a, b) => {
      const endCmp = compareTimestamps(a?.endTimestamp, b?.endTimestamp);
      if (endCmp !== 0) return endCmp;
      const startCmp = compareTimestamps(a?.startTimestamp, b?.startTimestamp);
      if (startCmp !== 0) return startCmp;
      return String(a?.artifactId || '').localeCompare(String(b?.artifactId || ''));
    });
  }

  function getLastSummarizedTimestamp(store, targetLevel) {
    const artifacts = store.artifacts[targetLevel];
    if (!artifacts || artifacts.length === 0) {
      return null;
    }

    const timestamps = artifacts.filter((a) => a.endTimestamp).map((a) => a.endTimestamp);

    if (timestamps.length === 0) {
      return null;
    }

    return timestamps.sort((a, b) => compareTimestamps(a, b))[timestamps.length - 1];
  }

  function getUnsummarized(store, sourceLevel, agentId = null) {
    const config = loadConfig();
    const targetLevel = sourceLevel + 1;
    const lastTimestamp = getLastSummarizedTimestamp(store, targetLevel);
    const startFromTimestamp = config.startFromTimestamp || null;

    if (sourceLevel === 0) {
      let messages = store.messages;

      if (lastTimestamp) {
        messages = messages.filter((m) => compareTimestamps(m.timestamp, lastTimestamp) > 0);
      }

      if (startFromTimestamp) {
        messages = messages.filter((m) => compareTimestamps(m.timestamp, startFromTimestamp) >= 0);
      }

      return messages;
    }

    const artifacts = store.artifacts[sourceLevel] || [];
    if (!lastTimestamp) {
      return artifacts;
    }
    return artifacts.filter((a) => compareTimestamps(a.endTimestamp, lastTimestamp) > 0);
  }

  function selectSummarizationBatch(store, sourceLevel, threshold, agentId = null) {
    const normalizedThreshold = normalizeThreshold(threshold);
    const unsummarizedItems = getUnsummarized(store, sourceLevel, agentId);

    if (sourceLevel === 0) {
      const orderedMessages = sortMessagesChronologically(unsummarizedItems);
      const countableMessages = agentId
        ? filterForCounting(orderedMessages, loadAgentConfig(agentId))
        : orderedMessages;

      if (countableMessages.length < normalizedThreshold) {
        return {
          needed: false,
          threshold: normalizedThreshold,
          items: orderedMessages,
          batch: [],
          countable: countableMessages.length,
          countableBatch: []
        };
      }

      const countableBatch = countableMessages.slice(0, normalizedThreshold);
      const batchEndTs = countableBatch[countableBatch.length - 1].timestamp;
      const batch = orderedMessages.filter((m) => compareTimestamps(m.timestamp, batchEndTs) <= 0);

      return {
        needed: true,
        threshold: normalizedThreshold,
        items: orderedMessages,
        batch,
        countable: countableMessages.length,
        countableBatch
      };
    }

    const orderedArtifacts = sortArtifactsChronologically(unsummarizedItems);
    const batch = orderedArtifacts.slice(0, normalizedThreshold);

    return {
      needed: orderedArtifacts.length >= normalizedThreshold,
      threshold: normalizedThreshold,
      items: orderedArtifacts,
      batch
    };
  }

  function checkThreshold(store, sourceLevel, threshold, agentId = null) {
    const selected = selectSummarizationBatch(store, sourceLevel, threshold, agentId);
    const items = selected.items;

    if (sourceLevel === 0 && agentId) {
      return {
        needed: selected.needed,
        items,
        countable: selected.countable
      };
    }

    return {
      needed: selected.needed,
      items
    };
  }

  function getThresholdForLevel(level) {
    const config = loadConfig();
    const key = `L${level}`;
    return config.thresholds[key] || config.thresholds.default || 3;
  }

  return {
    getLastSummarizedTimestamp,
    getUnsummarized,
    selectSummarizationBatch,
    checkThreshold,
    getThresholdForLevel
  };
}

module.exports = {
  createStatsApi
};
