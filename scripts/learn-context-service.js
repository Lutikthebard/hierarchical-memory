const { sendChatMessage } = require('./context-actions');
const { toPositiveInt } = require('./summarization-thresholds');

function splitTextIntoWordBlocks(text, wordsPerBlock) {
  const rawWords = String(text || '')
    .replace(/\r/g, '\n')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (rawWords.length === 0) {
    return [];
  }

  const size = toPositiveInt(wordsPerBlock) || 180;
  const blocks = [];
  for (let i = 0; i < rawWords.length; i += size) {
    const words = rawWords.slice(i, i + size);
    blocks.push({
      blockIndex: blocks.length + 1,
      startWord: i + 1,
      endWord: i + words.length,
      text: words.join(' ')
    });
  }
  return blocks;
}

function sliceBlocks(blocks, fromBlock, toBlock) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];

  const from = toPositiveInt(fromBlock) || 1;
  const to = toPositiveInt(toBlock) || blocks.length;

  if (from > to) {
    throw new Error(`Invalid block range: fromBlock (${from}) > toBlock (${to})`);
  }
  if (from > blocks.length) {
    throw new Error(`fromBlock (${from}) is out of range (max ${blocks.length})`);
  }

  return blocks.filter((block) => block.blockIndex >= from && block.blockIndex <= to);
}

function buildLearnChunkMessage(block, totalBlocks, learningIntent, l1ArtifactPrompt) {
  const intent = String(learningIntent || '').trim();
  const extra = String(l1ArtifactPrompt || '').trim();

  const parts = [
    'LEARN CONTEXT BLOCK',
    `Block ${block.blockIndex}/${totalBlocks} (words ${block.startWord}-${block.endWord}).`,
    'Task: ingest this source text as durable working knowledge for future tasks.'
  ];

  if (intent) {
    parts.push(`Learning intent:\n${intent}`);
  }
  if (extra) {
    parts.push(`Focus guidance:\n${extra}`);
  }

  parts.push(`Source text:\n${block.text}`);
  parts.push('A detailed reply is optional.');

  return parts.filter(Boolean).join('\n\n');
}

function createLearnContextService(deps = {}) {
  const runtime = {
    sendChatMessage: deps.sendChatMessage || sendChatMessage
  };

  function buildCancelledError(sentToSession, totalChunks) {
    const err = new Error('Learn Context run cancelled');
    err.code = 'LEARN_CONTEXT_CANCELLED';
    err.sentToSession = sentToSession;
    err.totalChunks = totalChunks;
    return err;
  }

  async function runLearnContext({
    agentId,
    sessionKey,
    text,
    wordsPerBlock,
    fromBlock,
    toBlock,
    learningIntent,
    l1ArtifactPrompt,
    sendToSession,
    shouldCancel
  } = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }
    if (!sessionKey) {
      throw new Error('sessionKey is required');
    }

    const blocks = splitTextIntoWordBlocks(text, wordsPerBlock);
    if (blocks.length === 0) {
      throw new Error('text must contain at least one word');
    }

    const selectedBlocks = sliceBlocks(blocks, fromBlock, toBlock);
    if (selectedBlocks.length === 0) {
      throw new Error('no blocks selected');
    }

    const isMockMode = String(process.env.HM_LLM_MODE || '').trim().toLowerCase() === 'mock';
    const shouldSendToSession = sendToSession === true
      ? true
      : (sendToSession !== false && !isMockMode);

    const chunkMessages = selectedBlocks.map((block) => ({
      block,
      message: buildLearnChunkMessage(block, selectedBlocks.length, learningIntent, l1ArtifactPrompt)
    }));

    let sentToSession = 0;

    for (const item of chunkMessages) {
      if (!shouldSendToSession) break;
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        throw buildCancelledError(sentToSession, chunkMessages.length);
      }
      await runtime.sendChatMessage({
        sessionKey,
        message: item.message
      });
      sentToSession += 1;
    }

    return {
      agentId,
      blocks: {
        total: blocks.length,
        selected: selectedBlocks.length,
        from: selectedBlocks[0]?.blockIndex || null,
        to: selectedBlocks[selectedBlocks.length - 1]?.blockIndex || null,
        wordsPerBlock: toPositiveInt(wordsPerBlock) || 180
      },
      sentToSession,
      skippedInMockMode: !shouldSendToSession && isMockMode,
      completedAt: new Date().toISOString()
    };
  }

  return {
    runLearnContext,
    splitTextIntoWordBlocks,
    sliceBlocks
  };
}

module.exports = {
  createLearnContextService,
  splitTextIntoWordBlocks,
  sliceBlocks
};
