#!/usr/bin/env node
/**
 * Backfill inter-agent reply text into store.json from raw session JSONL.
 *
 * Usage:
 *   node scripts/backfill-inter-agent-replies.js <agentId> [--session-jsonl <path>] [--apply]
 *
 * Default mode is dry-run. Use --apply to persist changes.
 */

const fs = require('fs');
const path = require('path');
const { loadStore, saveStore, getDataDir } = require('../store');
const {
  extractSessionsSendToolResultPayload,
  buildSessionsSendResultContent
} = require('../shared/inter-agent');

function getArgValue(args, key) {
  const idx = args.indexOf(key);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function loadLastSessionJsonlPath(agentId) {
  const file = path.join(getDataDir(), agentId, 'last-session.json');
  if (!fs.existsSync(file)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (payload && typeof payload.jsonlPath === 'string' && payload.jsonlPath.trim()) {
      return payload.jsonlPath.trim();
    }
  } catch (_e) {}
  return null;
}

function extractReplyFromMessage(msg) {
  const payload = extractSessionsSendToolResultPayload(msg, { skipNoReply: true });
  if (!payload) return null;
  return {
    toolCallId: payload.toolCallId || null,
    runId: payload.runId || null,
    status: payload.status || null,
    sessionKey: payload.sessionKey || null,
    reply: payload.replyText
  };
}

function main() {
  const args = process.argv.slice(2);
  const agentId = args[0];
  const apply = args.includes('--apply');
  const explicitJsonl = getArgValue(args, '--session-jsonl');

  if (!agentId || agentId.startsWith('-')) {
    console.log('Usage: node scripts/backfill-inter-agent-replies.js <agentId> [--session-jsonl <path>] [--apply]');
    process.exit(1);
  }

  const jsonlPath = explicitJsonl || loadLastSessionJsonlPath(agentId);
  if (!jsonlPath) {
    console.error(`No session JSONL path found for agent "${agentId}". Pass --session-jsonl.`);
    process.exit(1);
  }
  if (!fs.existsSync(jsonlPath)) {
    console.error(`Session JSONL not found: ${jsonlPath}`);
    process.exit(1);
  }

  const byToolCallId = new Map();
  const byRunId = new Map();
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (data.type !== 'message') continue;
      const msg = data.message || data;
      const extracted = extractReplyFromMessage(msg);
      if (!extracted) continue;
      if (extracted.toolCallId) byToolCallId.set(extracted.toolCallId, extracted);
      if (extracted.runId) byRunId.set(extracted.runId, extracted);
    } catch (_e) {}
  }

  const store = loadStore(agentId);
  let scanned = 0;
  let matched = 0;
  let updated = 0;

  for (const msg of store.messages || []) {
    if (msg.messageClass !== 'inter_agent') continue;
    if (msg.sourceType !== 'toolResult') continue;
    if (msg.toolName !== 'sessions_send') continue;
    scanned++;

    // Already contains a reply body.
    if (typeof msg.content === 'string' && msg.content.includes('\n')) {
      continue;
    }

    let candidate = null;
    if (msg.toolCallId) candidate = byToolCallId.get(msg.toolCallId) || null;
    if (!candidate && msg.runId) candidate = byRunId.get(msg.runId) || null;
    if (!candidate) continue;
    matched++;

    msg.content = buildSessionsSendResultContent(
      msg.toSessionKey || candidate.sessionKey,
      msg.status || candidate.status,
      msg.runId || candidate.runId,
      candidate.reply
    );
    updated++;
  }

  console.log(`agentId=${agentId}`);
  console.log(`sessionJsonl=${jsonlPath}`);
  console.log(`scanned=${scanned} matched=${matched} updated=${updated} mode=${apply ? 'apply' : 'dry-run'}`);

  if (apply && updated > 0) {
    saveStore(agentId, store);
    console.log('store.json updated');
  }
}

main();
