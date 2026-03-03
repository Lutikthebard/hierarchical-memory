const { createLLMAdapterFromEnv } = require('../llm-adapter');

let llmAdapter = null;
let adapterMode = 'openclaw';

function setAdapter(adapter, mode = 'custom') {
  llmAdapter = adapter || null;
  adapterMode = mode;
}

function getAdapter() {
  if (!llmAdapter) {
    const config = createLLMAdapterFromEnv();
    adapterMode = config.mode;
    llmAdapter = config.adapter;
    console.log(`[trigger] LLM adapter mode: ${adapterMode}`);
  }
  return llmAdapter;
}

async function closeAdapter() {
  if (llmAdapter && typeof llmAdapter.close === 'function') {
    await llmAdapter.close();
  }
  llmAdapter = null;
}

async function sendToAgent(agentId, message, sessionKey = null, targetLevel = null) {
  console.log(`[trigger] Sending to agent: ${agentId}`);
  const adapter = getAdapter();
  const reply = await adapter.send(agentId, message, { sessionKey, targetLevel });
  const captureInfo = adapter.lastCaptureInfo;

  console.log(`[trigger] Got response (${reply.length} chars, capture: ${captureInfo?.method ?? 'unknown'}, collected: ${captureInfo?.collectedCount ?? '?'})`);

  return { reply, captureInfo };
}

module.exports = {
  setAdapter,
  getAdapter,
  closeAdapter,
  sendToAgent
};
