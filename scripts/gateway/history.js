const { sleep } = require('./retry');
const { findArtifactInHistory } = require('./artifact-extract');

async function waitForArtifactResponse({
  rpc,
  sessionKey,
  message,
  expectedLevel = null,
  postWaitWindowMs,
  postWaitPollIntervalMs,
  logger = console
}) {
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt <= postWaitWindowMs) {
    attempts++;
    logger.log(`[gateway-client] Step 3: Fetching chat history (attempt ${attempts})...`);

    const history = await rpc(
      'chat.history',
      {
        sessionKey,
        limit: 20
      },
      10000
    );

    const messages = history.messages || [];
    logger.log('[gateway-client] chat.history returned', messages.length, 'messages');

    const response = findArtifactInHistory(messages, message, logger, expectedLevel);
    if (response) {
      return response;
    }

    if (Date.now() - startedAt + postWaitPollIntervalMs > postWaitWindowMs) {
      break;
    }
    await sleep(postWaitPollIntervalMs);
  }

  return '';
}

module.exports = {
  waitForArtifactResponse
};
