const {
  DEFAULT_CLASS_FILTERS,
  classifyMessage,
  normalizeText,
  normalizeClassFilters,
  commandAllowed,
  isClassIncludedForTarget
} = require('./message-classifier');

/**
 * Shared JSONL message parser for watchers and related services.
 */

function extractContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
  }

  return '';
}

function parseMessage(line, agentConfig = null) {
  if (!line || !line.trim()) return null;

  const defaultFilters = {
    exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
    excludePatterns: [],
    countRoles: ['user', 'assistant'],
    storeRoles: ['user', 'assistant'],
    ...DEFAULT_CLASS_FILTERS
  };
  const filters = {
    ...defaultFilters,
    ...(agentConfig?.filters || {})
  };
  const classFilters = normalizeClassFilters(filters);

  try {
    const data = JSON.parse(line);
    if (data.type !== 'message') return null;

    const msg = data.message || data;
    const role = msg.role;
    if (!filters.storeRoles.includes(role)) return null;

    const content = normalizeText(extractContent(msg.content));
    if (!content) return null;

    const messageClass = classifyMessage(role, content);
    if (!isClassIncludedForTarget(messageClass, classFilters, 'store')) return null;
    if (!commandAllowed(content, classFilters.commandAllowlist)) return null;

    for (const excludeStr of filters.exclude) {
      if (content.includes(excludeStr)) return null;
    }

    for (const pattern of filters.excludePatterns) {
      try {
        if (new RegExp(pattern).test(content)) return null;
      } catch (_e) {
        // Skip invalid regex entries
      }
    }

    const timestamp = msg.timestamp || data.timestamp || data.ts;
    const ts = timestamp
      ? new Date(typeof timestamp === 'number' ? timestamp : timestamp).toISOString()
      : new Date().toISOString();

    return {
      role,
      content,
      timestamp: ts,
      messageClass,
      shouldCount: filters.countRoles.includes(role) &&
        isClassIncludedForTarget(messageClass, classFilters, 'count') &&
        commandAllowed(content, classFilters.commandAllowlist)
    };
  } catch (_e) {
    return null;
  }
}

module.exports = {
  extractContent,
  parseMessage
};
