const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { loadAgentConfig } = require('./store');
const { OpenClawClient } = require('./gateway-client');

const execFileAsync = promisify(execFile);
const DEFAULT_GATEWAY_URL = process.env.GATEWAY_URL ?? 'ws://127.0.0.1:18789';

function resolveInjectMdPath(mdPath, projectRoot = path.resolve(__dirname, '..')) {
  const raw = String(mdPath || '').trim();
  if (!raw) return null;
  if (!raw.toLowerCase().endsWith('.md')) return null;

  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(projectRoot, raw);

  const rel = path.relative(projectRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return candidate;
}

function normalizeMdFileList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function readInjectMdFiles(files, label, projectRoot = path.resolve(__dirname, '..')) {
  const chunks = [];
  for (const mdFile of normalizeMdFileList(files)) {
    const resolved = resolveInjectMdPath(mdFile, projectRoot);
    if (!resolved) {
      console.log(`[inject] Skip invalid ${label} markdown path: ${mdFile}`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      console.log(`[inject] ${label} markdown file not found: ${mdFile}`);
      continue;
    }
    try {
      const content = fs.readFileSync(resolved, 'utf8').trim();
      if (content) {
        chunks.push(content);
      }
    } catch (err) {
      console.log(`[inject] Failed to read ${label} markdown file ${mdFile}: ${err.message}`);
    }
  }
  return chunks;
}

function buildInjectedContextMessage(reason, contextContent, autoInject = {}, options = {}) {
  const projectRoot = options.projectRoot || path.resolve(__dirname, '..');
  const preParts = [];
  const postParts = [];

  const preText = String(autoInject.preText || '').trim();
  const postText = String(autoInject.postText || '').trim();
  if (preText) preParts.push(preText);
  if (postText) postParts.push(postText);

  preParts.push(...readInjectMdFiles(autoInject.preMdFiles, 'pre', projectRoot));
  postParts.push(...readInjectMdFiles(autoInject.postMdFiles, 'post', projectRoot));

  const mainBody = `📚 **Hierarchical Memory Context** (auto-injected after ${reason})\n\n${contextContent}`;
  return [...preParts, mainBody, ...postParts].filter(Boolean).join('\n\n');
}

async function sendChatMessage({
  sessionKey,
  message,
  gatewayUrl = DEFAULT_GATEWAY_URL,
  sendFn = null,
  waitForRun = false,
  timeoutMs = 30000
}) {
  if (typeof sendFn === 'function') {
    const result = await sendFn({ sessionKey, message, gatewayUrl, waitForRun, timeoutMs });
    return { success: true, runId: result?.runId || null };
  }

  const crypto = require('crypto');
  const client = new OpenClawClient(gatewayUrl);
  try {
    await client.connect();
    const sendRes = await client.rpc('chat.send', {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
      timeoutMs
    });
    const runId = sendRes?.runId || null;
    if (waitForRun && runId) {
      await client.rpc('agent.wait', {
        runId,
        timeoutMs
      }, timeoutMs + 30000);
    }
    return { success: true, runId };
  } finally {
    await client.close();
  }
}

async function sendCompactMessage({
  agentId,
  sessionKey,
  postCompactMessage = '',
  gatewayUrl = DEFAULT_GATEWAY_URL,
  beforeSend,
  sendFn = null
}) {
  if (typeof beforeSend === 'function') {
    await beforeSend();
  }
  const message = postCompactMessage ? `/compact ${postCompactMessage}` : '/compact';
  await sendChatMessage({ sessionKey, message, gatewayUrl, sendFn });
  return { success: true, agentId, sessionKey, message };
}

async function rebuildContextFile({ agentId, contextPath, scriptDir = __dirname }) {
  const contextScript = path.join(scriptDir, 'context.js');
  await execFileAsync('node', [contextScript, 'generate', agentId, '--output', contextPath], {
    cwd: scriptDir
  });
  const content = fs.readFileSync(contextPath, 'utf8');
  return { contextPath, content };
}

async function injectCurrentContext({
  agentId,
  sessionKey,
  contextPath,
  reason = 'manual',
  gatewayUrl = DEFAULT_GATEWAY_URL,
  requireEnabled = false,
  autoInjectConfig = null,
  sendFn = null
}) {
  const agentConfig = autoInjectConfig || loadAgentConfig(agentId).autoInjectContext || {};
  if (requireEnabled && !agentConfig.enabled) {
    return { success: false, skipped: true, reason: 'auto-inject-disabled' };
  }

  if (!fs.existsSync(contextPath)) {
    return { success: false, skipped: true, reason: 'context-missing' };
  }

  const contextContent = fs.readFileSync(contextPath, 'utf8');
  if (!contextContent.trim()) {
    return { success: false, skipped: true, reason: 'context-empty' };
  }

  const message = buildInjectedContextMessage(reason, contextContent, agentConfig);
  await sendChatMessage({ sessionKey, message, gatewayUrl, sendFn });
  return {
    success: true,
    sessionKey,
    contextBytes: contextContent.length
  };
}

module.exports = {
  resolveInjectMdPath,
  normalizeMdFileList,
  readInjectMdFiles,
  buildInjectedContextMessage,
  sendChatMessage,
  sendCompactMessage,
  rebuildContextFile,
  injectCurrentContext
};
