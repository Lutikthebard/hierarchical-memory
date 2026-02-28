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
});
