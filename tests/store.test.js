const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createEmptyStore,
  addMessage,
  addArtifact,
  compareTimestamps,
  formatTimestamp,
  getUnsummarized,
  selectSummarizationBatch,
  getLastSummarizedTimestamp,
  filterForCounting,
  checkThreshold,
  saveStore,
  loadStore,
  updateStore,
  getArtifactsRootDir,
  getArtifactsIndexPath
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

    it('preserves inter-agent metadata fields', () => {
      const msg = addMessage(store, {
        role: 'assistant',
        content: '[sessions_send -> agent:lira-guide:main] Ping',
        timestamp: '2026-01-01T10:00:00.000Z',
        messageClass: 'inter_agent',
        direction: 'outgoing',
        toSessionKey: 'agent:lira-guide:main',
        toolName: 'sessions_send',
        toolCallId: 'toolu_123',
        runId: 'run_123',
        status: 'completed',
        sourceType: 'toolCall'
      });

      assert.equal(msg.messageClass, 'inter_agent');
      assert.equal(msg.direction, 'outgoing');
      assert.equal(msg.toSessionKey, 'agent:lira-guide:main');
      assert.equal(msg.toolName, 'sessions_send');
      assert.equal(msg.toolCallId, 'toolu_123');
      assert.equal(msg.runId, 'run_123');
      assert.equal(msg.status, 'completed');
      assert.equal(msg.sourceType, 'toolCall');
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

    it('filters by countMessageClasses', () => {
      const messages = [
        { role: 'user', content: '/status please', messageClass: 'command' },
        { role: 'assistant', content: 'normal answer', messageClass: 'dialogue' }
      ];
      const config = {
        filters: {
          countRoles: ['user', 'assistant'],
          exclude: [],
          excludePatterns: [],
          countMessageClasses: ['dialogue'],
          commandAllowlist: ['/status']
        }
      };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, 'normal answer');
    });

    it('respects command allowlist when command class is enabled for counting', () => {
      const messages = [
        { role: 'user', content: '/status', messageClass: 'command' },
        { role: 'user', content: '/compact now', messageClass: 'command' }
      ];
      const config = {
        filters: {
          countRoles: ['user', 'assistant'],
          exclude: [],
          excludePatterns: [],
          countMessageClasses: ['command'],
          commandAllowlist: ['/status']
        }
      };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, '/status');
    });

    it('does not count inter-agent messages by default', () => {
      const messages = [
        { role: 'assistant', content: '[sessions_send -> agent:x:main] ping', messageClass: 'inter_agent' },
        { role: 'assistant', content: 'normal reply', messageClass: 'dialogue' }
      ];
      const config = {
        filters: {
          countRoles: ['user', 'assistant'],
          exclude: [],
          excludePatterns: []
        }
      };
      const result = filterForCounting(messages, config);
      assert.equal(result.length, 1);
      assert.equal(result[0].content, 'normal reply');
    });
  });

  describe('long-term artifact export/load', () => {
    const originalDataDir = process.env.HM_DATA_DIR;
    let tmpDir;
    const agentId = 'store-longterm-test';

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-store-test-'));
      process.env.HM_DATA_DIR = tmpDir;
    });

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.HM_DATA_DIR;
      } else {
        process.env.HM_DATA_DIR = originalDataDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exports artifacts to long-term files and index on saveStore', () => {
      const store = createEmptyStore();
      addArtifact(store, 1, {
        content: 'L1 export',
        startTimestamp: '2026-02-10T09:00:00.000Z',
        endTimestamp: '2026-02-10T09:05:00.000Z'
      });
      saveStore(agentId, store);

      const artifactsRoot = getArtifactsRootDir(agentId);
      const levelDir = path.join(artifactsRoot, 'L1');
      assert.equal(fs.existsSync(levelDir), true);

      const chunksDir = path.join(levelDir, 'chunks');
      assert.equal(fs.existsSync(chunksDir), true);
      const files = fs.readdirSync(chunksDir).filter((name) => name.endsWith('.jsonl'));
      assert.equal(files.length, 1);

      const indexPath = getArtifactsIndexPath(agentId);
      assert.equal(fs.existsSync(indexPath), true);
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      assert.equal(index.version, 2);
      assert.equal(index.chunkSize, 50);
      assert.equal(Array.isArray(index.artifacts), true);
      assert.equal(index.artifacts.length, 1);
      assert.equal(index.artifacts[0].level, 1);
      assert.equal(typeof index.artifacts[0].artifactId, 'string');
      assert.equal(typeof index.artifacts[0].path, 'string');
      assert.equal(index.artifacts[0].path.includes('/chunks/'), true);
    });

    it('loadStore merges store + legacy file + long-term without duplicates', () => {
      const store = createEmptyStore();
      const fromStore = addArtifact(store, 1, {
        content: 'Shared artifact',
        startTimestamp: '2026-02-10T10:00:00.000Z',
        endTimestamp: '2026-02-10T10:05:00.000Z'
      });
      saveStore(agentId, store);

      const agentDir = path.join(tmpDir, agentId);
      const legacyPath = path.join(agentDir, 'artifacts.json');
      fs.writeFileSync(legacyPath, JSON.stringify({
        1: [fromStore],
        2: [{
          content: 'Legacy L2',
          level: 2,
          startTimestamp: '2026-02-10T10:00:00.000Z',
          endTimestamp: '2026-02-10T10:30:00.000Z',
          createdAt: '2026-02-10T10:31:00.000Z'
        }]
      }, null, 2), 'utf8');

      const loaded = loadStore(agentId);
      assert.equal((loaded.artifacts[1] || []).length, 1);
      assert.equal((loaded.artifacts[2] || []).length, 1);
      assert.equal(typeof loaded.artifacts[1][0].artifactId, 'string');
      assert.equal(typeof loaded.artifacts[2][0].artifactId, 'string');
      assert.equal(loaded.artifacts[1][0].content, 'Shared artifact');
      assert.equal(loaded.artifacts[2][0].content, 'Legacy L2');
    });
  });

  describe('updateStore', () => {
    const originalDataDir = process.env.HM_DATA_DIR;
    let tmpDir;
    const agentId = 'store-update-test';

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-store-update-test-'));
      process.env.HM_DATA_DIR = tmpDir;
      saveStore(agentId, createEmptyStore());
    });

    afterEach(() => {
      if (originalDataDir === undefined) {
        delete process.env.HM_DATA_DIR;
      } else {
        process.env.HM_DATA_DIR = originalDataDir;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('serializes concurrent mutations for the same agent', async () => {
      const first = updateStore(agentId, async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        addMessage(state, {
          role: 'user',
          content: 'first',
          timestamp: '2026-03-02T10:00:00.000Z',
          messageClass: 'dialogue'
        });
      });

      const second = updateStore(agentId, (state) => {
        addMessage(state, {
          role: 'assistant',
          content: 'second',
          timestamp: '2026-03-02T10:00:01.000Z',
          messageClass: 'dialogue'
        });
        addArtifact(state, 1, {
          content: 'L1 summary',
          startTimestamp: '2026-03-02T10:00:00.000Z',
          endTimestamp: '2026-03-02T10:00:01.000Z'
        });
      });

      await Promise.all([first, second]);

      const finalStore = loadStore(agentId);
      assert.equal(finalStore.messages.length, 2);
      assert.equal((finalStore.artifacts[1] || []).length, 1);
    });
  });

  describe('selectSummarizationBatch', () => {
    it('selects earliest L0 batch by threshold using chronological order', () => {
      const store = createEmptyStore();
      addMessage(store, {
        role: 'user',
        content: 'm2',
        timestamp: '2026-02-10T10:02:00.000Z',
        messageClass: 'dialogue'
      });
      addMessage(store, {
        role: 'assistant',
        content: 'm1',
        timestamp: '2026-02-10T10:01:00.000Z',
        messageClass: 'dialogue'
      });
      addMessage(store, {
        role: 'user',
        content: 'm3',
        timestamp: '2026-02-10T10:03:00.000Z',
        messageClass: 'dialogue'
      });

      const selected = selectSummarizationBatch(store, 0, 2);
      assert.equal(selected.needed, true);
      assert.equal(selected.batch.length, 2);
      assert.deepStrictEqual(
        selected.batch.map((m) => m.timestamp),
        ['2026-02-10T10:01:00.000Z', '2026-02-10T10:02:00.000Z']
      );
    });

    it('selects only first threshold artifacts for higher levels', () => {
      const store = createEmptyStore();
      addArtifact(store, 1, {
        content: 'a2',
        startTimestamp: '2026-01-01T10:05:00.000Z',
        endTimestamp: '2026-01-01T10:10:00.000Z'
      });
      addArtifact(store, 1, {
        content: 'a1',
        startTimestamp: '2026-01-01T10:00:00.000Z',
        endTimestamp: '2026-01-01T10:05:00.000Z'
      });
      addArtifact(store, 1, {
        content: 'a3',
        startTimestamp: '2026-01-01T10:10:00.000Z',
        endTimestamp: '2026-01-01T10:15:00.000Z'
      });

      const selected = selectSummarizationBatch(store, 1, 2);
      assert.equal(selected.needed, true);
      assert.equal(selected.batch.length, 2);
      assert.deepStrictEqual(
        selected.batch.map((a) => a.endTimestamp),
        ['2026-01-01T10:05:00.000Z', '2026-01-01T10:10:00.000Z']
      );
    });
  });
});
