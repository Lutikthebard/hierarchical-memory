const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../scripts/store');
const rollbackService = require('../scripts/rollback-service');

describe('rollback-service', () => {
  const originalDataDir = process.env.HM_DATA_DIR;
  const originalHome = process.env.HOME;
  let tmpDir;
  let homeDir;
  const agentId = 'rollback-agent';
  const sessionId = 'session-rollback-1';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rollback-test-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rollback-home-'));
    process.env.HM_DATA_DIR = tmpDir;
    process.env.HOME = homeDir;

    const initialStore = store.createEmptyStore();
    store.addMessage(initialStore, {
      role: 'user',
      content: 'm3',
      timestamp: '2026-02-06T10:02:00.000Z'
    });
    store.addMessage(initialStore, {
      role: 'assistant',
      content: 'm4',
      timestamp: '2026-02-06T10:03:00.000Z'
    });

    store.addArtifact(initialStore, 1, {
      content: 'L1 first',
      startTimestamp: '2026-02-06T10:00:00.000Z',
      endTimestamp: '2026-02-06T10:01:00.000Z',
      messageCount: 2
    });
    store.addArtifact(initialStore, 1, {
      content: 'L1 second',
      startTimestamp: '2026-02-06T10:02:00.000Z',
      endTimestamp: '2026-02-06T10:03:00.000Z',
      messageCount: 2
    });
    store.addArtifact(initialStore, 2, {
      content: 'L2 merged',
      startTimestamp: '2026-02-06T10:00:00.000Z',
      endTimestamp: '2026-02-06T10:03:00.000Z',
      sourceLevel: 1,
      artifactCount: 2
    });

    store.saveStore(agentId, initialStore);
    store.rewriteArchivedMessages(agentId, [
      {
        role: 'user',
        content: 'm1',
        timestamp: '2026-02-06T10:00:00.000Z',
        messageClass: 'dialogue'
      },
      {
        role: 'assistant',
        content: 'm2',
        timestamp: '2026-02-06T10:01:00.000Z',
        messageClass: 'dialogue'
      }
    ]);

    const sessionDir = path.join(homeDir, '.openclaw', 'agents', agentId, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
    const sessionLines = [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-02-06T10:00:00.000Z',
        message: {
          role: 'user',
          content: 'session-m1',
          timestamp: '2026-02-06T10:00:00.000Z'
        }
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-02-06T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: 'session-m2',
          timestamp: '2026-02-06T10:01:00.000Z'
        }
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-02-06T10:02:00.000Z',
        message: {
          role: 'user',
          content: 'session-m3',
          timestamp: '2026-02-06T10:02:00.000Z'
        }
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-02-06T10:03:00.000Z',
        message: {
          role: 'assistant',
          content: 'session-m4',
          timestamp: '2026-02-06T10:03:00.000Z'
        }
      })
    ];
    fs.writeFileSync(sessionPath, `${sessionLines.join('\n')}\n`, 'utf8');

    const agentDir = path.join(tmpDir, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'last-session.json'),
      JSON.stringify({
        sessionId,
        sessionKey: `agent:${agentId}:main`,
        jsonlPath: sessionPath
      }, null, 2),
      'utf8'
    );
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.HM_DATA_DIR;
    } else {
      process.env.HM_DATA_DIR = originalDataDir;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('preview calculates removals by cutoff time', () => {
    const preview = rollbackService.previewRollback(agentId, '2026-02-06T10:01:30.000Z');

    assert.equal(preview.current.totalMessages, 4);
    assert.equal(preview.result.totalMessages, 2);
    assert.equal(preview.removed.totalMessages, 2);
    assert.equal(preview.result.artifactsByLevel['1'], 1);
    assert.equal(preview.removed.artifactsByLevel['1'], 1);
    assert.equal(preview.removed.artifactsByLevel['2'], 1);
    assert.equal(preview.session.available, true);
    assert.equal(preview.session.current.messageLines, 4);
    assert.equal(preview.session.removed.messageLines, 2);
    assert.equal(preview.session.result.messageLines, 2);
  });

  it('apply rollback prunes messages and artifacts and creates backup', () => {
    const result = rollbackService.applyRollback(agentId, '2026-02-06T10:01:30.000Z');

    assert.equal(typeof result.backupId, 'string');

    const updatedStore = store.loadStore(agentId);
    assert.equal(updatedStore.messages.length, 0);
    assert.equal((updatedStore.artifacts[1] || []).length, 1);
    assert.equal((updatedStore.artifacts[2] || []).length, 0);

    const archived = store.readAllArchivedMessages(agentId);
    assert.equal(archived.length, 2);
    assert.equal(archived[0].content, 'm1');
    assert.equal(archived[1].content, 'm2');

    const backups = rollbackService.listBackups(agentId);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].backupId, result.backupId);
    assert.equal(backups[0].manifest.session.sessionId, sessionId);
    assert.equal(typeof backups[0].manifest.session.sourcePath, 'string');

    const sessionPath = path.join(homeDir, '.openclaw', 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
    const sessionLinesAfter = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(sessionLinesAfter.length, 2);
    const parsedAfter = sessionLinesAfter.map((line) => JSON.parse(line));
    assert.equal(parsedAfter[0].message.content, 'session-m1');
    assert.equal(parsedAfter[1].message.content, 'session-m2');
  });

  it('restore rollback backup returns previous state', () => {
    const applied = rollbackService.applyRollback(agentId, '2026-02-06T10:01:30.000Z');
    rollbackService.restoreRollback(agentId, applied.backupId);

    const restoredStore = store.loadStore(agentId);
    assert.equal(restoredStore.messages.length, 2);
    assert.equal((restoredStore.artifacts[1] || []).length, 2);
    assert.equal((restoredStore.artifacts[2] || []).length, 1);

    const archived = store.readAllArchivedMessages(agentId);
    assert.equal(archived.length, 2);
    assert.equal(archived[0].content, 'm1');
    assert.equal(archived[1].content, 'm2');

    const sessionPath = path.join(homeDir, '.openclaw', 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
    const sessionLinesRestored = fs.readFileSync(sessionPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(sessionLinesRestored.length, 4);
    const parsedRestored = sessionLinesRestored.map((line) => JSON.parse(line));
    assert.equal(parsedRestored[2].message.content, 'session-m3');
    assert.equal(parsedRestored[3].message.content, 'session-m4');
  });
});
