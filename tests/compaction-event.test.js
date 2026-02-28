const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCompactionEventHandler } = require('../scripts/watch-runtime/compaction-event');

function createDeps(overrides = {}) {
  let resets = 0;
  let injects = 0;

  const deps = {
    compactController: {
      getState: () => ({
        sessionMessageCount: 4,
        awaitingCompaction: false,
        compactRetryCount: 0
      }),
      resetAfterCompaction: () => {
        resets += 1;
      }
    },
    loadAgentConfig: () => ({
      autoInjectContext: {
        enabled: true,
        onCompaction: true
      }
    }),
    scheduleContextInject: () => {
      injects += 1;
    },
    log: () => {}
  };

  return {
    deps: { ...deps, ...overrides },
    counters: {
      get resets() {
        return resets;
      },
      get injects() {
        return injects;
      }
    }
  };
}

describe('compaction-event handler', () => {
  it('deduplicates identical compaction line inside dedupe window', () => {
    let nowMs = 1000;
    const { deps, counters } = createDeps({
      now: () => nowMs,
      dedupeWindowMs: 15000
    });
    const handler = createCompactionEventHandler(deps);
    const line = JSON.stringify({ type: 'compaction', tokensBefore: 12345 });

    assert.equal(handler(line, 'main'), true);
    assert.equal(handler(line, 'main'), true);

    assert.equal(counters.injects, 1);
    assert.equal(counters.resets, 1);
  });

  it('does not deduplicate different compaction payloads', () => {
    let nowMs = 1000;
    const { deps, counters } = createDeps({
      now: () => nowMs,
      dedupeWindowMs: 15000
    });
    const handler = createCompactionEventHandler(deps);

    assert.equal(handler(JSON.stringify({ type: 'compaction', tokensBefore: 100 }), 'main'), true);
    nowMs += 1000;
    assert.equal(handler(JSON.stringify({ type: 'compaction', tokensBefore: 200 }), 'main'), true);

    assert.equal(counters.injects, 2);
    assert.equal(counters.resets, 2);
  });

  it('allows same compaction line again after dedupe window', () => {
    let nowMs = 1000;
    const { deps, counters } = createDeps({
      now: () => nowMs,
      dedupeWindowMs: 500
    });
    const handler = createCompactionEventHandler(deps);
    const line = JSON.stringify({ type: 'compaction', tokensBefore: 777 });

    assert.equal(handler(line, 'main'), true);
    nowMs += 1000;
    assert.equal(handler(line, 'main'), true);

    assert.equal(counters.injects, 2);
    assert.equal(counters.resets, 2);
  });
});
