const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseMessage,
  extractContent,
  processLine,
  getActiveSessionInfo,
  resolveInjectMdPath,
  buildInjectedContextMessage,
  acquireAgentLock,
  releaseAgentLock
} = require('../scripts/watch');
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

    it('keeps thinking blocks as think tags', () => {
      const content = [
        { type: 'text', text: 'Before' },
        { type: 'thinking', thinking: 'Internal note' },
        { type: 'text', text: 'After' }
      ];
      assert.equal(extractContent(content), 'Before\n<think>Internal note</think>\nAfter');
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

    it('handles array content with thinking blocks', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Public response' },
            { type: 'thinking', thinking: 'Private reasoning' }
          ],
          timestamp: '2026-01-01T10:00:00Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.content, 'Public response\n<think>Private reasoning</think>');
    });

    it('filters commands by class defaults', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: '/status', timestamp: '2026-01-01T10:00:00Z' }
      });
      assert.equal(parseMessage(line), null);
    });

    it('accepts allowlisted commands when command class is enabled for store', () => {
      const line = JSON.stringify({
        type: 'message',
        message: { role: 'user', content: '/status', timestamp: '2026-01-01T10:00:00Z' }
      });
      const config = {
        filters: {
          exclude: [],
          excludePatterns: [],
          countRoles: ['user', 'assistant'],
          storeRoles: ['user', 'assistant'],
          storeMessageClasses: ['dialogue', 'command'],
          countMessageClasses: ['dialogue', 'command'],
          contextMessageClasses: ['dialogue'],
          commandAllowlist: ['/status']
        }
      };
      const msg = parseMessage(line, config);
      assert.equal(msg.content, '/status');
      assert.equal(msg.messageClass, 'command');
      assert.equal(msg.shouldCount, true);
    });

    it('parses sessions_send toolCall as inter-agent event', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'toolu_1',
              name: 'sessions_send',
              arguments: {
                sessionKey: 'agent:lira-therapist:main',
                message: 'Please review section 2'
              }
            }
          ],
          timestamp: '2026-01-01T10:00:00Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.role, 'assistant');
      assert.equal(msg.messageClass, 'inter_agent');
      assert.equal(msg.shouldCount, false);
      assert.equal(msg.direction, 'outgoing');
      assert.equal(msg.toSessionKey, 'agent:lira-therapist:main');
      assert.equal(msg.toolName, 'sessions_send');
      assert.equal(msg.toolCallId, 'toolu_1');
      assert.ok(msg.content.includes('sessions_send'));
    });

    it('parses sessions_send toolResult as inter-agent event', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'sessions_send',
          toolCallId: 'toolu_1',
          details: {
            runId: 'run-123',
            status: 'timeout',
            sessionKey: 'agent:lira-therapist:main'
          },
          content: [{ type: 'text', text: '{"status":"timeout"}' }],
          timestamp: '2026-01-01T10:00:01Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.role, 'assistant');
      assert.equal(msg.messageClass, 'inter_agent');
      assert.equal(msg.shouldCount, false);
      assert.equal(msg.direction, 'result');
      assert.equal(msg.toSessionKey, 'agent:lira-therapist:main');
      assert.equal(msg.status, 'timeout');
      assert.equal(msg.runId, 'run-123');
      assert.equal(msg.sourceType, 'toolResult');
      assert.ok(msg.content.includes('status=timeout'));
    });

    it('includes sessions_send reply body for successful toolResult', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'sessions_send',
          toolCallId: 'toolu_2',
          details: {
            runId: 'run-456',
            status: 'ok',
            sessionKey: 'agent:council-psychologist:main',
            reply: 'Рекомендация: держи фокус на одном рычаге.'
          },
          timestamp: '2026-01-01T10:00:02Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.messageClass, 'inter_agent');
      assert.equal(msg.status, 'ok');
      assert.ok(msg.content.includes('status=ok'));
      assert.ok(msg.content.includes('Рекомендация: держи фокус на одном рычаге.'));
    });

    it('extracts sessions_send reply from toolResult text JSON when details are sparse', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'sessions_send',
          toolCallId: 'toolu_3',
          content: [{
            type: 'text',
            text: '{"runId":"run-789","status":"ok","sessionKey":"agent:council-fitness:main","reply":"Reply via content JSON"}'
          }],
          timestamp: '2026-01-01T10:00:03Z'
        }
      });
      const msg = parseMessage(line);
      assert.equal(msg.runId, 'run-789');
      assert.equal(msg.status, 'ok');
      assert.equal(msg.toSessionKey, 'agent:council-fitness:main');
      assert.ok(msg.content.includes('Reply via content JSON'));
    });

    it('filters sessions_send toolResult when reply is NO_REPLY', () => {
      const line = JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'sessions_send',
          toolCallId: 'toolu_4',
          details: {
            runId: 'run-999',
            status: 'ok',
            sessionKey: 'agent:council-dietitian:main',
            reply: 'NO_REPLY'
          },
          timestamp: '2026-01-01T10:00:04Z'
        }
      });
      assert.equal(parseMessage(line), null);
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

    it('does not adopt newer main session file when gateway is unavailable', async () => {
      const prevDataDir = process.env.HM_DATA_DIR;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-main-mtime-'));
      const dataDir = path.join(tmp, 'data');
      const agentsDir = path.join(tmp, 'openclaw', 'agents');
      const agentId = 'council-psychologist';
      process.env.HM_DATA_DIR = dataDir;

      try {
        const pinnedSessionId = 'subagent-owned-session';
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

        const mainSessionId = 'main-fresh-session';
        const mainPath = path.join(agentsDir, 'main', 'sessions', `${mainSessionId}.jsonl`);
        fs.mkdirSync(path.dirname(mainPath), { recursive: true });
        fs.writeFileSync(mainPath, '', 'utf8');

        // Emulate "main received message" -> main session file mtime changes.
        const now = new Date();
        fs.utimesSync(mainPath, now, now);

        const info = await getActiveSessionInfo(agentId, {
          quiet: true,
          openclawAgentsDir: agentsDir,
          listSessions: async () => {
            throw new Error('gateway unavailable');
          }
        });

        assert.equal(info.source, 'pinned-cache');
        assert.equal(info.sessionId, pinnedSessionId);
        assert.equal(info.sessionKey, `agent:${agentId}`);
        assert.equal(info.jsonlPath, pinnedPath);
      } finally {
        if (typeof prevDataDir === 'undefined') {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = prevDataDir;
        }
      }
    });

    it('keeps subagent gateway session even when main session file has newer mtime', async () => {
      const prevDataDir = process.env.HM_DATA_DIR;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-main-mtime-gw-'));
      const dataDir = path.join(tmp, 'data');
      const agentsDir = path.join(tmp, 'openclaw', 'agents');
      const agentId = 'council-psychologist';
      process.env.HM_DATA_DIR = dataDir;

      try {
        const subSessionId = 'subagent-gateway-session';
        const subPath = path.join(agentsDir, 'main', 'sessions', `${subSessionId}.jsonl`);
        fs.mkdirSync(path.dirname(subPath), { recursive: true });
        fs.writeFileSync(subPath, '', 'utf8');

        const mainSessionId = 'main-newer-session';
        const mainPath = path.join(agentsDir, 'main', 'sessions', `${mainSessionId}.jsonl`);
        fs.writeFileSync(mainPath, '', 'utf8');

        // Emulate "main received message" -> main file becomes newer.
        const now = new Date();
        fs.utimesSync(mainPath, now, now);
        const older = new Date(now.getTime() - 60000);
        fs.utimesSync(subPath, older, older);

        const info = await getActiveSessionInfo(agentId, {
          quiet: true,
          openclawAgentsDir: agentsDir,
          listSessions: async () => ([
            { key: 'agent:main:main', sessionId: mainSessionId, updatedAt: now.toISOString() },
            { key: `agent:${agentId}`, sessionId: subSessionId, updatedAt: older.toISOString() }
          ])
        });

        assert.equal(info.source, 'gateway');
        assert.equal(info.sessionId, subSessionId);
        assert.equal(info.sessionKey, `agent:${agentId}`);
        assert.equal(info.jsonlPath, subPath);
      } finally {
        if (typeof prevDataDir === 'undefined') {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = prevDataDir;
        }
      }
    });
  });

  describe('agent lock', () => {
    it('rejects second watcher when lock pid is alive', () => {
      const prevDataDir = process.env.HM_DATA_DIR;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-lock-'));
      const dataDir = path.join(tmp, 'data');
      const agentId = 'lock-agent';
      process.env.HM_DATA_DIR = dataDir;

      try {
        const lockDir = path.join(dataDir, agentId);
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(path.join(lockDir, 'watch.pid'), String(process.pid), 'utf8');

        assert.throws(
          () => acquireAgentLock(agentId),
          /Watcher already running/
        );
      } finally {
        releaseAgentLock();
        if (typeof prevDataDir === 'undefined') {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = prevDataDir;
        }
      }
    });

    it('replaces stale lock and releases it', () => {
      const prevDataDir = process.env.HM_DATA_DIR;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-lock-stale-'));
      const dataDir = path.join(tmp, 'data');
      const agentId = 'lock-agent-stale';
      process.env.HM_DATA_DIR = dataDir;

      try {
        const lockDir = path.join(dataDir, agentId);
        const lockPath = path.join(lockDir, 'watch.pid');
        fs.mkdirSync(lockDir, { recursive: true });
        fs.writeFileSync(lockPath, '999999', 'utf8');

        acquireAgentLock(agentId);
        assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
        releaseAgentLock();
        assert.equal(fs.existsSync(lockPath), false);
      } finally {
        releaseAgentLock();
        if (typeof prevDataDir === 'undefined') {
          delete process.env.HM_DATA_DIR;
        } else {
          process.env.HM_DATA_DIR = prevDataDir;
        }
      }
    });
  });

  describe('auto-inject message builder', () => {
    it('resolves only in-repo markdown paths', () => {
      const validRelative = resolveInjectMdPath('README.md');
      assert.equal(validRelative.endsWith('/README.md') || validRelative.endsWith('\\README.md'), true);
      assert.equal(resolveInjectMdPath('../outside.md'), null);
      assert.equal(resolveInjectMdPath('/tmp/outside.md'), null);
      assert.equal(resolveInjectMdPath('notes.txt'), null);
    });

    it('builds message with pre/post text and markdown files', () => {
      const projectRoot = path.resolve(__dirname, '..');
      const tmpRoot = path.join(projectRoot, 'tmp');
      fs.mkdirSync(tmpRoot, { recursive: true });
      const tmp = fs.mkdtempSync(path.join(tmpRoot, 'inject-builder-'));
      const relDir = path.relative(projectRoot, tmp);
      const preRel = path.join(relDir, 'pre.md');
      const postRel = path.join(relDir, 'post.md');
      fs.writeFileSync(path.join(tmp, 'pre.md'), 'PRE FILE', 'utf8');
      fs.writeFileSync(path.join(tmp, 'post.md'), 'POST FILE', 'utf8');

      const msg = buildInjectedContextMessage('new session', '# CONTEXT BODY', {
        preText: 'PRE TEXT',
        postText: 'POST TEXT',
        preMdFiles: [preRel],
        postMdFiles: [postRel]
      });

      assert.match(msg, /PRE TEXT/);
      assert.match(msg, /PRE FILE/);
      assert.match(msg, /Hierarchical Memory Context/);
      assert.match(msg, /# CONTEXT BODY/);
      assert.match(msg, /POST TEXT/);
      assert.match(msg, /POST FILE/);
    });

    it('skips invalid and missing markdown files', () => {
      const msg = buildInjectedContextMessage('compaction', 'CTX', {
        preMdFiles: ['../../etc/passwd', 'tmp/missing-file.md'],
        postMdFiles: ['tmp/invalid.txt']
      });
      assert.match(msg, /Hierarchical Memory Context/);
      assert.equal(msg.includes('passwd'), false);
      assert.equal(msg.includes('missing-file'), false);
    });
  });
});
