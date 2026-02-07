const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMessage, extractContent, processLine, getActiveSessionInfo } = require('../scripts/watch');
const { createEmptyStore } = require('../scripts/store');

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

  describe('processLine', () => {
    it('skips duplicate timestamps without crashing', async () => {
      const storeRef = { current: createEmptyStore() };
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'user',
          content: 'Hello',
          timestamp: '2026-01-01T10:00:00.000Z'
        }
      });

      const agentConfig = {
        thresholds: { L1: 999, default: 5 },
        filters: {
          exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant']
        },
        autoCompact: { enabled: false }
      };

      const first = await processLine('test-agent', storeRef, line, {
        agentConfig,
        skipThresholdCheck: true,
        skipPersistence: true,
        skipContextRegenerate: true
      });

      const second = await processLine('test-agent', storeRef, line, {
        agentConfig,
        skipThresholdCheck: true,
        skipPersistence: true,
        skipContextRegenerate: true
      });

      assert.equal(first, true);
      assert.equal(second, false);
      assert.equal(storeRef.current.messages.length, 1);
    });
  });

  describe('subagent session resolution with transient gateway outage', () => {
    it('uses pinned cache during short outage and resyncs to gateway when it recovers', async () => {
      const prevDataDir = process.env.HM_DATA_DIR;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-session-'));
      const dataDir = path.join(tmp, 'data');
      const agentsDir = path.join(tmp, 'openclaw', 'agents');
      const agentId = 'council-psychologist';
      process.env.HM_DATA_DIR = dataDir;

      try {
        const pinnedSessionId = 'sub-pinned';
        const pinnedPath = path.join(agentsDir, agentId, 'sessions', `${pinnedSessionId}.jsonl`);
        fs.mkdirSync(path.dirname(pinnedPath), { recursive: true });
        fs.writeFileSync(pinnedPath, '', 'utf8');

        fs.mkdirSync(path.join(dataDir, agentId), { recursive: true });
        fs.writeFileSync(
          path.join(dataDir, agentId, 'last-session.json'),
          JSON.stringify({
            sessionId: pinnedSessionId,
            sessionKey: `agent:${agentId}`,
            jsonlPath: pinnedPath,
            timestamp: Date.now()
          }),
          'utf8'
        );

        const outageInfo = await getActiveSessionInfo(agentId, {
          quiet: true,
          openclawAgentsDir: agentsDir,
          listSessions: async () => {
            throw new Error('gateway unavailable');
          }
        });

        assert.equal(outageInfo.source, 'pinned-cache');
        assert.equal(outageInfo.sessionId, pinnedSessionId);
        assert.equal(outageInfo.sessionKey, `agent:${agentId}`);

        const recoveredSessionId = 'sub-new';
        const recoveredPath = path.join(agentsDir, 'main', 'sessions', `${recoveredSessionId}.jsonl`);
        fs.mkdirSync(path.dirname(recoveredPath), { recursive: true });
        fs.writeFileSync(recoveredPath, '', 'utf8');

        const recoveredInfo = await getActiveSessionInfo(agentId, {
          quiet: true,
          openclawAgentsDir: agentsDir,
          listSessions: async () => ([
            { key: `agent:${agentId}`, sessionId: recoveredSessionId, updatedAt: Date.now() }
          ])
        });

        assert.equal(recoveredInfo.source, 'gateway');
        assert.equal(recoveredInfo.sessionId, recoveredSessionId);
        assert.equal(recoveredInfo.sessionKey, `agent:${agentId}`);

        const updatedBinding = JSON.parse(
          fs.readFileSync(path.join(dataDir, agentId, 'last-session.json'), 'utf8')
        );
        assert.equal(updatedBinding.sessionId, recoveredSessionId);
        assert.equal(updatedBinding.sessionKey, `agent:${agentId}`);
      } finally {
        if (typeof prevDataDir === 'undefined') {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = prevDataDir;
        }
      }
    });
  });
});
