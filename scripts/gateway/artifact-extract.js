function extractTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractTimestampMs(message) {
  const raw = message?.timestamp ?? message?.ts ?? message?.createdAt ?? message?.time;
  if (raw === undefined || raw === null) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isNewestFirst(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return true;
  const firstTs = extractTimestampMs(messages[0]);
  const lastTs = extractTimestampMs(messages[messages.length - 1]);
  if (firstTs === null || lastTs === null) {
    return true;
  }
  return firstTs >= lastTs;
}

function sourceTextMatchesCandidate(candidateText, sourceMessage) {
  const sourceNorm = normalizeWhitespace(sourceMessage);
  const candidateNorm = normalizeWhitespace(candidateText);
  if (!sourceNorm || !candidateNorm) return false;

  const prefix = sourceNorm.substring(0, Math.min(80, sourceNorm.length));
  if (!candidateNorm.includes(prefix)) return false;

  if (sourceNorm.length > 120) {
    const suffix = sourceNorm.substring(sourceNorm.length - 60);
    if (!candidateNorm.includes(suffix)) return false;
  }

  return true;
}

function normalizeExpectedLevel(expectedLevel) {
  const parsed = Number(expectedLevel);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getArtifactTagName(expectedLevel = null) {
  const normalizedLevel = normalizeExpectedLevel(expectedLevel);
  if (normalizedLevel === null) return null;
  return `memory_artifact_L${normalizedLevel}`;
}

function hasAnyArtifactTag(text) {
  return /<memory_artifact(?:_L\d+)?>/.test(String(text || ''));
}

function hasArtifactTagForLevel(text, expectedLevel = null) {
  const normalizedText = String(text || '');
  const tagName = getArtifactTagName(expectedLevel);
  if (!tagName) return hasAnyArtifactTag(normalizedText);
  return normalizedText.includes(`<${tagName}>`);
}

function formatExpectedTagLabel(expectedLevel = null) {
  const tagName = getArtifactTagName(expectedLevel);
  return tagName ? `<${tagName}>` : '<memory_artifact_LN>';
}

/**
 * Search collected real-time messages (from chat.subscribe) for an assistant
 * response containing memory artifact tags. Unlike findArtifactInHistory,
 * this doesn't need to match the source prompt — all collected messages came
 * AFTER our subscribe call.
 */
function collectArtifactFromMessages(messages, expectedLevel = null) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : extractTextContent(msg.content);
    if (hasArtifactTagForLevel(text, expectedLevel)) return text;
  }
  return '';
}

function findArtifactInHistory(messages, sourceMessage, logger = console, expectedLevel = null) {
  const searchText = normalizeWhitespace(sourceMessage.substring(0, Math.min(80, sourceMessage.length)));
  const expectedTagLabel = formatExpectedTagLabel(expectedLevel);

  logger.log('[gateway-client] Searching for response...');
  logger.log('[gateway-client]   searchText:', searchText.substring(0, 60));
  logger.log('[gateway-client]   expectedTag:', expectedTagLabel);

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;

    const rawText = extractTextContent(messages[i].content);
    const textNorm = normalizeWhitespace(rawText.substring(0, 120));
    logger.log('[gateway-client]   Checking message', i, ':', textNorm.substring(0, 60));

    if (!sourceTextMatchesCandidate(rawText, sourceMessage)) {
      continue;
    }

    logger.log('[gateway-client]   ✅ Found our message at index', i);

    const requestTs = extractTimestampMs(messages[i]);
    if (requestTs !== null) {
      let bestResponse = '';
      let bestTs = Number.POSITIVE_INFINITY;

      for (let j = 0; j < messages.length; j++) {
        if (messages[j]?.role !== 'assistant') continue;
        const response = extractTextContent(messages[j].content);
        if (!hasArtifactTagForLevel(response, expectedLevel)) continue;

        const responseTs = extractTimestampMs(messages[j]);
        if (responseTs === null || responseTs <= requestTs) continue;

        if (responseTs < bestTs) {
          bestTs = responseTs;
          bestResponse = response;
        }
      }

      if (bestResponse) {
        logger.log('[gateway-client]   ✅ Found response by timestamp, ts=', new Date(bestTs).toISOString());
        logger.log('[gateway-client]   Response preview:', bestResponse.substring(0, 100));
        return bestResponse;
      }
    }

    const newestFirst = isNewestFirst(messages);
    const min = Math.max(0, i - 10);
    const max = Math.min(messages.length - 1, i + 10);

    const tryIndex = (j) => {
      if (messages[j]?.role !== 'assistant') return '';
      const response = extractTextContent(messages[j].content);
      if (!hasArtifactTagForLevel(response, expectedLevel)) {
        logger.log('[gateway-client]   ⏭️  Skipping assistant at index', j, `(missing ${expectedTagLabel})`);
        return '';
      }
      logger.log('[gateway-client]   ✅ Found response with artifact at index', j, ', length:', response.length);
      logger.log('[gateway-client]   Response preview:', response.substring(0, 100));
      return response;
    };

    if (newestFirst) {
      for (let j = i - 1; j >= min; j--) {
        const found = tryIndex(j);
        if (found) return found;
      }
    } else {
      for (let j = i + 1; j <= max; j++) {
        const found = tryIndex(j);
        if (found) return found;
      }
    }

    if (newestFirst) {
      for (let j = i + 1; j <= max; j++) {
        const found = tryIndex(j);
        if (found) return found;
      }
    } else {
      for (let j = i - 1; j >= min; j--) {
        const found = tryIndex(j);
        if (found) return found;
      }
    }

    logger.log('[gateway-client]   ❌ No assistant response with expected artifact tag found near index', i);
  }

  return '';
}

module.exports = {
  extractTextContent,
  normalizeWhitespace,
  extractTimestampMs,
  isNewestFirst,
  sourceTextMatchesCandidate,
  getArtifactTagName,
  hasArtifactTagForLevel,
  collectArtifactFromMessages,
  findArtifactInHistory
};
