const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveActiveSession,
  getCandidateKeys,
  chooseGatewaySession
} = require('../scripts/session-resolver');

function touch(filePath, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

describe('session resolver', () => {
  it('ignores legacy main:subagent key by default to prevent switching to main session', () => {
    const keys = getCandidateKeys('council-psychologist', true);
    const chosen = chooseGatewaySession([
      {
        key: 'agent:main:subagent:council-psychologist',
        sessionId: 'main-session-id',
        updatedAt: '2026-02-07T10:00:00.000Z'
      }
    ], keys);

    assert.equal(chosen, null);
  });

  it('can include legacy main:subagent key only when explicitly enabled', () => {
    const prev = process.env.HM_ENABLE_LEGACY_SUBAGENT_KEY;
    process.env.HM_ENABLE_LEGACY_SUBAGENT_KEY = '1';
    try {
      const keys = getCandidateKeys('council-psychologist', true);
      const chosen = chooseGatewaySession([
        {
          key: 'agent:main:subagent:council-psychologist',
          sessionId: 'legacy-session-id',
          updatedAt: '2026-02-07T10:00:00.000Z'
        }
      ], keys);

      assert.deepEqual(chosen, {
        sessionKey: 'agent:main:subagent:council-psychologist',
        sessionId: 'legacy-session-id'
      });
    } finally {
      if (typeof prev === 'undefined') {
        delete process.env.HM_ENABLE_LEGACY_SUBAGENT_KEY;
      } else {
        process.env.HM_ENABLE_LEGACY_SUBAGENT_KEY = prev;
      }
    }
  });

  it('prioritizes direct key over :main key for subagent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-session-resolver-'));
    const openclawDir = path.join(tmp, 'openclaw', 'agents');
    const sessionsDir = path.join(openclawDir, 'main', 'sessions');
    touch(path.join(sessionsDir, 'legacy-id.jsonl'), Date.now() - 5000);
    touch(path.join(sessionsDir, 'main-id.jsonl'), Date.now() - 1000);

    const info = await resolveActiveSession({
      agentId: 'council-psychologist',
      isSubagent: true,
      openclawAgentsDir: openclawDir,
      listSessions: async () => ([
        { key: 'agent:council-psychologist', sessionId: 'legacy-id', updatedAt: Date.now() - 100 },
        { key: 'agent:council-psychologist:main', sessionId: 'main-id', updatedAt: Date.now() - 200 }
      ])
    });

    assert.equal(info.sessionId, 'legacy-id');
    assert.equal(info.sessionKey, 'agent:council-psychologist');
    assert.equal(info.source, 'gateway');
  });

  it('falls back to newest file when gateway lookup is unavailable for non-subagent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-session-resolver-'));
    const openclawDir = path.join(tmp, 'openclaw', 'agents');
    const sessionsDir = path.join(openclawDir, 'main', 'sessions');
    touch(path.join(sessionsDir, 'old.jsonl'), Date.now() - 10_000);
    touch(path.join(sessionsDir, 'new.jsonl'), Date.now() - 1_000);

    const info = await resolveActiveSession({
      agentId: 'main',
      isSubagent: false,
      openclawAgentsDir: openclawDir,
      listSessions: async () => {
        throw new Error('gateway unavailable');
      }
    });

    assert.equal(info.sessionId, 'new');
    assert.equal(info.source, 'file-mtime');
    assert.equal(Boolean(info.jsonlPath.endsWith('new.jsonl')), true);
  });

  it('does not fallback to file-mtime for subagent when gateway lookup fails', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-session-resolver-'));
    const openclawDir = path.join(tmp, 'openclaw', 'agents');

    // Subagent keeps own session file in its own folder.
    const subagentDir = path.join(openclawDir, 'council-psychologist', 'sessions');
    touch(path.join(subagentDir, 'subagent-own.jsonl'), Date.now() - 30_000);

    // New auto-created main session appears during night run.
    const mainDir = path.join(openclawDir, 'main', 'sessions');
    touch(path.join(mainDir, 'main-auto-new.jsonl'), Date.now() - 1_000);

    await assert.rejects(
      () => resolveActiveSession({
        agentId: 'council-psychologist',
        isSubagent: true,
        openclawAgentsDir: openclawDir,
        listSessions: async () => {
          throw new Error('gateway unavailable');
        }
      }),
      /Gateway lookup is required for subagent/
    );
  });

  it('chooses highest priority key and then newest update in same priority', () => {
    const keys = getCandidateKeys('main', false);
    const chosen = chooseGatewaySession([
      { key: 'agent:main', sessionId: 'legacy', updatedAt: '2026-02-06T10:00:00.000Z' },
      { key: 'agent:main:main', sessionId: 'new-main', updatedAt: '2026-02-06T09:00:00.000Z' },
      { key: 'agent:main:main', sessionId: 'latest-main', updatedAt: '2026-02-06T11:00:00.000Z' }
    ], keys);

    assert.deepEqual(chosen, {
      sessionKey: 'agent:main:main',
      sessionId: 'latest-main'
    });
  });
});
