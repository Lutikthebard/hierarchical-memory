const {
  DEFAULT_AGENT_CONFIG,
  loadConfig,
  loadAgentConfig,
  saveAgentConfig,
  getDataDir,
  getStorePath,
  getArtifactsRootDir,
  getArtifactsIndexPath
} = require('./store/config');
const { compareTimestamps, formatTimestamp } = require('./store/time');
const { createArtifactsApi } = require('./store/artifacts');
const { createRepoApi } = require('./store/repo');
const { createStoreArchiveApi } = require('./store/archive');
const { addMessage, filterForCounting, filterForContext, removeSummarizedMessages } = require('./store/messages');
const { createStatsApi } = require('./store/stats');

const artifactsApi = createArtifactsApi({
  compareTimestamps,
  getArtifactsRootDir,
  getArtifactsIndexPath
});

const repoApi = createRepoApi({
  getStorePath,
  mergeArtifactMaps: artifactsApi.mergeArtifactMaps,
  loadLegacyArtifacts: artifactsApi.loadLegacyArtifacts,
  loadLongTermArtifacts: artifactsApi.loadLongTermArtifacts,
  writeLongTermArtifacts: artifactsApi.writeLongTermArtifacts
});

const archiveApi = createStoreArchiveApi({
  getDataDir,
  compareTimestamps
});

const statsApi = createStatsApi({
  loadConfig,
  loadAgentConfig,
  compareTimestamps,
  filterForCounting
});

module.exports = {
  loadStore: repoApi.loadStore,
  saveStore: repoApi.saveStore,
  addMessage,
  addArtifact: artifactsApi.addArtifact,
  getUnsummarized: statsApi.getUnsummarized,
  selectSummarizationBatch: statsApi.selectSummarizationBatch,
  checkThreshold: statsApi.checkThreshold,
  filterForCounting,
  filterForContext,
  getLastSummarizedTimestamp: statsApi.getLastSummarizedTimestamp,
  getThresholdForLevel: statsApi.getThresholdForLevel,
  loadConfig,
  loadAgentConfig,
  saveAgentConfig,
  getDataDir,
  createEmptyStore: repoApi.createEmptyStore,
  compareTimestamps,
  formatTimestamp,
  archiveMessages: archiveApi.archiveMessages,
  readAllArchivedMessages: archiveApi.readAllArchivedMessages,
  rewriteArchivedMessages: archiveApi.rewriteArchivedMessages,
  mergeAndSortMessages: archiveApi.mergeAndSortMessages,
  getArchivedMessages: archiveApi.getArchivedMessages,
  removeSummarizedMessages: (store, beforeTimestamp) => removeSummarizedMessages(store, beforeTimestamp, compareTimestamps),
  getMessagesDir: archiveApi.getMessagesDir,
  getArtifactsRootDir,
  getArtifactsIndexPath,
  DEFAULT_AGENT_CONFIG
};
