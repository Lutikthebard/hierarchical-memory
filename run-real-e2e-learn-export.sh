#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_CONFIG_PATH="${HM_AGENTS_CONFIG_PATH:-$ROOT_DIR/agents.json}"
HM_DATA_DIR="${HM_DATA_DIR:-$ROOT_DIR/data}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
OPENCLAW_AGENTS_DIR="${OPENCLAW_AGENTS_DIR:-$OPENCLAW_HOME/agents}"
DEFAULT_AGENT_ID="hm-real-learn-$(date +%Y%m%d-%H%M%S)"
AGENT_ID="${HM_REAL_LEARN_AGENT_ID:-$DEFAULT_AGENT_ID}"
AGENT_MODEL="${HM_REAL_LEARN_MODEL:-openai-codex/gpt-5.1-codex-mini}"
AGENT_WORKSPACE_BASE="${HM_REAL_LEARN_WORKSPACE_BASE:-$ROOT_DIR/tmp/real-e2e-learn-export/agent-workspace}"
PORT_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_ID="${2:-$AGENT_ID}"
      shift 2
      ;;
    --port)
      PORT_OVERRIDE="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

AGENT_WORKSPACE_DIR="$AGENT_WORKSPACE_BASE/$AGENT_ID"

mkdir -p "$(dirname "$AGENTS_CONFIG_PATH")"
mkdir -p "$HM_DATA_DIR"
mkdir -p "$AGENT_WORKSPACE_DIR"

node - "$AGENTS_CONFIG_PATH" "$HM_DATA_DIR" "$AGENT_ID" "$OPENCLAW_HOME" "$OPENCLAW_AGENTS_DIR" "$AGENT_WORKSPACE_DIR" "$AGENT_MODEL" <<'NODE'
const fs = require('fs');
const path = require('path');

const configPath = process.argv[2];
const dataDir = process.argv[3];
const agentId = process.argv[4];
const openclawHome = process.argv[5];
const openclawAgentsDir = process.argv[6];
const workspaceDir = process.argv[7];
const model = process.argv[8];

let config = { agents: [] };
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_e) {
    config = { agents: [] };
  }
}

if (!config || typeof config !== 'object') config = { agents: [] };
if (!Array.isArray(config.agents)) config.agents = [];

let changed = false;
let agent = config.agents.find((item) => item && item.id === agentId);
if (!agent) {
  agent = {
    id: agentId,
    name: agentId,
    enabled: false,
    isSubagent: false
  };
  config.agents.push(agent);
  changed = true;
} else {
  if (!agent.name) {
    agent.name = agentId;
    changed = true;
  }
  if (agent.enabled !== false) {
    agent.enabled = false;
    changed = true;
  }
  if (agent.isSubagent !== false) {
    agent.isSubagent = false;
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`[run-real-learn] Ensured agent "${agentId}" exists with enabled=false in ${configPath}`);
} else {
  console.log(`[run-real-learn] Agent "${agentId}" already configured with enabled=false in ${configPath}`);
}

const agentDir = path.join(dataDir, agentId);
const agentConfigPath = path.join(agentDir, 'config.json');
fs.mkdirSync(agentDir, { recursive: true });

let agentConfig = {};
if (fs.existsSync(agentConfigPath)) {
  try {
    agentConfig = JSON.parse(fs.readFileSync(agentConfigPath, 'utf8'));
  } catch (_e) {
    agentConfig = {};
  }
}
if (!agentConfig || typeof agentConfig !== 'object') agentConfig = {};
if (!agentConfig.autoCompact || typeof agentConfig.autoCompact !== 'object') {
  agentConfig.autoCompact = {};
}
if (!agentConfig.autoInjectContext || typeof agentConfig.autoInjectContext !== 'object') {
  agentConfig.autoInjectContext = {};
}

agentConfig.autoCompact.enabled = false;
agentConfig.autoInjectContext.enabled = false;
agentConfig.autoInjectContext.onCompaction = false;
agentConfig.autoInjectContext.onNewSession = false;

fs.writeFileSync(agentConfigPath, JSON.stringify(agentConfig, null, 2), 'utf8');
console.log(`[run-real-learn] Forced autoCompact/autoInject OFF for "${agentId}" in ${agentConfigPath}`);

const openclawConfigPath = path.join(openclawHome, 'openclaw.json');
if (!fs.existsSync(openclawConfigPath)) {
  throw new Error(`openclaw.json not found: ${openclawConfigPath}`);
}

let openclaw = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
if (!openclaw || typeof openclaw !== 'object') openclaw = {};
if (!openclaw.agents || typeof openclaw.agents !== 'object') openclaw.agents = {};
if (!Array.isArray(openclaw.agents.list)) openclaw.agents.list = [];
if (!openclaw.agents.defaults || typeof openclaw.agents.defaults !== 'object') {
  openclaw.agents.defaults = {};
}
if (!openclaw.agents.defaults.models || typeof openclaw.agents.defaults.models !== 'object') {
  openclaw.agents.defaults.models = {};
}

let openclawChanged = false;
let ocAgent = openclaw.agents.list.find((item) => item && item.id === agentId);
if (!ocAgent) {
  ocAgent = { id: agentId };
  openclaw.agents.list.push(ocAgent);
  openclawChanged = true;
}
if (ocAgent.workspace !== workspaceDir) {
  ocAgent.workspace = workspaceDir;
  openclawChanged = true;
}
if (!ocAgent.model || typeof ocAgent.model !== 'object') {
  ocAgent.model = {};
  openclawChanged = true;
}
if (ocAgent.model.primary !== model) {
  ocAgent.model.primary = model;
  openclawChanged = true;
}
if (!openclaw.agents.defaults.models[model]) {
  openclaw.agents.defaults.models[model] = {};
  openclawChanged = true;
}

if (openclawChanged) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(openclawHome, `openclaw.json.bak.hm-real-learn-${stamp}`);
  fs.copyFileSync(openclawConfigPath, backupPath);
  fs.writeFileSync(openclawConfigPath, JSON.stringify(openclaw, null, 2), 'utf8');
  console.log(`[run-real-learn] Provisioned OpenClaw agent "${agentId}" in ${openclawConfigPath}`);
} else {
  console.log(`[run-real-learn] OpenClaw agent "${agentId}" already provisioned in ${openclawConfigPath}`);
}

fs.mkdirSync(path.join(openclawAgentsDir, agentId, 'agent'), { recursive: true });
fs.mkdirSync(path.join(openclawAgentsDir, agentId, 'sessions'), { recursive: true });
console.log(`[run-real-learn] Ensured OpenClaw dirs for "${agentId}" in ${path.join(openclawAgentsDir, agentId)}`);
NODE

node - "$ROOT_DIR" "$AGENT_ID" <<'NODE'
const path = require('path');

const rootDir = process.argv[2];
const agentId = process.argv[3];

async function main() {
  const { OpenClawClient } = require(path.join(rootDir, 'scripts', 'gateway-client'));
  const gatewayUrl = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
  const gatewayToken = process.env.GATEWAY_TOKEN || undefined;
  const gatewayPassword = process.env.GATEWAY_PASSWORD || undefined;
  const sessionKey = `agent:${agentId}:main`;

  const client = new OpenClawClient(gatewayUrl, gatewayToken, {
    gatewayPassword,
    postWaitPollIntervalMs: 500,
    postWaitWindowMs: 5000
  });

  try {
    await client.connect();
    await client.sendAndWait(sessionKey, '/status', 45);
    console.log(`[run-real-learn] Session bootstrap sent: /status -> ${sessionKey}`);
  } catch (e) {
    console.warn(`[run-real-learn] Warning: /status bootstrap failed for ${sessionKey}: ${e.message}`);
  } finally {
    try {
      client.close();
    } catch (_e) {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.warn(`[run-real-learn] Warning: bootstrap step failed: ${e.message}`);
    process.exit(0);
  });
NODE

export HM_AGENTS_CONFIG_PATH="$AGENTS_CONFIG_PATH"
export HM_DATA_DIR="$HM_DATA_DIR"
export OPENCLAW_AGENTS_DIR="$OPENCLAW_AGENTS_DIR"

if [[ -n "$PORT_OVERRIDE" ]]; then
  export PORT="$PORT_OVERRIDE"
fi

echo "[run-real-learn] Agent ID: $AGENT_ID"
echo "[run-real-learn] Agent workspace: $AGENT_WORKSPACE_DIR"
echo "[run-real-learn] Starting frontend..."
exec bash "$ROOT_DIR/start-frontend.sh"
