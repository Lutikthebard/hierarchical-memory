const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateContext,
  formatMessages,
  formatArtifacts
} = require('../scripts/context');
const { createEmptyStore, addMessage, addArtifact } = require('../scripts/store');

describe('context.js', () => {

  describe('formatMessages', () => {
    it('formats messages with timestamps', () => {
      const messages = [
        { role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00.000Z' },
        { role: 'assistant', content: 'Hi there', timestamp: '2026-01-01T10:01:00.000Z' }
      ];
      const result = formatMessages(messages, true);
      assert.ok(result.includes('USER: Hello'));
      assert.ok(result.includes('ASSISTANT: Hi there'));
      assert.ok(result.includes('2026-01-01'));
    });

    it('formats messages without timestamps', () => {
      const messages = [
        { role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00.000Z' }
      ];
      const result = formatMessages(messages, false);
      assert.ok(result.includes('USER: Hello'));
      assert.ok(!result.includes('[2026'));
    });

    it('truncates long messages to 500 chars', () => {
      const longContent = 'A'.repeat(600);
      const messages = [{ role: 'user', content: longContent, timestamp: '2026-01-01T10:00:00.000Z' }];
      const result = formatMessages(messages, false);
      assert.ok(result.includes('...'));
      assert.ok(result.length < 600);
    });
  });

  describe('formatArtifacts', () => {
    it('formats artifacts with timestamps', () => {
      const artifacts = [{
        content: '## Summary\nKey decisions made.',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z'
      }];
      const result = formatArtifacts(artifacts, true);
      assert.ok(result.includes('Summary'));
      assert.ok(result.includes('2026-01-01'));
    });
  });

  describe('generateContext', () => {
    it('generates context with only messages', () => {
      const store = createEmptyStore();
      addMessage(store, { role: 'user', content: 'Test message', timestamp: '2026-01-01T10:00:00.000Z' });
      addMessage(store, { role: 'assistant', content: 'Response', timestamp: '2026-01-01T10:01:00.000Z' });

      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);
      
      assert.ok(context.includes('# Memory Context'));
      assert.ok(context.includes('RECENT CONVERSATION'));
      assert.ok(context.includes('Test message'));
    });

    it('generates context with L1 artifacts', () => {
      const store = createEmptyStore();
      
      // Add L1 artifact
      addArtifact(store, 1, {
        content: '## Session Summary\nDiscussed architecture.',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z',
        messageCount: 60
      });
      
      // Add unsummarized messages (after artifact's endTimestamp)
      addMessage(store, { role: 'user', content: 'New message', timestamp: '2026-01-01T13:00:00.000Z' });

      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);
      
      assert.ok(context.includes('# Memory Context'));
      assert.ok(context.includes('New message'));
    });

    it('filters out memory system messages', () => {
      const store = createEmptyStore();
      addMessage(store, { role: 'user', content: '🧠 MEMORY TASK: Create L1', timestamp: '2026-01-01T10:00:00.000Z' });
      addMessage(store, { role: 'assistant', content: 'NO_REPLY', timestamp: '2026-01-01T10:01:00.000Z' });
      addMessage(store, { role: 'user', content: 'Normal message', timestamp: '2026-01-01T10:02:00.000Z' });

      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);
      
      assert.ok(context.includes('Normal message'));
      assert.ok(!context.includes('MEMORY TASK'));
    });

    it('handles empty store', () => {
      const store = createEmptyStore();
      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);
      assert.ok(context.includes('# Memory Context'));
    });
  });
});
