const {
  DEFAULT_CLASS_FILTERS,
  classifyMessage,
  normalizeText,
  normalizeClassFilters,
  commandAllowed,
  isClassIncludedForTarget
} = require('./message-classifier');
const {
  safeStringify,
  extractSessionsSendToolResultPayload,
  buildSessionsSendResultContent
} = require('./shared/inter-agent');

/**
 * Shared JSONL message parser for watchers and related services.
 */

const UNTRUSTED_METADATA_BLOCK_RE = /(?:^|\n)?\s*\/?\s*(?:Conversation info|Sender)\s*\(untrusted metadata\):\s*\n```(?:json)?\s*\n[\s\S]*?\n```\s*/gi;

function extractContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';

        if (item.type === 'text' && typeof item.text === 'string') {
          return item.text;
        }

        if ((item.type === 'thinking' || item.type === 'reasoning') && typeof item.thinking === 'string') {
          return `<think>${item.thinking}</think>`;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function sanitizeUntrustedMetadata(content) {
  const text = normalizeText(content);
  if (!text) return '';
  return normalizeText(text.replace(UNTRUSTED_METADATA_BLOCK_RE, '\n'));
}

function extractSessionsSendToolCall(msg) {
  if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) {
    return null;
  }

  const toolCall = msg.content.find((item) =>
    item &&
    item.type === 'toolCall' &&
    item.name === 'sessions_send' &&
    item.arguments &&
    typeof item.arguments === 'object'
  );
  if (!toolCall) return null;

  const args = toolCall.arguments || {};
  const target = typeof args.sessionKey === 'string' ? args.sessionKey.trim() : '';
  const rawMessage = typeof args.message === 'string'
    ? args.message
    : safeStringify(args.message);
  const outboundText = normalizeText(rawMessage);
  const content = target
    ? `[sessions_send -> ${target}] ${outboundText}`
    : `[sessions_send] ${outboundText}`;

  return {
    role: 'assistant',
    content,
    messageClass: 'inter_agent',
    shouldCount: false,
    direction: 'outgoing',
    toSessionKey: target || null,
    fromSessionKey: msg.sessionKey || null,
    toolName: 'sessions_send',
    toolCallId: toolCall.id || null,
    runId: null,
    status: null,
    sourceType: 'toolCall'
  };
}

function extractSessionsSendToolResult(msg) {
  const payload = extractSessionsSendToolResultPayload(msg);
  if (!payload) return null;
  const target = payload.sessionKey || 'unknown';
  const content = buildSessionsSendResultContent(target, payload.status, payload.runId, payload.replyText);

  return {
    role: 'assistant',
    content,
    messageClass: 'inter_agent',
    shouldCount: false,
    direction: 'result',
    toSessionKey: payload.sessionKey || null,
    fromSessionKey: msg.sessionKey || null,
    toolName: 'sessions_send',
    toolCallId: msg.toolCallId || null,
    runId: payload.runId || null,
    status: payload.status || null,
    sourceType: 'toolResult'
  };
}

function extractInterAgentEvent(msg) {
  return extractSessionsSendToolCall(msg) || extractSessionsSendToolResult(msg);
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
    const timestamp = msg.timestamp || data.timestamp || data.ts;
    const ts = timestamp
      ? new Date(typeof timestamp === 'number' ? timestamp : timestamp).toISOString()
      : new Date().toISOString();

    const interAgent = extractInterAgentEvent(msg);
    const parsed = interAgent || {
      role: msg.role,
      content: normalizeText(extractContent(msg.content)),
      messageClass: null
    };
    const role = parsed.role;
    if (!filters.storeRoles.includes(role)) return null;

    const content = sanitizeUntrustedMetadata(parsed.content);
    if (!content) return null;

    const messageClass = parsed.messageClass || classifyMessage(role, content);
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

    const base = {
      role,
      content,
      timestamp: ts,
      messageClass
    };

    if (!interAgent) {
      base.shouldCount = filters.countRoles.includes(role) &&
        isClassIncludedForTarget(messageClass, classFilters, 'count') &&
        commandAllowed(content, classFilters.commandAllowlist);
      return base;
    }

    base.shouldCount = false;
    base.direction = interAgent.direction || null;
    base.fromSessionKey = interAgent.fromSessionKey || null;
    base.toSessionKey = interAgent.toSessionKey || null;
    base.toolName = interAgent.toolName || null;
    base.toolCallId = interAgent.toolCallId || null;
    base.runId = interAgent.runId || null;
    base.status = interAgent.status || null;
    base.sourceType = interAgent.sourceType || null;
    return base;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  extractContent,
  parseMessage
};
