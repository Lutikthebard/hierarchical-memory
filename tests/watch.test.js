const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseMessage, extractContent } = require('../scripts/watch');

describe('watch.js', () => {

  describe('extractContent', () => {
    it('extracts from string', () => {
      assert.equal(extractContent('hello'), 'hello');
    });

    it('extracts from array of text blocks', () => {
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'image', data: '...' },
        { type: 'text', text: 'World' }
      ];
      assert.equal(extractContent(content), 'Hello\nWorld');
    });

    it('returns empty for unknown types', () => {
      assert.equal(extractContent(123), '');
      assert.equal(extractContent(null), '');
    });
  });

  describe('parseMessage', () => {
    it('parses valid user message', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: 'Hello world',
          timestamp: '2026-01-01T10:00:00.000Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.role, 'user');
      assert.equal(msg.content, 'Hello world');
      assert.equal(msg.timestamp, '2026-01-01T10:00:00.000Z');
    });

    it('parses valid assistant message', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: 'Hi there!',
          timestamp: '2026-01-01T10:01:00.000Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.role, 'assistant');
    });

    it('returns null for non-message type', () => {
      const line = JSON.stringify({ type: 'compaction', tokensBefore: 1000 });
      assert.equal(parseMessage(line), null);
    });

    it('returns null for empty line', () => {
      assert.equal(parseMessage(''), null);
      assert.equal(parseMessage('  '), null);
    });

    it('returns null for invalid JSON', () => {
      assert.equal(parseMessage('not json at all'), null);
    });

    it('filters out HEARTBEAT_OK', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: 'HEARTBEAT_OK', timestamp: '2026-01-01T10:00:00Z' }
      });
      assert.equal(parseMessage(line), null);
    });

    it('filters out MEMORY TASK messages', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: '🧠 MEMORY TASK: Create L1', timestamp: '2026-01-01T10:00:00Z' }
      });
      assert.equal(parseMessage(line), null);
    });

    it('filters out system role by default', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'system', content: 'System prompt', timestamp: '2026-01-01T10:00:00Z' }
      });
      assert.equal(parseMessage(line), null);
    });

    it('respects custom agent config filters', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: 'ANNOUNCE_SKIP', timestamp: '2026-01-01T10:00:00Z' }
      });
      const config = {
        filters: {
          exclude: ['ANNOUNCE_SKIP'],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant']
        }
      };
      assert.equal(parseMessage(line, config), null);
    });

    it('handles array content', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Multi-part content' }],
          timestamp: '2026-01-01T10:00:00Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.content, 'Multi-part content');
    });
  });
});
