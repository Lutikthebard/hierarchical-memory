const { normalizeText } = require('../message-classifier');

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value || '');
  }
}

function extractSessionsSendToolResultPayload(msg, options = {}) {
  if (msg?.role !== 'toolResult' || msg?.toolName !== 'sessions_send') {
    return null;
  }

  const details = msg.details && typeof msg.details === 'object' ? msg.details : {};
  const skipNoReply = options.skipNoReply === true;
  let status = typeof details.status === 'string' ? details.status.trim() : '';
  let runId = typeof details.runId === 'string' ? details.runId.trim() : '';
  let sessionKey = typeof details.sessionKey === 'string' ? details.sessionKey.trim() : '';
  let reply = typeof details.reply === 'string'
    ? details.reply
    : details.reply != null
      ? safeStringify(details.reply)
      : '';

  if ((!status || !runId || !sessionKey || !reply) && Array.isArray(msg.content)) {
    const textBlock = msg.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (textBlock) {
      try {
        const parsed = JSON.parse(textBlock.text);
        if (!status && typeof parsed.status === 'string') status = parsed.status.trim();
        if (!runId && typeof parsed.runId === 'string') runId = parsed.runId.trim();
        if (!sessionKey && typeof parsed.sessionKey === 'string') sessionKey = parsed.sessionKey.trim();
        if (!reply) {
          if (typeof parsed.reply === 'string') {
            reply = parsed.reply;
          } else if (parsed.reply != null) {
            reply = safeStringify(parsed.reply);
          }
        }
      } catch (_e) {
        // Keep best-effort values from details only
      }
    }
  }

  const replyText = normalizeText(reply);
  if (skipNoReply && (!replyText || replyText === 'NO_REPLY')) return null;

  return {
    toolCallId: typeof msg.toolCallId === 'string' ? msg.toolCallId.trim() || null : null,
    runId: runId || null,
    status: status || null,
    sessionKey: sessionKey || null,
    replyText
  };
}

function buildSessionsSendResultContent(target, status, runId, replyText) {
  const statusPart = status ? ` status=${status}` : '';
  const runPart = runId ? ` runId=${runId}` : '';
  const header = `[sessions_send result <- ${target || 'unknown'}]${statusPart}${runPart}`.trim();
  return replyText ? `${header}\n${replyText}` : header;
}

module.exports = {
  safeStringify,
  extractSessionsSendToolResultPayload,
  buildSessionsSendResultContent
};
