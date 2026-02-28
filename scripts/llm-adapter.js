const { OpenClawClient } = require('./gateway-client');

class OpenClawLLMAdapter {
  constructor(options = {}) {
    this.gatewayUrl = options.gatewayUrl ?? process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';
    this.gatewayToken = options.gatewayToken ?? process.env.GATEWAY_TOKEN ?? '';
    this.timeoutSeconds = options.timeoutSeconds ?? (parseInt(process.env.TRIGGER_TIMEOUT_SEC, 10) || 600);
    this.client = null;
  }

  async connect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (_e) {}
    }
    this.client = new OpenClawClient(this.gatewayUrl, this.gatewayToken);
    await this.client.connect();
  }

  async send(agentId, message, options = {}) {
    await this.connect();
    return this.client.sendToAgent(
      agentId,
      message,
      this.timeoutSeconds,
      options.sessionKey || null,
      options.targetLevel || null
    );
  }

  get lastCaptureInfo() {
    return this.client?._lastCaptureInfo ?? null;
  }

  async close() {
    if (!this.client) {
      return;
    }
    try {
      await this.client.close();
    } finally {
      this.client = null;
    }
  }
}

function summarizePrompt(prompt) {
  const msgMatch = prompt.match(/Summarize (\d+) messages/);
  const aggregateMatch = prompt.match(/Aggregate (\d+) L(\d+) summaries(?: into L(\d+))?/);

  if (msgMatch) {
    return `MOCK L1 SUMMARY: summarized ${msgMatch[1]} messages.`;
  }

  if (aggregateMatch) {
    const targetLevel = aggregateMatch[3] || String(Number(aggregateMatch[2]) + 1);
    return `MOCK L${targetLevel} SUMMARY: aggregated ${aggregateMatch[1]} L${aggregateMatch[2]} artifacts.`;
  }
  return 'MOCK L1 SUMMARY: deterministic offline response.';
}

class MockLLMAdapter {
  async send(_agentId, message, options = {}) {
    const body = summarizePrompt(message);
    const targetLevel = Number.isInteger(Number(options.targetLevel)) && Number(options.targetLevel) > 0
      ? Number(options.targetLevel)
      : 1;
    const tag = `memory_artifact_L${targetLevel}`;
    return `<${tag}>${body}</${tag}>\nNO_REPLY`;
  }

  get lastCaptureInfo() {
    return { method: 'mock', collectedCount: 0 };
  }

  async close() {}
}

function createLLMAdapterFromEnv() {
  const mode = (process.env.HM_LLM_MODE || 'openclaw').toLowerCase();
  if (mode === 'mock') {
    return { mode, adapter: new MockLLMAdapter() };
  }
  return {
    mode,
    adapter: new OpenClawLLMAdapter()
  };
}

module.exports = {
  OpenClawLLMAdapter,
  MockLLMAdapter,
  createLLMAdapterFromEnv
};
