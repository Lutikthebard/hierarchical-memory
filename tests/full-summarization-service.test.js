const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createFullSummarizationService } = require('../scripts/full-summarization-service');

function buildStoreWithTopLevel(maxLevel) {
  const artifacts = {};
  for (let level = 1; level <= maxLevel; level += 1) {
    artifacts[level] = [{ artifactId: `L${level}-seed` }];
  }
  return { messages: [], artifacts };
}

describe('full summarization service', () => {
  it('by default drains all tails up to current top level', async () => {
    const unsummarized = {
      0: 5,
      1: 3,
      2: 2
    };
    const calls = [];

    const svc = createFullSummarizationService({
      loadStore: () => buildStoreWithTopLevel(3),
      loadAgentConfig: () => ({ thresholds: { L1: 4, default: 2 } }),
      getThresholdForLevel: (level) => (level === 1 ? 4 : 2),
      getUnsummarized: (_store, sourceLevel) =>
        Array.from({ length: unsummarized[sourceLevel] || 0 }, (_, idx) => ({
          timestamp: `2026-03-01T00:00:${String(idx).padStart(2, '0')}.000Z`,
          endTimestamp: `2026-03-01T00:00:${String(idx).padStart(2, '0')}.000Z`
        })),
      filterForCounting: (messages) => messages,
      handleL1: async (_agentId, _sessionKey, options = {}) => {
        const batch = Number(options.thresholdOverride || 0);
        calls.push({ kind: 'l1', batch });
        unsummarized[0] = Math.max(0, (unsummarized[0] || 0) - batch);
        unsummarized[1] = (unsummarized[1] || 0) + 1;
      },
      handleAggregate: async (_agentId, _sessionKey, sourceLevel, options = {}) => {
        const batch = Number(options.thresholdOverride || 0);
        calls.push({ kind: `l${sourceLevel}`, batch });
        unsummarized[sourceLevel] = Math.max(0, (unsummarized[sourceLevel] || 0) - batch);
        unsummarized[sourceLevel + 1] = (unsummarized[sourceLevel + 1] || 0) + 1;
      },
      logger: { log: () => {} }
    });

    const result = await svc.runFullSummarization({
      agentId: 'main',
      sessionKey: 'agent:main:main'
    });

    assert.equal(result.maxTargetLevel, 3);
    assert.equal(result.warnings.length, 0);
    assert.equal(unsummarized[0], 0);
    assert.equal(unsummarized[1], 0);
    assert.equal(unsummarized[2], 0);

    const tailBatches = calls.filter((call) => call.batch === 1);
    assert.ok(tailBatches.length >= 3, 'expected tail flush batches for each source level');
  });

  it('respects maxTargetLevel and aggregateBatch overrides', async () => {
    const unsummarized = {
      0: 6,
      1: 8,
      2: 7
    };
    const calls = [];

    const svc = createFullSummarizationService({
      loadStore: () => buildStoreWithTopLevel(4),
      loadAgentConfig: () => ({ thresholds: { L1: 5, default: 2 } }),
      getThresholdForLevel: (level) => (level === 1 ? 5 : 2),
      getUnsummarized: (_store, sourceLevel) =>
        Array.from({ length: unsummarized[sourceLevel] || 0 }, (_, idx) => ({
          timestamp: `2026-03-01T00:00:${String(idx).padStart(2, '0')}.000Z`,
          endTimestamp: `2026-03-01T00:00:${String(idx).padStart(2, '0')}.000Z`
        })),
      filterForCounting: (messages) => messages,
      handleL1: async (_agentId, _sessionKey, options = {}) => {
        const batch = Number(options.thresholdOverride || 0);
        calls.push({ level: 0, batch });
        unsummarized[0] = Math.max(0, unsummarized[0] - batch);
      },
      handleAggregate: async (_agentId, _sessionKey, sourceLevel, options = {}) => {
        const batch = Number(options.thresholdOverride || 0);
        calls.push({ level: sourceLevel, batch });
        unsummarized[sourceLevel] = Math.max(0, unsummarized[sourceLevel] - batch);
      },
      logger: { log: () => {} }
    });

    const result = await svc.runFullSummarization({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      maxTargetLevel: 2,
      aggregateBatch: 3
    });

    assert.equal(result.maxTargetLevel, 2);
    assert.equal(unsummarized[0], 0);
    assert.equal(unsummarized[1], 0);
    assert.equal(unsummarized[2], 7);

    const l1Calls = calls.filter((call) => call.level === 1);
    assert.ok(l1Calls.some((call) => call.batch === 3), 'expected aggregateBatch to be used');
    assert.equal(calls.some((call) => call.level === 2), false, 'maxTargetLevel should stop before L2->L3');
  });
});
