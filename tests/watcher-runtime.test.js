const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { WebSocketServer } = require('../scripts/node_modules/ws');

const ROOT_DIR = path.resolve(__dirname, '..');
const SNAPSHOT_ROOT = path.join(ROOT_DIR, 'tmp', 'latest-test-run');
const SNAPSHOT_DATA_DIR = path.join(SNAPSHOT_ROOT, 'data');
const SNAPSHOT_AGENTS_PATH = path.join(SNAPSHOT_ROOT, 'agents.json');
const SNAPSHOT_META_PATH = path.join(SNAPSHOT_ROOT, 'metadata.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 20000, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (_e) {}
    await sleep(intervalMs);
  }
  throw new Error('waitFor timeout');
}

function appendJsonLine(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function waitForProcExit(proc) {
  if (!proc) return Promise.resolve();
  if (proc.exitCode !== null || proc.killed) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', resolve));
}

function persistRuntimeSnapshot(agentId, sourceDataDir, capturedStdout = '') {
  const sourceAgentDir = path.join(sourceDataDir, agentId);
  if (!fs.existsSync(sourceAgentDir)) return;

  fs.mkdirSync(SNAPSHOT_DATA_DIR, { recursive: true });
  const targetAgentDir = path.join(SNAPSHOT_DATA_DIR, agentId);
  fs.rmSync(targetAgentDir, { recursive: true, force: true });
  try {
    fs.cpSync(sourceAgentDir, targetAgentDir, { recursive: true });
  } catch (err) {
    // Snapshot export is best-effort; runtime assertions already finished.
    // ENOENT can happen in rare races with temp-dir cleanup in CI/local runs.
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  // watch.js in runtime tests writes to process stdout; persist it for frontend logs tab.
  if (capturedStdout && capturedStdout.trim()) {
    fs.writeFileSync(path.join(targetAgentDir, 'watch.log'), capturedStdout, 'utf8');
  }

  let agentsConfig = { agents: [] };
  if (fs.existsSync(SNAPSHOT_AGENTS_PATH)) {
    try {
      agentsConfig = JSON.parse(fs.readFileSync(SNAPSHOT_AGENTS_PATH, 'utf8'));
    } catch (_e) {}
  }
  const agents = Array.isArray(agentsConfig.agents) ? agentsConfig.agents : [];
  const idx = agents.findIndex((a) => a.id === agentId);
  const nextAgent = { id: agentId, name: agentId, enabled: false, isSubagent: false };
  if (idx >= 0) {
    agents[idx] = { ...agents[idx], ...nextAgent };
  } else {
    agents.push(nextAgent);
  }
  fs.mkdirSync(SNAPSHOT_ROOT, { recursive: true });
  fs.writeFileSync(SNAPSHOT_AGENTS_PATH, JSON.stringify({ agents }, null, 2), 'utf8');

  const metadata = fs.existsSync(SNAPSHOT_META_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_META_PATH, 'utf8'))
    : {};
  metadata.runtimeSnapshot = {
    generatedAt: new Date().toISOString(),
    sourceTest: 'tests/watcher-runtime.test.js',
    agents: [
      ...new Set([...(metadata.runtimeSnapshot?.agents || []), agentId])
    ]
  };
  fs.writeFileSync(SNAPSHOT_META_PATH, JSON.stringify(metadata, null, 2), 'utf8');
}

function createMockGateway(port, options = {}) {
  const chatSends = [];
  const sessionsList = options.sessionsList;
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: `nonce-${Date.now()}`, ts: Date.now() }
    }));

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch (_e) {
        return;
      }
      if (frame.type !== 'req') return;

      if (frame.method === 'connect') {
        ws.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: { type: 'hello-ok' }
        }));
        return;
      }

      if (frame.method === 'chat.send') {
        chatSends.push(frame.params || {});
        ws.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: { runId: `run-${chatSends.length}` }
        }));
        return;
      }

      if (frame.method === 'sessions.list') {
        const sessions = typeof sessionsList === 'function'
          ? (sessionsList(frame.params || {}) || [])
          : (Array.isArray(sessionsList) ? sessionsList : []);
        ws.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: { sessions }
        }));
        return;
      }

      ws.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: true,
        payload: {}
      }));
    });
  });

  return {
    chatSends,
    close: async () => {
      await new Promise((resolve) => wss.close(resolve));
    }
  };
}

function startWatcherProcess({ agentId, sessionId, sessionPath, dataDir, homeDir, gatewayUrl, agentsConfigPath }) {
  let stdout = '';
  let stderr = '';

  const args = [path.join(ROOT_DIR, 'scripts/watch.js'), agentId];
  if (sessionId) args.push(sessionId);
  if (sessionPath) args.push(sessionPath);

  const proc = spawn('node', args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HM_DATA_DIR: dataDir,
      HM_AGENTS_CONFIG_PATH: agentsConfigPath || process.env.HM_AGENTS_CONFIG_PATH,
      HOME: homeDir,
      GATEWAY_URL: gatewayUrl
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  return {
    proc,
    getStdout: () => stdout,
    getStderr: () => stderr
  };
}

describe('watcher runtime integrations', () => {
  it('auto-injects context and switches to new session when a new jsonl appears', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-inject-'));
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const agentId = 'runtime-inject-agent';
    const sessionId1 = 'session-a';
    const sessionId2 = 'session-b';
    const sessionsDir = path.join(homeDir, '.openclaw', 'agents', agentId, 'sessions');
    const sessionPath1 = path.join(sessionsDir, `${sessionId1}.jsonl`);
    const sessionPath2 = path.join(sessionsDir, `${sessionId2}.jsonl`);

    fs.mkdirSync(path.join(dataDir, agentId), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    fs.writeFileSync(path.join(dataDir, agentId, 'config.json'), JSON.stringify({
      thresholds: { L1: 999, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: {
        enabled: true,
        onNewSession: true,
        onCompaction: false
      },
      autoCompact: {
        enabled: false,
        messageThreshold: 100,
        retries: 1,
        retryDelayMs: 1000
      }
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dataDir, agentId, 'CONTEXT.md'), '# Demo context\n\nInject me.', 'utf8');

    appendJsonLine(sessionPath1, {
      type: 'message',
      message: {
        role: 'user',
        content: 'first session message',
        timestamp: '2026-02-06T18:00:00.000Z'
      }
    });

    let activeSessionId = sessionId1;
    const port = 19000 + Math.floor(Math.random() * 1000);
    const gateway = createMockGateway(port, {
      sessionsList: () => ([
        {
          key: `agent:${agentId}:main`,
          sessionId: activeSessionId,
          updatedAt: activeSessionId === sessionId1
            ? '2026-02-06T18:00:00.000Z'
            : '2026-02-06T18:10:00.000Z'
        }
      ])
    });
    const watcher = startWatcherProcess({
      agentId,
      sessionId: sessionId1,
      sessionPath: sessionPath1,
      dataDir,
      homeDir,
      gatewayUrl: `ws://127.0.0.1:${port}`
    });

    try {
      await waitFor(() => watcher.getStdout().includes('Watching for new messages (tail -F)...'));
      await waitFor(() => gateway.chatSends.some((s) => String(s.message || '').includes('Hierarchical Memory Context')), 15000, 250);

      activeSessionId = sessionId2;
      appendJsonLine(sessionPath2, {
        type: 'message',
        message: {
          role: 'assistant',
          content: 'second session starts now',
          timestamp: '2026-02-06T18:10:00.000Z'
        }
      });

      await waitFor(() => watcher.getStdout().includes('SESSION CHANGE DETECTED!'), 15000, 250);
      await waitFor(() => gateway.chatSends.filter((s) => String(s.message || '').includes('Hierarchical Memory Context')).length >= 2, 15000, 250);
    } finally {
      watcher.proc.kill('SIGTERM');
      await waitForProcExit(watcher.proc);
      await gateway.close();
    }

    assert.equal(watcher.getStderr().includes('Error'), false);
    persistRuntimeSnapshot(agentId, dataDir, watcher.getStdout());
  });

  it('triggers auto-compact command and resets after compaction event', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-compact-'));
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const agentId = 'runtime-compact-agent';
    const sessionId = 'session-compact';
    const sessionsDir = path.join(homeDir, '.openclaw', 'agents', agentId, 'sessions');
    const sessionPath = path.join(sessionsDir, `${sessionId}.jsonl`);

    fs.mkdirSync(path.join(dataDir, agentId), { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(sessionPath, '', 'utf8');

    fs.writeFileSync(path.join(dataDir, agentId, 'config.json'), JSON.stringify({
      thresholds: { L1: 999, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: {
        enabled: false,
        onNewSession: false,
        onCompaction: false
      },
      autoCompact: {
        enabled: true,
        messageThreshold: 2,
        postCompactMessage: 'keep-it-short',
        retries: 3,
        retryDelayMs: 1000
      }
    }, null, 2), 'utf8');

    const port = 20000 + Math.floor(Math.random() * 1000);
    const gateway = createMockGateway(port);
    const watcher = startWatcherProcess({
      agentId,
      sessionId,
      sessionPath,
      dataDir,
      homeDir,
      gatewayUrl: `ws://127.0.0.1:${port}`
    });

    try {
      await waitFor(() => watcher.getStdout().includes('Watching for new messages (tail -F)...'));
      await sleep(1200);

      appendJsonLine(sessionPath, {
        type: 'message',
        message: {
          role: 'user',
          content: 'm1',
          timestamp: '2026-02-06T19:00:00.000Z'
        }
      });
      appendJsonLine(sessionPath, {
        type: 'message',
        message: {
          role: 'assistant',
          content: 'm2',
          timestamp: '2026-02-06T19:00:01.000Z'
        }
      });

      await waitFor(() => gateway.chatSends.some((s) => String(s.message || '').startsWith('/compact keep-it-short')), 15000, 200);

      appendJsonLine(sessionPath, {
        type: 'compaction',
        tokensBefore: 12000
      });

      await waitFor(() => watcher.getStdout().includes('Auto-compact completed'), 15000, 200);
      await sleep(5200);

      appendJsonLine(sessionPath, {
        type: 'message',
        message: {
          role: 'user',
          content: 'm3',
          timestamp: '2026-02-06T19:01:00.000Z'
        }
      });
      appendJsonLine(sessionPath, {
        type: 'message',
        message: {
          role: 'assistant',
          content: 'm4',
          timestamp: '2026-02-06T19:01:01.000Z'
        }
      });

      await waitFor(
        () => gateway.chatSends.filter((s) => String(s.message || '').startsWith('/compact keep-it-short')).length >= 2,
        15000,
        200
      );
    } finally {
      watcher.proc.kill('SIGTERM');
      await waitForProcExit(watcher.proc);
      await gateway.close();
    }

    assert.equal(watcher.getStderr().includes('Error'), false);
    persistRuntimeSnapshot(agentId, dataDir, watcher.getStdout());
  });

  it('does not switch subagent to main session when main session file updates', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-subagent-main-update-'));
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const agentsConfigPath = path.join(tmp, 'agents.json');
    const agentId = 'runtime-subagent-agent';
    const subSessionId = 'sub-session';
    const mainSessionId = 'main-session';
    const mainSessionsDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
    const subSessionPath = path.join(mainSessionsDir, `${subSessionId}.jsonl`);
    const mainSessionPath = path.join(mainSessionsDir, `${mainSessionId}.jsonl`);

    fs.mkdirSync(path.join(dataDir, agentId), { recursive: true });
    fs.mkdirSync(mainSessionsDir, { recursive: true });
    fs.writeFileSync(agentsConfigPath, JSON.stringify({
      agents: [{ id: agentId, name: agentId, enabled: true, isSubagent: true }]
    }, null, 2), 'utf8');

    fs.writeFileSync(path.join(dataDir, agentId, 'config.json'), JSON.stringify({
      thresholds: { L1: 999, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: { enabled: false, onNewSession: false, onCompaction: false },
      autoCompact: { enabled: false, messageThreshold: 100, retries: 1, retryDelayMs: 1000 }
    }, null, 2), 'utf8');

    appendJsonLine(subSessionPath, {
      type: 'message',
      message: {
        role: 'user',
        content: 'subagent initial message',
        timestamp: '2026-02-06T20:00:00.000Z'
      }
    });
    fs.writeFileSync(mainSessionPath, '', 'utf8');

    const port = 21000 + Math.floor(Math.random() * 1000);
    const gateway = createMockGateway(port, {
      sessionsList: () => ([
        { key: `agent:${agentId}`, sessionId: subSessionId, updatedAt: '2026-02-06T20:00:00.000Z' },
        { key: 'agent:main:main', sessionId: mainSessionId, updatedAt: '2026-02-06T20:05:00.000Z' }
      ])
    });
    const watcher = startWatcherProcess({
      agentId,
      dataDir,
      homeDir,
      gatewayUrl: `ws://127.0.0.1:${port}`,
      agentsConfigPath
    });

    try {
      await waitFor(() => watcher.getStdout().includes('Watching for new messages (tail -F)...'));
      await sleep(1200);

      // Emulate main receiving a new message -> main session file update in shared dir.
      appendJsonLine(mainSessionPath, {
        type: 'message',
        message: {
          role: 'user',
          content: 'main message that updates main session file',
          timestamp: '2026-02-06T20:06:00.000Z'
        }
      });

      await sleep(4000);

      const out = watcher.getStdout();
      assert.equal(out.includes(`New session detected: ${mainSessionId}`), false);
      assert.equal(out.includes('SESSION CHANGE DETECTED!'), false);
    } finally {
      watcher.proc.kill('SIGTERM');
      await waitForProcExit(watcher.proc);
      await gateway.close();
    }

    assert.equal(watcher.getStderr().includes('Error'), false);
    persistRuntimeSnapshot(agentId, dataDir, watcher.getStdout());
  });

  it('routes context inject and compact commands to correct sessions for main and subagent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-watch-routing-'));
    const dataDir = path.join(tmp, 'data');
    const homeDir = path.join(tmp, 'home');
    const agentsConfigPath = path.join(tmp, 'agents.json');
    const mainId = 'main';
    const subagentId = 'runtime-subagent-routing';
    const mainSessionId = 'routing-main-session';
    const subSessionId = 'routing-sub-session';
    const subSessionId2 = 'routing-sub-session-2';
    const mainSessionsDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
    const mainSessionPath = path.join(mainSessionsDir, `${mainSessionId}.jsonl`);
    const subSessionPath = path.join(mainSessionsDir, `${subSessionId}.jsonl`);
    const subSessionPath2 = path.join(mainSessionsDir, `${subSessionId2}.jsonl`);

    fs.mkdirSync(path.join(dataDir, mainId), { recursive: true });
    fs.mkdirSync(path.join(dataDir, subagentId), { recursive: true });
    fs.mkdirSync(mainSessionsDir, { recursive: true });
    fs.writeFileSync(mainSessionPath, '', 'utf8');
    fs.writeFileSync(subSessionPath, '', 'utf8');
    fs.writeFileSync(subSessionPath2, '', 'utf8');

    fs.writeFileSync(agentsConfigPath, JSON.stringify({
      agents: [
        { id: mainId, name: mainId, enabled: true, isSubagent: false },
        { id: subagentId, name: subagentId, enabled: true, isSubagent: true }
      ]
    }, null, 2), 'utf8');

    fs.writeFileSync(path.join(dataDir, mainId, 'CONTEXT.md'), '# MAIN CONTEXT MARKER\nmain context', 'utf8');
    fs.writeFileSync(path.join(dataDir, subagentId, 'CONTEXT.md'), '# SUB CONTEXT MARKER\nsub context', 'utf8');

    fs.writeFileSync(path.join(dataDir, mainId, 'config.json'), JSON.stringify({
      thresholds: { L1: 999, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: { enabled: true, onNewSession: true, onCompaction: false },
      autoCompact: { enabled: true, messageThreshold: 2, postCompactMessage: 'main-compact', retries: 2, retryDelayMs: 800 }
    }, null, 2), 'utf8');

    fs.writeFileSync(path.join(dataDir, subagentId, 'config.json'), JSON.stringify({
      thresholds: { L1: 999, default: 2 },
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      },
      autoInjectContext: { enabled: true, onNewSession: true, onCompaction: false },
      autoCompact: { enabled: true, messageThreshold: 2, postCompactMessage: 'sub-compact', retries: 2, retryDelayMs: 800 }
    }, null, 2), 'utf8');

    let activeSubSessionId = subSessionId;
    const port = 22000 + Math.floor(Math.random() * 1000);
    const gateway = createMockGateway(port, {
      sessionsList: () => ([
        { key: 'agent:main:main', sessionId: mainSessionId, updatedAt: '2026-02-06T21:00:00.000Z' },
        { key: `agent:${subagentId}`, sessionId: activeSubSessionId, updatedAt: '2026-02-06T21:00:01.000Z' }
      ])
    });

    const mainWatcher = startWatcherProcess({
      agentId: mainId,
      sessionId: mainSessionId,
      sessionPath: mainSessionPath,
      dataDir,
      homeDir,
      gatewayUrl: `ws://127.0.0.1:${port}`,
      agentsConfigPath
    });
    const subWatcher = startWatcherProcess({
      agentId: subagentId,
      dataDir,
      homeDir,
      gatewayUrl: `ws://127.0.0.1:${port}`,
      agentsConfigPath
    });

    try {
      await waitFor(() => mainWatcher.getStdout().includes('Watching for new messages (tail -F)...'));
      await waitFor(() => subWatcher.getStdout().includes('Watching for new messages (tail -F)...'));

      await waitFor(() => {
        const injects = gateway.chatSends.filter((s) =>
          String(s.message || '').includes('Hierarchical Memory Context')
        );
        return injects.some((s) => s.sessionKey === 'agent:main:main');
      }, 20000, 250);

      // Force a real subagent session switch and validate inject on subagent key.
      activeSubSessionId = subSessionId2;
      appendJsonLine(subSessionPath2, {
        type: 'message',
        message: { role: 'assistant', content: 'sub session switched', timestamp: '2026-02-06T21:09:30.000Z' }
      });
      await waitFor(() => subWatcher.getStdout().includes(`New session detected: ${subSessionId2}`), 20000, 250);
      await waitFor(() => {
        const injects = gateway.chatSends.filter((s) =>
          String(s.message || '').includes('Hierarchical Memory Context')
        );
        return injects.some((s) => s.sessionKey === `agent:${subagentId}`);
      }, 20000, 250);

      appendJsonLine(mainSessionPath, {
        type: 'message',
        message: { role: 'user', content: 'main msg 1', timestamp: '2026-02-06T21:10:00.000Z' }
      });
      appendJsonLine(mainSessionPath, {
        type: 'message',
        message: { role: 'assistant', content: 'main msg 2', timestamp: '2026-02-06T21:10:01.000Z' }
      });

      appendJsonLine(subSessionPath2, {
        type: 'message',
        message: { role: 'user', content: 'sub msg 1', timestamp: '2026-02-06T21:11:00.000Z' }
      });
      appendJsonLine(subSessionPath2, {
        type: 'message',
        message: { role: 'assistant', content: 'sub msg 2', timestamp: '2026-02-06T21:11:01.000Z' }
      });

      await waitFor(() => {
        const mainCompact = gateway.chatSends.find((s) => String(s.message || '').startsWith('/compact main-compact'));
        const subCompact = gateway.chatSends.find((s) => String(s.message || '').startsWith('/compact sub-compact'));
        return Boolean(mainCompact && subCompact);
      }, 20000, 250);

      const sends = gateway.chatSends;
      const injects = sends.filter((s) => String(s.message || '').includes('Hierarchical Memory Context'));
      const mainInject = injects.find((s) => s.sessionKey === 'agent:main:main');
      const subInject = injects.find((s) => s.sessionKey === `agent:${subagentId}`);
      assert.equal(mainInject.sessionKey, 'agent:main:main');
      assert.equal(subInject.sessionKey, `agent:${subagentId}`);

      const mainCompact = sends.find((s) => String(s.message || '').startsWith('/compact main-compact'));
      const subCompact = sends.find((s) => String(s.message || '').startsWith('/compact sub-compact'));
      assert.equal(mainCompact.sessionKey, 'agent:main:main');
      assert.equal(subCompact.sessionKey, `agent:${subagentId}`);
    } finally {
      mainWatcher.proc.kill('SIGTERM');
      subWatcher.proc.kill('SIGTERM');
      await Promise.all([
        waitForProcExit(mainWatcher.proc),
        waitForProcExit(subWatcher.proc)
      ]);
      await gateway.close();
    }

    assert.equal(mainWatcher.getStderr().includes('Error'), false);
    assert.equal(subWatcher.getStderr().includes('Error'), false);
    persistRuntimeSnapshot(mainId, dataDir, mainWatcher.getStdout());
    persistRuntimeSnapshot(subagentId, dataDir, subWatcher.getStdout());
  });
});
