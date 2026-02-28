function createThresholdRuntime({ checkThreshold, onThresholdReached, logger = console }) {
  const state = {
    summarizationInProgress: false,
    pendingThresholdCheck: false
  };

  async function drainThresholdSummarization(agentId, storeRef, threshold) {
    if (state.summarizationInProgress) {
      state.pendingThresholdCheck = true;
      return;
    }

    state.summarizationInProgress = true;
    logger.log('🔒 Lock acquired for summarization');

    try {
      while (true) {
        state.pendingThresholdCheck = false;
        const nextCheck = checkThreshold(storeRef.current, 0, threshold, agentId);
        if (!nextCheck.needed) break;

        const updatedStore = await onThresholdReached(agentId, storeRef.current, 0, nextCheck.items);
        if (updatedStore) {
          storeRef.current = updatedStore;
        }

        const followUp = checkThreshold(storeRef.current, 0, threshold, agentId);
        if (!followUp.needed && !state.pendingThresholdCheck) break;
      }
    } catch (err) {
      logger.error('Error in onThresholdReached:', err);
    } finally {
      state.summarizationInProgress = false;
      logger.log('🔓 Lock released');
    }
  }

  return {
    drainThresholdSummarization,
    thresholdState: state
  };
}

module.exports = {
  createThresholdRuntime
};
