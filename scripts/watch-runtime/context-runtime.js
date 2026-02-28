function createContextRuntime({
  getContextPath,
  loadAgentConfig,
  injectCurrentContext,
  gatewayUrl,
  requireSessionKey,
  execSync,
  scriptDir,
  logger = console
}) {
  let contextRegenerateTimeout = null;
  let contextInjectTimeout = null;
  const CONTEXT_DEBOUNCE_MS = 10000;

  function scheduleContextRegenerate(agentId) {
    if (contextRegenerateTimeout) {
      clearTimeout(contextRegenerateTimeout);
    }
    contextRegenerateTimeout = setTimeout(() => {
      const contextPath = getContextPath(agentId);
      try {
        execSync(`node ${scriptDir}/context.js generate ${agentId} --output ${contextPath}`, { stdio: 'ignore' });
      } catch (_err) {
        // Silently ignore context generation errors
      }
    }, CONTEXT_DEBOUNCE_MS);
  }

  async function injectContext(agentId, reason = 'manual') {
    try {
      const contextPath = getContextPath(agentId);
      const targetSessionKey = requireSessionKey(agentId);
      const agentConfig = loadAgentConfig(agentId);
      const autoInject = agentConfig.autoInjectContext || {};
      logger.log(`\n📥 Injecting CONTEXT.md (${reason})...`);
      logger.log(`   → Sending to sessionKey: ${targetSessionKey}`);
      const result = await injectCurrentContext({
        agentId,
        sessionKey: targetSessionKey,
        contextPath,
        reason,
        gatewayUrl,
        requireEnabled: true,
        autoInjectConfig: autoInject
      });
      if (result.skipped) {
        if (result.reason === 'auto-inject-disabled') {
          logger.log(`[inject] Auto-inject disabled for ${agentId}`);
        } else if (result.reason === 'context-missing') {
          logger.log(`[inject] No CONTEXT.md found for ${agentId}`);
        } else if (result.reason === 'context-empty') {
          logger.log(`[inject] CONTEXT.md is empty for ${agentId}`);
        }
        return;
      }
      logger.log(`   Size: ${result.contextBytes} bytes`);
      logger.log('✅ Context injected successfully');
    } catch (err) {
      logger.error('❌ Failed to inject context:', err.message);
    }
  }

  function scheduleContextInject(agentId, reason, delayMs = 2000) {
    if (contextInjectTimeout) {
      clearTimeout(contextInjectTimeout);
    }
    contextInjectTimeout = setTimeout(() => {
      injectContext(agentId, reason);
    }, delayMs);
  }

  return {
    scheduleContextRegenerate,
    injectContext,
    scheduleContextInject
  };
}

module.exports = {
  createContextRuntime
};
