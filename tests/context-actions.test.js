const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveInjectMdPath,
  buildInjectedContextMessage,
  sendCompactMessage,
  injectCurrentContext
} = require('../scripts/context-actions');

describe('context-actions', () => {
  it('rejects non-md and out-of-root paths', () => {
    const root = path.join(os.tmpdir(), 'hm-context-actions-root');
    assert.equal(resolveInjectMdPath('notes.txt', root), null);
    assert.equal(resolveInjectMdPath('../outside.md', root), null);
  });

  it('builds injected message with pre/post text and markdown files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-context-actions-'));
    const preMd = path.join(tmp, 'pre.md');
    const postMd = path.join(tmp, 'post.md');
    fs.writeFileSync(preMd, 'PRE_FILE', 'utf8');
    fs.writeFileSync(postMd, 'POST_FILE', 'utf8');

    const msg = buildInjectedContextMessage(
      'compaction',
      'CTX_BODY',
      {
        preText: 'PRE_TEXT',
        postText: 'POST_TEXT',
        preMdFiles: [preMd],
        postMdFiles: [postMd]
      },
      { projectRoot: tmp }
    );

    assert.match(msg, /PRE_TEXT/);
    assert.match(msg, /PRE_FILE/);
    assert.match(msg, /CTX_BODY/);
    assert.match(msg, /POST_TEXT/);
    assert.match(msg, /POST_FILE/);
  });

  it('sends compact command with optional message', async () => {
    let sent = null;
    await sendCompactMessage({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      postCompactMessage: 'continue',
      sendFn: ({ message }) => {
        sent = message;
      }
    });
    assert.equal(sent, '/compact continue');
  });

  it('injects current context from CONTEXT.md', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-context-actions-'));
    const contextPath = path.join(tmp, 'CONTEXT.md');
    fs.writeFileSync(contextPath, '# Memory Context\n\nBody', 'utf8');

    let sentPayload = null;
    const result = await injectCurrentContext({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      contextPath,
      reason: 'manual',
      autoInjectConfig: { enabled: false, preText: '', postText: '', preMdFiles: [], postMdFiles: [] },
      requireEnabled: false,
      sendFn: (payload) => {
        sentPayload = payload;
      }
    });

    assert.equal(result.success, true);
    assert.equal(typeof sentPayload.message, 'string');
    assert.match(sentPayload.message, /Memory Context/);
  });

  it('returns skip when context missing', async () => {
    const result = await injectCurrentContext({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      contextPath: path.join(os.tmpdir(), 'does-not-exist-CONTEXT.md'),
      requireEnabled: false,
      autoInjectConfig: {}
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'context-missing');
  });
});
