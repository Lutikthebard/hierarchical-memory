const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { OpenClawClient } = require('../scripts/gateway-client');

describe('gateway-client sendToAgent history-based artifact capture', () => {
  it('returns artifact found in chat history after agent.wait', async () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token', {
      postWaitWindowMs: 200,
      postWaitPollIntervalMs: 10
    });

    let historyCalls = 0;
    client.rpc = async (method, params) => {
      if (method === 'chat.send') {
        assert.equal(params.sessionKey, 'agent:main:main');
        return { runId: 'run-1' };
      }
      if (method === 'agent.wait') return { done: true };
      if (method === 'chat.history') {
        historyCalls += 1;
        if (historyCalls < 2) {
          return {
            messages: [
              { role: 'user', content: 'Summarize 5 messages', timestamp: '2026-02-10T10:00:00.000Z' }
            ]
          };
        }
        return {
          messages: [
            { role: 'assistant', content: '<memory_artifact_L1>L1 summary result</memory_artifact_L1>\nNO_REPLY', timestamp: '2026-02-10T10:00:01.000Z' },
            { role: 'user', content: 'Summarize 5 messages', timestamp: '2026-02-10T10:00:00.000Z' }
          ]
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const result = await client.sendToAgent('main', 'Summarize 5 messages', 10);
    assert.match(result, /<memory_artifact_L1>L1 summary result<\/memory_artifact_L1>/);
    assert.deepEqual(client._lastCaptureInfo, { method: 'history', collectedCount: 1 });
  });

  it('returns empty string when no artifact is found in chat history window', async () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token', {
      postWaitWindowMs: 50,
      postWaitPollIntervalMs: 10
    });

    client.rpc = async (method) => {
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'agent.wait') return { done: true };
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'assistant', content: 'still processing', timestamp: '2026-02-10T10:00:01.000Z' },
            { role: 'user', content: 'Summarize', timestamp: '2026-02-10T10:00:00.000Z' }
          ]
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const result = await client.sendToAgent('main', 'Summarize', 10);
    assert.equal(result, '');
    assert.deepEqual(client._lastCaptureInfo, { method: 'history', collectedCount: 0 });
  });

  it('calls chat.history while waiting for artifact', async () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token', {
      postWaitWindowMs: 40,
      postWaitPollIntervalMs: 10
    });
    const calledMethods = [];

    client.rpc = async (method) => {
      calledMethods.push(method);
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'agent.wait') return { done: true };
      if (method === 'chat.history') return { messages: [] };
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    await client.sendToAgent('main', 'test', 10);
    assert.ok(calledMethods.includes('chat.history'), 'must call chat.history');
  });

  it('uses sessionKey override when provided', async () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token', {
      postWaitWindowMs: 200,
      postWaitPollIntervalMs: 10
    });

    let sentSessionKey = null;
    client.rpc = async (method, params) => {
      if (method === 'chat.send') {
        sentSessionKey = params.sessionKey;
        return { runId: 'run-1' };
      }
      if (method === 'agent.wait') return { done: true };
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'assistant', content: '<memory_artifact_L1>session-override</memory_artifact_L1>\nNO_REPLY', timestamp: '2026-02-10T10:00:01.000Z' },
            { role: 'user', content: 'test', timestamp: '2026-02-10T10:00:00.000Z' }
          ]
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const response = await client.sendToAgent('main', 'test', 10, 'agent:subagent');
    assert.match(response, /session-override/);
    assert.equal(sentSessionKey, 'agent:subagent');
  });

  it('captures only expected artifact level from history when levels are adjacent', async () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token', {
      postWaitWindowMs: 80,
      postWaitPollIntervalMs: 10
    });

    client.rpc = async (method) => {
      if (method === 'chat.send') return { runId: 'run-1' };
      if (method === 'agent.wait') return { done: true };
      if (method === 'chat.history') {
        return {
          messages: [
            { role: 'assistant', content: '<memory_artifact_L2>correct-level</memory_artifact_L2>\nNO_REPLY', timestamp: '2026-02-10T10:00:03.000Z' },
            { role: 'assistant', content: '<memory_artifact_L1>wrong-level</memory_artifact_L1>\nNO_REPLY', timestamp: '2026-02-10T10:00:02.000Z' },
            { role: 'user', content: 'Aggregate 2 L1 summaries into L2', timestamp: '2026-02-10T10:00:01.000Z' }
          ]
        };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const result = await client.sendToAgent(
      'main',
      'Aggregate 2 L1 summaries into L2',
      10,
      null,
      2
    );
    assert.match(result, /<memory_artifact_L2>correct-level<\/memory_artifact_L2>/);
  });
});

describe('gateway-client collectArtifactFromMessages', () => {
  it('is importable and works standalone', () => {
    const { collectArtifactFromMessages } = require('../scripts/gateway/artifact-extract');

    const messages = [
      { role: 'user', content: 'do stuff' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '<memory_artifact_L1>data</memory_artifact_L1>\nNO_REPLY' }
    ];

    const result = collectArtifactFromMessages(messages);
    assert.match(result, /<memory_artifact_L1>data<\/memory_artifact_L1>/);
  });

  it('returns empty for no artifact', () => {
    const { collectArtifactFromMessages } = require('../scripts/gateway/artifact-extract');

    const messages = [
      { role: 'assistant', content: 'just talking' },
      { role: 'user', content: 'ok' }
    ];

    assert.equal(collectArtifactFromMessages(messages), '');
  });

  it('returns empty for empty array', () => {
    const { collectArtifactFromMessages } = require('../scripts/gateway/artifact-extract');
    assert.equal(collectArtifactFromMessages([]), '');
  });

  it('handles array content format', () => {
    const { collectArtifactFromMessages } = require('../scripts/gateway/artifact-extract');

    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '<memory_artifact_L3>array-content</memory_artifact_L3>\nNO_REPLY' }
        ]
      }
    ];

    const result = collectArtifactFromMessages(messages);
    assert.match(result, /<memory_artifact_L3>array-content<\/memory_artifact_L3>/);
  });

  it('filters by expected level in collected messages', () => {
    const { collectArtifactFromMessages } = require('../scripts/gateway/artifact-extract');

    const messages = [
      { role: 'assistant', content: '<memory_artifact_L2>older</memory_artifact_L2>\nNO_REPLY' },
      { role: 'assistant', content: '<memory_artifact_L1>newer</memory_artifact_L1>\nNO_REPLY' }
    ];

    const result = collectArtifactFromMessages(messages, 2);
    assert.match(result, /<memory_artifact_L2>older<\/memory_artifact_L2>/);
  });
});

describe('gateway-client connect auth payload', () => {
  it('sends both token and password when both are available', () => {
    const client = new OpenClawClient('ws://127.0.0.1:18789', 'token-value', {
      gatewayPassword: 'password-value'
    });
    let sentFrame = null;
    client._id = () => 'req-1';
    client._send = (frame) => { sentFrame = frame; };

    client._sendConnectRequest(Date.now(), 'nonce-1');

    assert.equal(sentFrame.method, 'connect');
    assert.deepEqual(sentFrame.params.auth, {
      token: 'token-value',
      password: 'password-value'
    });
  });
});
