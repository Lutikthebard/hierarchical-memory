const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { countSessionMessagesFromJsonl } = require('../scripts/session-message-counter');

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
}

describe('session-message-counter', () => {
  it('counts only countable messages after last compaction', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-session-counter-'));
    const jsonlPath = path.join(tmp, 'session.jsonl');

    appendJsonl(jsonlPath, {
      type: 'message',
      message: { role: 'user', content: 'before compaction', timestamp: '2026-02-08T10:00:00.000Z' }
    });
    appendJsonl(jsonlPath, {
      type: 'compaction',
      timestamp: '2026-02-08T10:05:00.000Z'
    });
    appendJsonl(jsonlPath, {
      type: 'message',
      message: { role: 'user', content: 'count me', timestamp: '2026-02-08T10:06:00.000Z' }
    });
    appendJsonl(jsonlPath, {
      type: 'message',
      message: { role: 'assistant', content: 'count me too', timestamp: '2026-02-08T10:06:10.000Z' }
    });
    appendJsonl(jsonlPath, {
      type: 'message',
      message: { role: 'assistant', content: 'HEARTBEAT_OK', timestamp: '2026-02-08T10:06:20.000Z' }
    });
    appendJsonl(jsonlPath, {
      type: 'message',
      message: { role: 'user', content: '/compact now', timestamp: '2026-02-08T10:06:30.000Z' }
    });

    const count = countSessionMessagesFromJsonl(jsonlPath, {
      filters: {
        exclude: ['HEARTBEAT_OK', 'NO_REPLY'],
        excludePatterns: [],
        countRoles: ['user', 'assistant'],
        storeRoles: ['user', 'assistant']
      }
    });

    assert.equal(count, 2);
  });

  it('returns 0 for missing or invalid files', () => {
    const missing = countSessionMessagesFromJsonl('/tmp/does-not-exist.jsonl', {});
    assert.equal(missing, 0);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-session-counter-bad-'));
    const jsonlPath = path.join(tmp, 'bad.jsonl');
    fs.writeFileSync(jsonlPath, '{not-json}\n', 'utf8');

    const bad = countSessionMessagesFromJsonl(jsonlPath, {});
    assert.equal(bad, 0);
  });
});

