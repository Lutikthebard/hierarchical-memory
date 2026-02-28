function createLockRuntime({
  fs,
  path,
  getDataDir,
  loadLastSessionBinding,
  saveLastSessionBinding,
  state
}) {
  function acquireAgentLock(agentId) {
    const lockPath = path.join(getDataDir(), agentId, 'watch.pid');
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(lockPath)) {
      try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          throw new Error(`Watcher already running for ${agentId} (pid=${pid})`);
        }
      } catch (e) {
        if (!String(e.message || '').includes('Watcher already running')) {
          // stale lock; continue and replace
        } else {
          throw e;
        }
      }
    }

    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    state.agentLockPath = lockPath;
  }

  function releaseAgentLock() {
    if (!state.agentLockPath) return;
    try {
      const content = fs.existsSync(state.agentLockPath) ? fs.readFileSync(state.agentLockPath, 'utf8').trim() : '';
      if (String(process.pid) === content) {
        fs.unlinkSync(state.agentLockPath);
      }
    } catch (_e) {}
    state.agentLockPath = null;
  }

  function saveLastSessionId(agentId, sessionId) {
    saveLastSessionBinding(agentId, getDataDir(), { sessionId });
  }

  function loadLastSessionId(agentId) {
    const binding = loadLastSessionBinding(agentId, getDataDir());
    return binding?.sessionId || null;
  }

  function getContextPath(agentId) {
    return path.join(getDataDir(), agentId, 'CONTEXT.md');
  }

  return {
    acquireAgentLock,
    releaseAgentLock,
    saveLastSessionId,
    loadLastSessionId,
    getContextPath
  };
}

module.exports = {
  createLockRuntime
};
