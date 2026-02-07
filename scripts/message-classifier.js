const MESSAGE_CLASSES = Object.freeze([
  'dialogue',
  'heartbeat',
  'command',
  'system_noise',
  'memory_internal'
]);

const DEFAULT_CLASS_FILTERS = Object.freeze({
  storeMessageClasses: ['dialogue'],
  countMessageClasses: ['dialogue'],
  contextMessageClasses: ['dialogue'],
  commandAllowlist: []
});

function normalizeText(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\r/g, '\n').trim();
}

function classifyMessage(role, content) {
  const text = normalizeText(content);
  if (!text) return 'system_noise';

  if (text.includes('HEARTBEAT_OK') ||
      /^Read HEARTBEAT\.md/.test(text) ||
      /^\[HEARTBEAT\]/.test(text)) {
    return 'heartbeat';
  }

  if (text.startsWith('/')) {
    return 'command';
  }

  if (text.includes('MEMORY TASK:') ||
      text.includes('<memory_artifact>') ||
      text.includes('Hierarchical Memory Context') ||
      (text.includes('"content":') &&
       text.includes('"startTimestamp":') &&
       text.includes('"endTimestamp":'))) {
    return 'memory_internal';
  }

  if (text.startsWith('System:') ||
      text.includes('A new session was started via /new or /reset') ||
      text.includes('A background task "') ||
      text.includes('ANNOUNCE_SKIP')) {
    return 'system_noise';
  }

  if (role === 'user' || role === 'assistant') {
    return 'dialogue';
  }

  return 'system_noise';
}

function normalizeClassFilters(filters = {}) {
  const out = { ...DEFAULT_CLASS_FILTERS };
  for (const key of Object.keys(DEFAULT_CLASS_FILTERS)) {
    const value = filters[key];
    if (Array.isArray(value)) {
      out[key] = value
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }
  }
  return out;
}

function commandAllowed(content, commandAllowlist) {
  const text = normalizeText(content);
  if (!text.startsWith('/')) return true;
  if (!Array.isArray(commandAllowlist) || commandAllowlist.length === 0) return true;
  return commandAllowlist.some((cmd) => {
    const normalized = String(cmd || '').trim();
    return normalized && (text === normalized || text.startsWith(`${normalized} `));
  });
}

function isClassIncludedForTarget(messageClass, filters = {}, target = 'store') {
  const normalized = normalizeClassFilters(filters);
  const field = target === 'count'
    ? 'countMessageClasses'
    : target === 'context'
      ? 'contextMessageClasses'
      : 'storeMessageClasses';
  const include = normalized[field];
  return include.includes(messageClass);
}

module.exports = {
  MESSAGE_CLASSES,
  DEFAULT_CLASS_FILTERS,
  normalizeText,
  classifyMessage,
  normalizeClassFilters,
  commandAllowed,
  isClassIncludedForTarget
};
