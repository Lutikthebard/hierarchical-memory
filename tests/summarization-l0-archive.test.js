const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { archiveSummarizedL0Messages } = require('../scripts/summarization-l0-archive');

describe('summarization-l0-archive', () => {
  it('archives and removes only explicitly summarized messages', async () => {
    const t1 = '2026-03-02T10:00:00.000Z';
    const t2 = '2026-03-02T10:01:00.000Z';
    const t3 = '2026-03-02T10:02:00.000Z';
    const t4 = '2026-03-02T10:03:00.000Z';
    const store = {
      messages: [
        { role: 'user', content: 'm1', timestamp: t1 },
        { role: 'assistant', content: 'm2', timestamp: t2 },
        { role: 'user', content: 'm3', timestamp: t3 },
        { role: 'assistant', content: 'm4', timestamp: t4 }
      ],
      artifacts: {}
    };

    const archived = [];
    const result = await archiveSummarizedL0Messages('main', store, {
      archiveMessages: (_agentId, items) => archived.push(...items),
      saveStore: () => {},
      summarizedMessageTimestamps: [t2, t4]
    });

    assert.equal(result.archived, 2);
    assert.equal(result.removed, 2);
    assert.deepEqual(
      store.messages.map((m) => m.timestamp),
      [t1, t3]
    );
    assert.deepEqual(
      archived.map((m) => m.timestamp),
      [t2, t4]
    );
  });

  it('does nothing when summarized list is empty', async () => {
    const t1 = '2026-03-02T11:00:00.000Z';
    const t2 = '2026-03-02T11:01:00.000Z';
    const store = {
      messages: [
        { role: 'user', content: 'm1', timestamp: t1 },
        { role: 'assistant', content: 'm2', timestamp: t2 }
      ],
      artifacts: {}
    };

    const archived = [];
    const result = await archiveSummarizedL0Messages('main', store, {
      archiveMessages: (_agentId, items) => archived.push(...items),
      saveStore: () => {},
      summarizedMessageTimestamps: []
    });

    assert.equal(result.archived, 0);
    assert.equal(result.removed, 0);
    assert.deepEqual(
      store.messages.map((m) => m.timestamp),
      [t1, t2]
    );
    assert.deepEqual(archived, []);
  });

  it('applies removal to latest store when updateStore is provided', async () => {
    const t1 = '2026-03-02T12:00:00.000Z';
    const t2 = '2026-03-02T12:01:00.000Z';
    const t3 = '2026-03-02T12:02:00.000Z';

    const staleStore = {
      messages: [
        { role: 'user', content: 'stale-1', timestamp: t1 },
        { role: 'assistant', content: 'stale-2', timestamp: t2 }
      ],
      artifacts: {}
    };

    const latestStore = {
      messages: [
        { role: 'user', content: 'latest-1', timestamp: t1 },
        { role: 'assistant', content: 'latest-2', timestamp: t2 },
        { role: 'user', content: 'latest-3', timestamp: t3 }
      ],
      artifacts: {}
    };

    const archived = [];
    const result = await archiveSummarizedL0Messages('main', staleStore, {
      archiveMessages: (_agentId, items) => archived.push(...items),
      updateStore: async (_agentId, mutator) => {
        const out = await mutator(latestStore);
        return { store: latestStore, result: out };
      },
      summarizedMessageTimestamps: [t1, t2]
    });

    assert.equal(result.archived, 2);
    assert.equal(result.removed, 2);
    assert.deepEqual(
      latestStore.messages.map((m) => m.timestamp),
      [t3]
    );
    assert.deepEqual(
      archived.map((m) => m.timestamp),
      [t1, t2]
    );
  });
});
