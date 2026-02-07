const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyMessage,
  commandAllowed,
  isClassIncludedForTarget,
  normalizeClassFilters
} = require('../scripts/message-classifier');

describe('message-classifier', () => {
  it('classifies dialogue message', () => {
    assert.equal(classifyMessage('user', 'hello there'), 'dialogue');
  });

  it('classifies heartbeat and memory internals', () => {
    assert.equal(classifyMessage('assistant', 'HEARTBEAT_OK'), 'heartbeat');
    assert.equal(classifyMessage('user', 'MEMORY TASK: do summary'), 'memory_internal');
  });

  it('classifies commands and system noise', () => {
    assert.equal(classifyMessage('user', '/status now'), 'command');
    assert.equal(classifyMessage('user', 'System: task failed'), 'system_noise');
  });

  it('checks command allowlist', () => {
    assert.equal(commandAllowed('/status', ['/status']), true);
    assert.equal(commandAllowed('/compact', ['/status']), false);
    assert.equal(commandAllowed('/compact', []), true);
  });

  it('checks target class inclusion with defaults', () => {
    const filters = normalizeClassFilters({});
    assert.equal(isClassIncludedForTarget('dialogue', filters, 'store'), true);
    assert.equal(isClassIncludedForTarget('command', filters, 'store'), false);
  });
});
