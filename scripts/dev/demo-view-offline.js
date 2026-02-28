#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEMO_ROOT = path.join(ROOT_DIR, 'tmp', 'multiagent-demo');
const TEST_SNAPSHOT_ROOT = path.join(ROOT_DIR, 'tmp', 'latest-test-run');
const SOURCE_ROOT = fs.existsSync(path.join(TEST_SNAPSHOT_ROOT, 'data'))
  ? TEST_SNAPSHOT_ROOT
  : DEMO_ROOT;
const HOME_DIR = path.join(SOURCE_ROOT, 'home');
const DATA_DIR = path.join(SOURCE_ROOT, 'data');
const AGENTS_CONFIG_PATH = path.join(SOURCE_ROOT, 'agents.json');
const VIEW_AGENTS_CONFIG_PATH = path.join(DEMO_ROOT, 'agents-view.json');
const PORT = parseInt(process.env.PORT || '3459', 10);

function ensureViewConfig() {
  if (!fs.existsSync(DATA_DIR) || !fs.existsSync(AGENTS_CONFIG_PATH)) {
    throw new Error('Demo data not found. Run `npm run demo:multiagent:offline` first.');
  }

  const config = JSON.parse(fs.readFileSync(AGENTS_CONFIG_PATH, 'utf8'));
  const agents = Array.isArray(config.agents) ? config.agents : [];
  const viewConfig = {
    agents: agents.map((a) => ({
      ...a,
      enabled: false
    }))
  };
  fs.writeFileSync(VIEW_AGENTS_CONFIG_PATH, JSON.stringify(viewConfig, null, 2), 'utf8');
}

function main() {
  try {
    ensureViewConfig();
  } catch (err) {
    console.error(`[demo:view] ${err.message}`);
    process.exit(1);
  }

  console.log(`[demo:view] Dashboard: http://localhost:${PORT}`);
  console.log(`[demo:view] Data: ${DATA_DIR}`);
  console.log(`[demo:view] Source: ${SOURCE_ROOT}`);
  console.log('[demo:view] Read-only visualization mode (watchers disabled).');

  const server = spawn('node', [path.join(ROOT_DIR, 'web/server.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      PORT: String(PORT),
      HM_LLM_MODE: 'mock',
      HM_DATA_DIR: DATA_DIR,
      HM_AGENTS_CONFIG_PATH: VIEW_AGENTS_CONFIG_PATH
    },
    stdio: 'inherit'
  });

  const shutdown = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main();
