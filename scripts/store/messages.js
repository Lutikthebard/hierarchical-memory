const {
  classifyMessage,
  normalizeText,
  normalizeClassFilters,
  commandAllowed,
  isClassIncludedForTarget
} = require('../message-classifier');

function addMessage(store, {
  role,
  content,
  timestamp,
  messageClass,
  direction,
  fromSessionKey,
  toSessionKey,
  toolName,
  toolCallId,
  runId,
  status,
  sourceType
}) {
  const ts = typeof timestamp === 'number' ? new Date(timestamp).toISOString() : (timestamp || new Date().toISOString());

  if (store.messages.some((m) => m.timestamp === ts)) {
    return null;
  }

  const message = {
    role,
    content,
    timestamp: ts
  };
  if (messageClass) message.messageClass = messageClass;
  if (direction) message.direction = direction;
  if (fromSessionKey) message.fromSessionKey = fromSessionKey;
  if (toSessionKey) message.toSessionKey = toSessionKey;
  if (toolName) message.toolName = toolName;
  if (toolCallId) message.toolCallId = toolCallId;
  if (runId) message.runId = runId;
  if (status) message.status = status;
  if (sourceType) message.sourceType = sourceType;

  store.messages.push(message);
  return message;
}

function filterForCounting(messages, agentConfig) {
  if (!agentConfig) return messages;

  const filters = { ...(agentConfig.filters || {}), ...normalizeClassFilters(agentConfig.filters || {}) };
  const exclude = filters.exclude || [];
  const excludePatterns = filters.excludePatterns || [];
  const countRoles = filters.countRoles || ['user', 'assistant'];

  return messages.filter((m) => {
    if (!countRoles.includes(m.role)) return false;

    const content = normalizeText(m.content || '');
    if (!content) return false;
    const messageClass = m.messageClass || classifyMessage(m.role, content);
    if (!isClassIncludedForTarget(messageClass, filters, 'count')) return false;
    if (!commandAllowed(content, filters.commandAllowlist || [])) return false;

    for (const ex of exclude) {
      if (content.includes(ex)) return false;
    }

    for (const pattern of excludePatterns) {
      try {
        if (new RegExp(pattern).test(content)) return false;
      } catch (_e) {}
    }

    return true;
  });
}

function filterForContext(messages, agentConfig) {
  if (!agentConfig) return messages;

  const filters = { ...(agentConfig.filters || {}), ...normalizeClassFilters(agentConfig.filters || {}) };
  const exclude = filters.exclude || [];
  const excludePatterns = filters.excludePatterns || [];
  const storeRoles = filters.storeRoles || ['user', 'assistant'];

  return messages.filter((m) => {
    if (!storeRoles.includes(m.role)) return false;

    const content = normalizeText(m.content || '');
    if (!content) return false;

    const messageClass = m.messageClass || classifyMessage(m.role, content);
    if (!isClassIncludedForTarget(messageClass, filters, 'context')) return false;
    if (!commandAllowed(content, filters.commandAllowlist || [])) return false;

    for (const ex of exclude) {
      if (content.includes(ex)) return false;
    }

    for (const pattern of excludePatterns) {
      try {
        if (new RegExp(pattern).test(content)) return false;
      } catch (_e) {}
    }

    return true;
  });
}

function removeSummarizedMessages(store, beforeTimestamp, compareTimestamps) {
  if (!store.messages) return 0;

  const before = store.messages.length;
  store.messages = store.messages.filter((m) => compareTimestamps(m.timestamp, beforeTimestamp) > 0);
  return before - store.messages.length;
}

module.exports = {
  addMessage,
  filterForCounting,
  filterForContext,
  removeSummarizedMessages
};
