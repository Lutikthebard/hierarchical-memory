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

  it('sends selected blocks sequentially as learn chunk messages', async () => {
    const sendCalls = [];

    const svc = createLearnContextService({
      sendChatMessage: async ({ message }) => {
        sendCalls.push({ message });
        return { success: true, runId: `run-${sendCalls.length}` };
      }
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
      sendToSession: true
    });

    assert.equal(run.blocks.total, 4);
    assert.equal(run.blocks.selected, 2);
    assert.equal(run.sentToSession, 2);
    assert.equal(sendCalls.length, 2);
    assert.match(sendCalls[0].message, /LEARN CONTEXT BLOCK/);
    assert.match(sendCalls[0].message, /Extract durable product knowledge/);
    assert.equal(run.skippedInMockMode, false);
  });

  it('supports cancellation between chunks', async () => {
    const sendCalls = [];
    let cancelRequested = false;

    const svc = createLearnContextService({
      sendChatMessage: async ({ message }) => {
        sendCalls.push({ message });
        if (sendCalls.length === 1) {
          cancelRequested = true;
        }
        return { success: true, runId: `run-${sendCalls.length}` };
      }
    });

    await assert.rejects(
      () => svc.runLearnContext({
        agentId: 'main',
        sessionKey: 'agent:main:main',
        text: 'a b c d e f',
        wordsPerBlock: 2,
        learningIntent: 'intent',
        l1ArtifactPrompt: 'prompt',
        sendToSession: true,
        shouldCancel: () => cancelRequested
      }),
      (err) => {
        assert.equal(err.code, 'LEARN_CONTEXT_CANCELLED');
        assert.equal(err.sentToSession, 1);
        assert.equal(err.totalChunks, 3);
        return true;
      }
    );
  });
});
