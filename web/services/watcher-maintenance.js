function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createWatcherMaintenance({
  runningWatchers,
  stopWatcher,
  startWatcher,
  stopDelayMs = 300
}) {
  async function pause(agentId) {
    const watcherWasRunning = runningWatchers.has(agentId);
    if (watcherWasRunning) {
      stopWatcher(agentId);
      await sleep(stopDelayMs);
    }
    return watcherWasRunning;
  }

  function resume(agentId, watcherWasRunning, restartErrorPrefix = 'Watcher failed to restart') {
    if (!watcherWasRunning) {
      return { watcherRestarted: false };
    }

    const restartResult = startWatcher(agentId);
    const watcherRestarted = restartResult.success === true;
    if (!watcherRestarted) {
      throw new Error(`${restartErrorPrefix}: ${restartResult.message || 'unknown error'}`);
    }

    return { watcherRestarted: true };
  }

  async function withPausedWatcher(agentId, action, options = {}) {
    const restartErrorPrefix = options.restartErrorPrefix || 'Watcher failed to restart';
    const watcherWasRunning = await pause(agentId);

    let actionResult;
    let actionError = null;
    try {
      actionResult = await action({ watcherWasRunning });
    } catch (err) {
      actionError = err;
    }

    let resumeError = null;
    let watcherRestarted = false;
    try {
      const resumeResult = resume(agentId, watcherWasRunning, restartErrorPrefix);
      watcherRestarted = resumeResult.watcherRestarted;
    } catch (err) {
      resumeError = err;
    }

    if (actionError) {
      actionError.watcherWasRunning = watcherWasRunning;
      actionError.watcherRestarted = watcherRestarted;
      actionError.partialResult = actionResult;
      if (resumeError) {
        actionError.message = `${actionError.message}; ${resumeError.message}`;
      }
      throw actionError;
    }

    if (resumeError) {
      resumeError.watcherWasRunning = watcherWasRunning;
      resumeError.watcherRestarted = false;
      resumeError.partialResult = actionResult;
      throw resumeError;
    }

    return {
      watcherWasRunning,
      watcherRestarted,
      result: actionResult
    };
  }

  return {
    pause,
    resume,
    withPausedWatcher
  };
}

module.exports = {
  createWatcherMaintenance
};
