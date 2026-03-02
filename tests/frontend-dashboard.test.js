const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScript(ctx, relPath) {
  const root = path.join(__dirname, '..');
  const full = path.join(root, relPath);
  const code = fs.readFileSync(full, 'utf8');
  vm.runInNewContext(code, ctx, { filename: relPath });
}

test('frontend dashboard module composition', () => {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    window: null,
    alert: () => {},
    confirm: () => true,
    fetch: async () => ({ ok: true, json: async () => ({ success: true, agents: [], logs: [] }) }),
    WebSocket: function FakeWs() { return { close() {}, send() {}, readyState: 1 }; }
  };
  ctx.window = ctx;
  ctx.window.HmAppHelpers = {
    defaultClassFilters: {
      storeMessageClasses: ['dialogue', 'inter_agent', 'command'],
      countMessageClasses: ['dialogue'],
      contextMessageClasses: ['dialogue', 'inter_agent']
    },
    normalizeClassFilterArrays: (f) => f,
    parseTextareaList: () => [],
    formatTextareaList: () => '',
    parseKeyValueMap: () => ({}),
    formatKeyValueMap: () => '',
    extractTitle: (s) => s,
    formatTime: (s) => String(s)
  };

  loadScript(ctx, 'web/public/app-state.js');
  loadScript(ctx, 'web/public/app-methods-data.js');
  loadScript(ctx, 'web/public/app-methods-memory-session.js');
  loadScript(ctx, 'web/public/app-methods-memory-learn.js');
  loadScript(ctx, 'web/public/app-methods-memory-rollback.js');
  loadScript(ctx, 'web/public/app-methods-memory.js');
  loadScript(ctx, 'web/public/app-methods-agents.js');
  loadScript(ctx, 'web/public/app-methods.js');
  loadScript(ctx, 'web/public/app.js');

  assert.equal(typeof ctx.dashboard, 'function');
  const d = ctx.dashboard();
  assert.equal(typeof d.loadAgents, 'function');
  assert.equal(typeof d.rebuildContext, 'function');
  assert.equal(typeof d.fullSummarize, 'function');
  assert.equal(typeof d.runLearnContext, 'function');
  assert.equal(typeof d.fillLearnContextFormFromConfig, 'function');
  assert.equal(typeof d.drilldown, 'function');
  assert.equal(typeof d.toggleClass, 'function');
  assert.equal(d.stats.threshold, 60);
  assert.deepEqual(d.artifacts, { L1: [], L2: [], L3: [] });
});

test('rollbackCutoffIso getter stays reactive', () => {
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    window: null,
    alert: () => {},
    confirm: () => true,
    fetch: async () => ({ ok: true, json: async () => ({ success: true }) }),
    WebSocket: function FakeWs() { return { close() {}, send() {}, readyState: 1 }; }
  };
  ctx.window = ctx;
  ctx.window.HmAppHelpers = {
    defaultClassFilters: {
      storeMessageClasses: ['dialogue', 'inter_agent', 'command'],
      countMessageClasses: ['dialogue'],
      contextMessageClasses: ['dialogue', 'inter_agent']
    },
    normalizeClassFilterArrays: (f) => f,
    parseTextareaList: () => [],
    formatTextareaList: () => '',
    parseKeyValueMap: () => ({}),
    formatKeyValueMap: () => '',
    extractTitle: (s) => s,
    formatTime: (s) => String(s)
  };

  loadScript(ctx, 'web/public/app-state.js');
  loadScript(ctx, 'web/public/app-methods-data.js');
  loadScript(ctx, 'web/public/app-methods-memory-session.js');
  loadScript(ctx, 'web/public/app-methods-memory-learn.js');
  loadScript(ctx, 'web/public/app-methods-memory-rollback.js');
  loadScript(ctx, 'web/public/app-methods-memory.js');
  loadScript(ctx, 'web/public/app-methods-agents.js');
  loadScript(ctx, 'web/public/app-methods.js');
  loadScript(ctx, 'web/public/app.js');

  const d = ctx.dashboard();
  d.rollbackCutoffLocal = '2026-02-21T10:15';
  assert.equal(d.rollbackCutoffIso, new Date('2026-02-21T10:15').toISOString());
  d.rollbackCutoffLocal = '';
  assert.equal(d.rollbackCutoffIso, '');
});
