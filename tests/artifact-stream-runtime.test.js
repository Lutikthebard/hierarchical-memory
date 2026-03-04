const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createArtifactStreamRuntime } = require('../scripts/watch-runtime/artifact-stream-runtime');

function makeMessageLine({ role = 'assistant', content, timestamp, outerTimestamp = null, sessionKey = null }) {
  return JSON.stringify({
    type: 'message',
    ...(outerTimestamp ? { timestamp: outerTimestamp } : {}),
    message: {
      role,
      content,
      timestamp,
      ...(sessionKey ? { sessionKey } : {})
    }
  });
}

describe('artifact stream runtime', () => {
  it('resolves waiter when assistant memory artifact appears in stream', async () => {
    const runtime = createArtifactStreamRuntime();
    const startedAtMs = Date.parse('2026-02-27T10:00:00.000Z');

    const waiter = runtime.waitForArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      startedAtMs,
      timeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>hello</memory_artifact_L1>\nNO_REPLY',
        timestamp: '2026-02-27T10:00:01.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /<memory_artifact_L1>hello<\/memory_artifact_L1>/);
  });

  it('ignores artifacts that are older than waiter start time', async () => {
    const runtime = createArtifactStreamRuntime();
    const waiter = runtime.waitForArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      startedAtMs: Date.parse('2026-02-27T10:00:10.000Z'),
      timeoutMs: 80
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>too-old</memory_artifact_L1>',
        timestamp: '2026-02-27T10:00:01.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    await assert.rejects(waiter.promise, /artifact_wait_timeout/);
  });

  it('matches even if event has no explicit sessionKey (single stream fallback)', async () => {
    const runtime = createArtifactStreamRuntime();
    const waiter = runtime.waitForArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      startedAtMs: Date.parse('2026-02-27T10:00:00.000Z'),
      timeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>ok</memory_artifact_L1>',
        timestamp: '2026-02-27T10:00:01.000Z'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /<memory_artifact_L1>ok<\/memory_artifact_L1>/);
  });

  it('uses top-level event timestamp when message timestamp is stale', async () => {
    const runtime = createArtifactStreamRuntime();
    const waiter = runtime.waitForArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      startedAtMs: Date.parse('2026-02-27T10:00:10.000Z'),
      timeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>delayed-write</memory_artifact_L1>',
        timestamp: '2026-02-27T10:00:01.000Z',
        outerTimestamp: '2026-02-27T10:00:55.000Z'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /<memory_artifact_L1>delayed-write<\/memory_artifact_L1>/);
  });

  it('matches only waiter level when different artifact levels are adjacent', async () => {
    const runtime = createArtifactStreamRuntime();
    const waiter = runtime.waitForArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      expectedLevel: 2,
      startedAtMs: Date.parse('2026-02-27T10:00:00.000Z'),
      timeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>l1-first</memory_artifact_L1>',
        timestamp: '2026-02-27T10:00:01.000Z',
        sessionKey: 'agent:a1:main'
      })
    });
    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L2>l2-second</memory_artifact_L2>',
        timestamp: '2026-02-27T10:00:02.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /<memory_artifact_L2>l2-second<\/memory_artifact_L2>/);
  });

  it('waits for delivery ACK before accepting artifact response', async () => {
    const runtime = createArtifactStreamRuntime();
    const sourceMessage = 'Summarize 30 messages from: 2026-03-04 00:30:00 UTC → 2026-03-04 00:44:21 UTC.';
    const waiter = runtime.waitForDeliveredArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      expectedLevel: 1,
      sourceMessage,
      startedAtMs: Date.parse('2026-03-04T00:44:39.000Z'),
      deliveryTimeoutMs: 1000,
      responseTimeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>too-early</memory_artifact_L1>',
        timestamp: '2026-03-04T00:45:00.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'user',
        content: sourceMessage,
        timestamp: '2026-03-04T00:45:10.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>accepted</memory_artifact_L1>\nNO_REPLY',
        timestamp: '2026-03-04T00:45:11.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /accepted/);
  });

  it('matches queued wrapper delivery ACK and then resolves on artifact', async () => {
    const runtime = createArtifactStreamRuntime();
    const sourceMessage = 'Summarize 30 messages from: 2026-03-04 00:30:00 UTC → 2026-03-04 00:44:21 UTC.';
    const waiter = runtime.waitForDeliveredArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      expectedLevel: 1,
      sourceMessage,
      startedAtMs: Date.parse('2026-03-04T00:44:39.000Z'),
      deliveryTimeoutMs: 1000,
      responseTimeoutMs: 1000
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'user',
        content: `[Queued messages while agent was busy]\n\n---\nQueued #1\n${sourceMessage}\n\n---\nQueued #2\nSomething else`,
        timestamp: '2026-03-04T01:05:36.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    runtime.observeLine({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      line: makeMessageLine({
        role: 'assistant',
        content: '<memory_artifact_L1>from-queue</memory_artifact_L1>\nNO_REPLY',
        timestamp: '2026-03-04T01:05:51.000Z',
        sessionKey: 'agent:a1:main'
      })
    });

    const result = await waiter.promise;
    assert.match(result, /from-queue/);
  });

  it('times out when delivery ACK is not observed', async () => {
    const runtime = createArtifactStreamRuntime();
    const waiter = runtime.waitForDeliveredArtifact({
      agentId: 'a1',
      sessionKey: 'agent:a1:main',
      expectedLevel: 1,
      sourceMessage: 'Summarize 30 messages from: 2026-03-04 00:30:00 UTC → 2026-03-04 00:44:21 UTC.',
      startedAtMs: Date.parse('2026-03-04T00:44:39.000Z'),
      deliveryTimeoutMs: 50,
      responseTimeoutMs: 1000
    });

    await assert.rejects(waiter.promise, /artifact_delivery_timeout/);
  });
});
