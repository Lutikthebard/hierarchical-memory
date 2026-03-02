const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createLearnContextService,
  splitTextIntoWordBlocks,
  sliceBlocks
} = require('../scripts/learn-context-service');

describe('learn-context service', () => {
  it('splits and slices text by word blocks', () => {
    const blocks = splitTextIntoWordBlocks('one two three four five six seven', 3);
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].text, 'one two three');
    assert.equal(blocks[1].text, 'four five six');
    assert.equal(blocks[2].text, 'seven');

    const range = sliceBlocks(blocks, 2, 3);
    assert.equal(range.length, 2);
    assert.equal(range[0].blockIndex, 2);
    assert.equal(range[1].blockIndex, 3);
  });

  it('runs L1 ingestion and optional full summarization with runtime overrides', async () => {
    const l1Calls = [];
    const fullCalls = [];

    const svc = createLearnContextService({
      loadAgentConfig: () => ({
        thresholds: { L1: 60, default: 5 },
        prompts: {
          l1: 'BASE L1 PROMPT',
          aggregate: 'BASE AGGREGATE {level}'
        }
      }),
      handleL1FromMessages: async (_agentId, _sessionKey, messages, options = {}) => {
        l1Calls.push({ messages, options });
        return { artifactId: `a-${l1Calls.length}` };
      },
      runFullSummarization: async (options = {}) => {
        fullCalls.push(options);
        return { passes: [{ sourceLevel: 1, targetLevel: 2 }] };
      },
      logger: { log: () => {} }
    });

    const run = await svc.runLearnContext({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      text: 'alpha beta gamma delta epsilon zeta eta theta',
      wordsPerBlock: 2,
      fromBlock: 2,
      toBlock: 3,
      learningIntent: 'Extract durable product knowledge.',
      l1ArtifactPrompt: 'Keep bullets concise.',
      thresholds: { L2: 2, default: 3 },
      aggregatePrompt: 'Aggregate prompt generic.',
      aggregatePromptsByLevel: { '1': 'L1->L2 custom', '2': 'L2->L3 custom' },
      runFullSummarize: true,
      maxTargetLevel: 6,
      aggregateBatch: 4
    });

    assert.equal(run.blocks.total, 4);
    assert.equal(run.blocks.selected, 2);
    assert.equal(run.l1.created, 2);
    assert.equal(l1Calls.length, 2);
    assert.match(l1Calls[0].options.l1PromptOverride, /BASE L1 PROMPT/);
    assert.match(l1Calls[0].options.l1PromptOverride, /Learning intent:/);
    assert.equal(l1Calls[0].options.thresholdOverride, 1);

    assert.equal(fullCalls.length, 1);
    assert.equal(fullCalls[0].startSourceLevel, 1);
    assert.equal(fullCalls[0].maxTargetLevel, 6);
    assert.equal(fullCalls[0].aggregateBatch, 4);
    assert.equal(fullCalls[0].runtimeConfigOverrides.thresholds.L2, 2);
    assert.equal(fullCalls[0].runtimeConfigOverrides.prompts.aggregate, 'Aggregate prompt generic.');
    assert.equal(fullCalls[0].aggregatePromptBySourceLevel['1'], 'L1->L2 custom');
    assert.equal(run.fullSummarize.enabled, true);
  });
});
