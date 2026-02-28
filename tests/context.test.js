const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  generateContext,
  formatMessages,
  formatArtifacts
} = require('../scripts/context');
const {
  createEmptyStore,
  addMessage,
  addArtifact,
  saveStore,
  loadStore,
  archiveMessages
} = require('../scripts/store');

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

    it('keeps full long messages in context output', () => {
      const longContent = 'A'.repeat(600);
      const messages = [{ role: 'user', content: longContent, timestamp: '2026-01-01T10:00:00.000Z' }];
      const result = formatMessages(messages, false);
      assert.ok(result.includes(longContent));
      assert.ok(!result.includes('...'));
    });

    it('formats inter-agent messages with target and status', () => {
      const messages = [
        {
          role: 'assistant',
          content: '[sessions_send result <- agent:lira-guide:main] status=timeout runId=run-1',
          timestamp: '2026-01-01T10:02:00.000Z',
          messageClass: 'inter_agent',
          direction: 'result',
          toSessionKey: 'agent:lira-guide:main',
          status: 'timeout',
          runId: 'run-1'
        }
      ];
      const result = formatMessages(messages, true);
      assert.ok(result.includes('RESULT agent:lira-guide:main'));
      assert.ok(result.includes('status=timeout'));
      assert.ok(result.includes('runId=run-1'));
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

    it('generates structured context with MEMORY (LEVEL 1) and RECENT CONVERSATION', () => {
      const store = createEmptyStore();
      
      // Add two L1 artifacts so one remains visible after overlap replacement
      addArtifact(store, 1, {
        content: '## Session Summary\nOlder summary that should remain visible.',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T12:00:00.000Z',
        messageCount: 60
      });
      addArtifact(store, 1, {
        content: '## Session Summary\nNewest summary replaced by L0 overlap.',
        startTimestamp: '2026-01-01T12:01:00.000Z',
        endTimestamp: '2026-01-01T12:30:00.000Z',
        messageCount: 20
      });
      
      // Add unsummarized messages (after artifact's endTimestamp)
      addMessage(store, { role: 'user', content: 'New message', timestamp: '2026-01-01T13:00:00.000Z' });

      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);
      
      assert.ok(context.includes('# Memory Context'));
      assert.ok(context.includes('## MEMORY (LEVEL 1)'));
      assert.ok(context.includes('Older summary that should remain visible.'));
      assert.ok(!context.includes('Newest summary replaced by L0 overlap.'));
      assert.ok(context.includes('## RECENT CONVERSATION'));
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

    it('does not include command messages in context by default', () => {
      const store = createEmptyStore();
      addMessage(store, { role: 'user', content: '/status', timestamp: '2026-01-01T10:00:00.000Z' });
      addMessage(store, { role: 'assistant', content: 'Regular reply', timestamp: '2026-01-01T10:01:00.000Z' });

      const config = { contextOverlap: 1, includeTimestamps: true };
      const context = generateContext(store, config);

      assert.ok(context.includes('Regular reply'));
      assert.ok(!context.includes('/status'));
    });

    it('excludes artifacts marked as not context-eligible', () => {
      const store = createEmptyStore();

      const excluded = addArtifact(store, 1, {
        content: 'Do not include in context',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:10:00.000Z',
        messageCount: 3
      });
      excluded.contextEligible = false;

      addArtifact(store, 1, {
        content: 'Include in context',
        startTimestamp: '2026-01-01T00:11:00.000Z',
        endTimestamp: '2026-01-01T00:20:00.000Z',
        messageCount: 3
      });
      addArtifact(store, 1, {
        content: 'Include in context (newest)',
        startTimestamp: '2026-01-01T00:21:00.000Z',
        endTimestamp: '2026-01-01T00:30:00.000Z',
        messageCount: 3
      });

      const context = generateContext(store, { contextOverlap: 1, includeTimestamps: false });

      assert.ok(context.includes('Include in context'));
      assert.ok(!context.includes('Include in context (newest)'));
      assert.ok(!context.includes('Do not include in context'));
    });

    it('replaces top L4 overlap window and recursively expands lower levels', () => {
      const store = createEmptyStore();

      addArtifact(store, 3, {
        content: 'L3-OUTSIDE',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:10:00.000Z',
        artifactCount: 2,
        sourceLevel: 2
      });
      addArtifact(store, 3, {
        content: 'L3-A',
        startTimestamp: '2026-01-01T01:00:00.000Z',
        endTimestamp: '2026-01-01T01:10:00.000Z',
        artifactCount: 2,
        sourceLevel: 2
      });
      addArtifact(store, 3, {
        content: 'L3-B',
        startTimestamp: '2026-01-01T01:11:00.000Z',
        endTimestamp: '2026-01-01T01:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 2
      });
      addArtifact(store, 2, {
        content: 'L2-OUTSIDE',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 1
      });
      addArtifact(store, 2, {
        content: 'L2-B-1',
        startTimestamp: '2026-01-01T01:11:00.000Z',
        endTimestamp: '2026-01-01T01:15:00.000Z',
        artifactCount: 2,
        sourceLevel: 1
      });
      addArtifact(store, 2, {
        content: 'L2-B-2',
        startTimestamp: '2026-01-01T01:15:01.000Z',
        endTimestamp: '2026-01-01T01:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 1
      });
      addArtifact(store, 4, {
        content: 'L4-ONLY',
        startTimestamp: '2026-01-01T01:00:00.000Z',
        endTimestamp: '2026-01-01T01:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 3
      });

      const context = generateContext(store, { contextOverlap: 1, includeTimestamps: false });

      assert.ok(!context.includes('L4-ONLY'));
      assert.ok(context.includes('L3-A'));
      assert.ok(!context.includes('L3-B'));
      assert.ok(!context.includes('L3-OUTSIDE'));
      assert.ok(context.includes('L2-B-1'));
      assert.ok(!context.includes('L2-B-2'));
    });

    it('replaces last L3 artifact with expanded L2 overlap window when L3 is top level', () => {
      const store = createEmptyStore();

      addArtifact(store, 2, {
        content: 'L2-A',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:10:00.000Z',
        artifactCount: 2,
        sourceLevel: 1
      });
      addArtifact(store, 2, {
        content: 'L2-B',
        startTimestamp: '2026-01-01T00:11:00.000Z',
        endTimestamp: '2026-01-01T00:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 1
      });
      addArtifact(store, 3, {
        content: 'L3-ONLY',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:20:00.000Z',
        artifactCount: 2,
        sourceLevel: 2
      });

      const context = generateContext(store, { contextOverlap: 1, includeTimestamps: false });

      assert.ok(!context.includes('L3-ONLY'));
      assert.ok(context.includes('L2-A'));
      assert.ok(!context.includes('L2-B'));
    });

    it('builds hierarchical structure without duplicate top overlap window when top level has multiple artifacts', () => {
      const store = createEmptyStore();

      addArtifact(store, 2, {
        content: 'L2-1',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:09:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });
      addArtifact(store, 2, {
        content: 'L2-2',
        startTimestamp: '2026-01-01T00:10:00.000Z',
        endTimestamp: '2026-01-01T00:19:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });
      addArtifact(store, 2, {
        content: 'L2-3',
        startTimestamp: '2026-01-01T00:20:00.000Z',
        endTimestamp: '2026-01-01T00:29:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });
      addArtifact(store, 2, {
        content: 'L2-4',
        startTimestamp: '2026-01-01T00:30:00.000Z',
        endTimestamp: '2026-01-01T00:39:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });
      addArtifact(store, 2, {
        content: 'L2-5',
        startTimestamp: '2026-01-01T00:40:00.000Z',
        endTimestamp: '2026-01-01T00:49:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });
      addArtifact(store, 2, {
        content: 'L2-6',
        startTimestamp: '2026-01-01T00:50:00.000Z',
        endTimestamp: '2026-01-01T00:59:59.000Z',
        sourceLevel: 1,
        artifactCount: 2
      });

      addArtifact(store, 3, {
        content: 'L3-A',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:19:59.000Z',
        sourceLevel: 2,
        artifactCount: 2
      });
      addArtifact(store, 3, {
        content: 'L3-B',
        startTimestamp: '2026-01-01T00:20:00.000Z',
        endTimestamp: '2026-01-01T00:39:59.000Z',
        sourceLevel: 2,
        artifactCount: 2
      });
      addArtifact(store, 3, {
        content: 'L3-C',
        startTimestamp: '2026-01-01T00:40:00.000Z',
        endTimestamp: '2026-01-01T00:59:59.000Z',
        sourceLevel: 2,
        artifactCount: 2
      });

      addArtifact(store, 4, {
        content: 'L4-X',
        startTimestamp: '2026-01-01T00:00:00.000Z',
        endTimestamp: '2026-01-01T00:39:59.000Z',
        sourceLevel: 3,
        artifactCount: 2
      });
      addArtifact(store, 4, {
        content: 'L4-Y',
        startTimestamp: '2026-01-01T00:40:00.000Z',
        endTimestamp: '2026-01-01T00:59:59.000Z',
        sourceLevel: 3,
        artifactCount: 1
      });

      const context = generateContext(store, { contextOverlap: 1, includeTimestamps: false });

      assert.ok(context.includes('## MEMORY (LEVEL 4)'));
      assert.ok(!context.includes('## MEMORY (LEVEL 3)'));
      assert.ok(context.includes('## MEMORY (LEVEL 2)'));

      assert.ok(context.includes('L4-X'));
      assert.ok(!context.includes('L4-Y'));
      assert.ok(!context.includes('L3-C'));
      assert.ok(!context.includes('L3-A'));
      assert.ok(!context.includes('L3-B'));
      assert.ok(context.includes('L2-5'));
      assert.ok(!context.includes('L2-6'));
      assert.ok(!context.includes('L2-1'));
      assert.ok(!context.includes('L2-2'));
      assert.ok(!context.includes('L2-3'));
      assert.ok(!context.includes('L2-4'));
    });

    it('builds context from real drilldown sources (archived messages + tail) for overlap replacement', () => {
      const originalDataDir = process.env.HM_DATA_DIR;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-context-drilldown-'));
      const agentId = 'context-drilldown-agent';

      try {
        process.env.HM_DATA_DIR = tmpDir;

        const store = createEmptyStore();
        addArtifact(store, 1, {
          content: 'L1-OLDER',
          startTimestamp: '2026-02-27T10:00:00.000Z',
          endTimestamp: '2026-02-27T10:05:00.000Z',
          messageCount: 2
        });
        addArtifact(store, 1, {
          content: 'L1-NEWEST',
          startTimestamp: '2026-02-27T10:06:00.000Z',
          endTimestamp: '2026-02-27T10:10:00.000Z',
          messageCount: 2
        });

        addMessage(store, {
          role: 'assistant',
          content: 'tail-after-l1',
          timestamp: '2026-02-27T10:11:00.000Z'
        });

        saveStore(agentId, store);
        archiveMessages(agentId, [
          {
            role: 'user',
            content: 'old-range-msg',
            timestamp: '2026-02-27T10:01:00.000Z'
          },
          {
            role: 'assistant',
            content: 'new-range-msg-1',
            timestamp: '2026-02-27T10:07:00.000Z'
          },
          {
            role: 'user',
            content: 'new-range-msg-2',
            timestamp: '2026-02-27T10:09:00.000Z'
          }
        ]);

        const persisted = loadStore(agentId);
        const context = generateContext(persisted, { contextOverlap: 1, includeTimestamps: false }, agentId);

        assert.ok(context.includes('## MEMORY (LEVEL 1)'));
        assert.ok(context.includes('L1-OLDER'));
        assert.ok(!context.includes('L1-NEWEST'));

        assert.ok(context.includes('## RECENT CONVERSATION'));
        assert.ok(context.includes('new-range-msg-1'));
        assert.ok(context.includes('new-range-msg-2'));
        assert.ok(context.includes('tail-after-l1'));
        assert.ok(!context.includes('old-range-msg'));
      } finally {
        if (originalDataDir === undefined) {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = originalDataDir;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
