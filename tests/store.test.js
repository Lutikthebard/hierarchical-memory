const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmptyStore,
  addMessage,
  addArtifact,
  compareTimestamps,
  formatTimestamp,
  getUnsummarized,
  getLastSummarizedTimestamp,
  filterForCounting,
  checkThreshold
} = require('../scripts/store');

describe('store.js', () => {

  describe('createEmptyStore', () => {
    it('creates store with empty messages and artifacts', () => {
      const store = createEmptyStore();
      assert.deepStrictEqual(store.messages, []);
      assert.deepStrictEqual(store.artifacts, {});
    });
  });

  describe('addMessage', () => {
    let store;
    beforeEach(() => { store = createEmptyStore(); });

    it('adds a message with role, content, timestamp', () => {
      const msg = addMessage(store, {
        role: 'user',
        content: 'Hello',
        timestamp: '2026-01-01T10:00:00.000Z'
      });
      assert.equal(msg.role, 'user');
      assert.equal(msg.content, 'Hello');
      assert.equal(msg.timestamp, '2026-01-01T10:00:00.000Z');
      assert.equal(store.messages.length, 1);
    });

    it('skips duplicate timestamps', () => {
      addMessage(store, { role: 'user', content: 'A', timestamp: '2026-01-01T10:00:00.000Z' });
      const dup = addMessage(store, { role: 'assistant', content: 'B', timestamp: '2026-01-01T10:00:00.000Z' });
      assert.equal(dup, null);
      assert.equal(store.messages.length, 1);
    });

    it('generates timestamp if not provided', () => {
      const msg = addMessage(store, { role: 'user', content: 'test' });
      assert.ok(msg.timestamp);
      assert.ok(new Date(msg.timestamp).getTime() > 0);
    });

    it('converts numeric timestamp to ISO', () => {
      const ts = 1704067200000; // 2024-01-01T00:00:00.000Z
      const msg = addMessage(store, { role: 'user', content: 'test', timestamp: ts });
      assert.equal(msg.timestamp, new Date(ts).toISOString());
    });
  });

  describe('addArtifact', () => {
    let store;
    beforeEach(() => { store = createEmptyStore(); });

    it('adds artifact to correct level', () => {
      const art = addArtifact(store, 1, {
        content: 'Summary 1',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z',
        messageCount: 10
      });
      assert.equal(art.level, 1);
      assert.equal(art.content, 'Summary 1');
      assert.equal(store.artifacts[1].length, 1);
    });

    it('skips duplicate artifacts (same start+end)', () => {
      addArtifact(store, 1, {
        content: 'A',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z'
      });
      const dup = addArtifact(store, 1, {
        content: 'B',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z'
      });
      assert.equal(dup, null);
      assert.equal(store.artifacts[1].length, 1);
    });

    it('creates level array if not exists', () => {
      assert.equal(store.artifacts[2], undefined);
      addArtifact(store, 2, {
        content: 'L2',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-02T00:00:00.000Z'
      });
      assert.equal(store.artifacts[2].length, 1);
    });
  });

  describe('compareTimestamps', () => {
    it('returns -1 when ts1 < ts2', () => {
      assert.equal(compareTimestamps('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), -1);
    });

    it('returns 0 when equal', () => {
      assert.equal(compareTimestamps('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), 0);
    });

    it('returns 1 when ts1 > ts2', () => {
      assert.equal(compareTimestamps('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), 1);
    });

    it('handles null values', () => {
      assert.equal(compareTimestamps(null, null), 0);
      assert.equal(compareTimestamps(null, '2026-01-01T00:00:00Z'), -1);
      assert.equal(compareTimestamps('2026-01-01T00:00:00Z', null), 1);
    });
  });

  describe('formatTimestamp', () => {
    it('formats ISO timestamp nicely', () => {
      const result = formatTimestamp('2026-01-15T14:30:00.000Z');
      assert.ok(result.includes('2026-01-15'));
      assert.ok(result.includes('14:30:00'));
    });

    it('handles null', () => {
      assert.equal(formatTimestamp(null), 'N/A');
    });
  });

  describe('getLastSummarizedTimestamp', () => {
    it('returns null for empty level', () => {
      const store = createEmptyStore();
      assert.equal(getLastSummarizedTimestamp(store, 1), null);
    });

    it('returns latest endTimestamp', () => {
      const store = createEmptyStore();
      addArtifact(store, 1, {
        content: 'A',
        startTimestamp: '2026-01-01T00:00:00Z',
        endTimestamp: '2026-01-01T12:00:00Z'
      });
      addArtifact(store, 1, {
        content: 'B',
        startTimestamp: '2026-01-01T12:00:00Z',
        endTimestamp: '2026-01-02T00:00:00Z'
      });
      assert.equal(getLastSummarizedTimestamp(store, 1), '2026-01-02T00:00:00Z');
    });
  });

  describe('filterForCounting', () => {
    it('filters by countRoles', () => {
      const messages = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'system', content: 'init' }
      ];
      const config = { filters: { countRoles: ['user', 'assistant'], exclude: [], excludePatterns: [] } };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 2);
    });

    it('filters by exclude strings', () => {
      const messages = [
        { role: 'assistant', content: 'HEARTBEAT_OK' },
        { role: 'user', content: 'real message' }
      ];
      const config = { filters: { countRoles: ['user', 'assistant'], exclude: ['HEARTBEAT_OK'], excludePatterns: [] } };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, 'real message');
    });

    it('filters by exclude patterns', () => {
      const messages = [
        { role: 'assistant', content: '{"type": "toolCall", "data": {}}' },
        { role: 'user', content: 'normal' }
      ];
      const config = {
        filters: {
          countRoles: ['user', 'assistant'],
          exclude: [],
          excludePatterns: ['^\\{\\s*"type":\\s*"toolCall"']
        }
      };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 1);
    });
  });
});
