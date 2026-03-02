const fs = require('fs');

function createEmptyStore() {
  return {
    messages: [],
    artifacts: {}
  };
}

function createRepoApi({
  getStorePath,
  mergeArtifactMaps,
  loadLegacyArtifacts,
  loadLongTermArtifacts,
  writeLongTermArtifacts
}) {
  const agentUpdateQueues = new Map();

  function enqueueStoreUpdate(agentId, task) {
    const tail = agentUpdateQueues.get(agentId) || Promise.resolve();
    const run = tail.then(() => task());
    const nextTail = run.catch(() => {});
    agentUpdateQueues.set(agentId, nextTail);
    return run.finally(() => {
      if (agentUpdateQueues.get(agentId) === nextTail) {
        agentUpdateQueues.delete(agentId);
      }
    });
  }

  function loadStore(agentId) {
    const storePath = getStorePath(agentId);
    let store = createEmptyStore();
    if (fs.existsSync(storePath)) {
      const data = fs.readFileSync(storePath, 'utf8');
      store = JSON.parse(data);
    }

    if (!Array.isArray(store.messages)) {
      store.messages = [];
    }
    if (!store.artifacts || typeof store.artifacts !== 'object') {
      store.artifacts = {};
    }

    const legacyArtifacts = loadLegacyArtifacts(storePath);
    const longTermArtifacts = loadLongTermArtifacts(agentId);
    store.artifacts = mergeArtifactMaps([store.artifacts, legacyArtifacts, longTermArtifacts]);
    return store;
  }

  function saveStore(agentId, store) {
    const storePath = getStorePath(agentId);
    const normalizedArtifacts = mergeArtifactMaps([store.artifacts || {}]);
    const normalizedStore = {
      ...store,
      messages: Array.isArray(store.messages) ? store.messages : [],
      artifacts: normalizedArtifacts
    };

    fs.writeFileSync(storePath, JSON.stringify(normalizedStore, null, 2), 'utf8');
    try {
      writeLongTermArtifacts(agentId, normalizedArtifacts);
    } catch (err) {
      console.warn(`Failed to export long-term artifacts for ${agentId}:`, err.message);
    }

    store.messages = normalizedStore.messages;
    store.artifacts = normalizedStore.artifacts;
  }

  function updateStore(agentId, mutator) {
    if (!agentId) {
      throw new Error('agentId is required');
    }
    if (typeof mutator !== 'function') {
      throw new Error('mutator must be a function');
    }

    return enqueueStoreUpdate(agentId, async () => {
      const currentStore = loadStore(agentId);
      const result = await mutator(currentStore);
      saveStore(agentId, currentStore);
      return {
        store: currentStore,
        result
      };
    });
  }

  return {
    createEmptyStore,
    loadStore,
    saveStore,
    updateStore
  };
}

module.exports = {
  createRepoApi,
  createEmptyStore
};
