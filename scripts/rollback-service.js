const fs = require('fs');
const path = require('path');
const store = require('./store');
const { loadLastSessionBinding } = require('./shared/session-binding');

const ROLLBACK_DIRNAME = 'rollback-backups';
const HISTORY_FILE = 'rollback-history.jsonl';
const LOCK_FILE = 'rollback.lock';

function parseCutoff(cutoffTs) {
  const value = String(cutoffTs || '').trim();
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) {
    throw new Error('cutoffTs must be ISO UTC (e.g. 2026-02-21T18:00:00.000Z)');
  }
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    throw new Error('Invalid cutoffTs');
  }
  return new Date(time).toISOString();
}

function getAgentDir(agentId) {
  return path.join(store.getDataDir(), agentId);
}

function getBackupsDir(agentId) {
  return path.join(getAgentDir(agentId), ROLLBACK_DIRNAME);
}

function getHistoryPath(agentId) {
  return path.join(getAgentDir(agentId), HISTORY_FILE);
}

function getLockPath(agentId) {
  return path.join(getAgentDir(agentId), LOCK_FILE);
}

function getOpenClawAgentsDir() {
  if (process.env.OPENCLAW_AGENTS_DIR) {
    return path.resolve(process.env.OPENCLAW_AGENTS_DIR);
  }
  return path.join(process.env.HOME || '', '.openclaw', 'agents');
}

function findSessionPath(agentId, sessionId) {
  if (!sessionId) return null;
  const openclawAgentsDir = getOpenClawAgentsDir();
  const candidates = [
    path.join(openclawAgentsDir, agentId, 'sessions', `${sessionId}.jsonl`),
    path.join(openclawAgentsDir, 'main', 'sessions', `${sessionId}.jsonl`)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveActiveSessionFile(agentId) {
  const binding = loadLastSessionBinding(agentId, store.getDataDir());
  const fromBindingPath = binding.jsonlPath && fs.existsSync(binding.jsonlPath)
    ? path.resolve(binding.jsonlPath)
    : null;
  const fromSessionId = !fromBindingPath ? findSessionPath(agentId, binding.sessionId) : null;
  const jsonlPath = fromBindingPath || fromSessionId;
  return {
    sessionId: binding.sessionId || null,
    sessionKey: binding.sessionKey || null,
    jsonlPath: jsonlPath || null
  };
}

function withRollbackLock(agentId, fn) {
  const lockPath = getLockPath(agentId);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    throw new Error(`Rollback already in progress for ${agentId}`);
  }
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  try {
    return fn();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

function appendHistory(agentId, entry) {
  const historyPath = getHistoryPath(agentId);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readHistory(agentId, limit = 100) {
  const historyPath = getHistoryPath(agentId);
  if (!fs.existsSync(historyPath)) return [];
  const lines = fs.readFileSync(historyPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function listBackupIds(agentId) {
  const backupsDir = getBackupsDir(agentId);
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

function listBackups(agentId) {
  const backupsDir = getBackupsDir(agentId);
  if (!fs.existsSync(backupsDir)) return [];
  const ids = listBackupIds(agentId);
  return ids.map((id) => {
    const manifestPath = path.join(backupsDir, id, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { backupId: id, hasManifest: false };
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { backupId: id, hasManifest: true, manifest };
    } catch (_e) {
      return { backupId: id, hasManifest: false };
    }
  });
}

function flattenArtifactMap(artifactsMap = {}) {
  const all = [];
  for (const [level, artifacts] of Object.entries(artifactsMap)) {
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      all.push({ ...artifact, level: Number(level) });
    }
  }
  all.sort((a, b) => store.compareTimestamps(a.endTimestamp, b.endTimestamp));
  return all;
}

function extractLineTimestampMs(line) {
  try {
    const data = JSON.parse(line);
    const msg = data && typeof data === 'object' ? (data.message || null) : null;
    const rawTs = (
      (msg && msg.timestamp) ||
      (data && data.timestamp) ||
      (data && data.ts) ||
      null
    );
    if (!rawTs) return null;
    const ms = new Date(rawTs).getTime();
    if (Number.isNaN(ms)) return null;
    return ms;
  } catch (_e) {
    return null;
  }
}

function lineIsMessage(line) {
  try {
    const data = JSON.parse(line);
    return data && data.type === 'message';
  } catch (_e) {
    return false;
  }
}

function computeSessionRollbackPlan(agentId, cutoffMs) {
  const activeSession = resolveActiveSessionFile(agentId);
  if (!activeSession.jsonlPath || !fs.existsSync(activeSession.jsonlPath)) {
    return {
      available: false,
      sessionId: activeSession.sessionId || null,
      jsonlPath: activeSession.jsonlPath || null,
      current: { totalLines: 0, messageLines: 0 },
      result: { totalLines: 0, messageLines: 0 },
      removed: { totalLines: 0, messageLines: 0 },
      payload: { nextLines: [] }
    };
  }

  const content = fs.readFileSync(activeSession.jsonlPath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim());
  const nextLines = [];
  let currentMessageLines = 0;
  let removedLines = 0;
  let removedMessageLines = 0;
  let nextMessageLines = 0;

  for (const line of lines) {
    const isMessageLine = lineIsMessage(line);
    if (isMessageLine) currentMessageLines += 1;
    const tsMs = extractLineTimestampMs(line);
    const shouldRemove = tsMs != null && tsMs > cutoffMs;
    if (shouldRemove) {
      removedLines += 1;
      if (isMessageLine) removedMessageLines += 1;
      continue;
    }
    if (isMessageLine) nextMessageLines += 1;
    nextLines.push(line);
  }

  return {
    available: true,
    sessionId: activeSession.sessionId || null,
    sessionKey: activeSession.sessionKey || null,
    jsonlPath: activeSession.jsonlPath,
    current: {
      totalLines: lines.length,
      messageLines: currentMessageLines
    },
    result: {
      totalLines: nextLines.length,
      messageLines: nextMessageLines
    },
    removed: {
      totalLines: removedLines,
      messageLines: removedMessageLines
    },
    payload: {
      nextLines
    }
  };
}

function computeRollbackPlan(agentId, cutoffTs) {
  const cutoff = parseCutoff(cutoffTs);
  const cutoffMs = new Date(cutoff).getTime();

  const currentStore = store.loadStore(agentId);
  const archived = store.readAllArchivedMessages(agentId);
  const allMessages = store.mergeAndSortMessages([...(archived || []), ...((currentStore && currentStore.messages) || [])]);

  const keptMessages = [];
  const removedMessages = [];
  for (const msg of allMessages) {
    const ts = new Date(msg.timestamp).getTime();
    if (ts <= cutoffMs) {
      keptMessages.push(msg);
    } else {
      removedMessages.push(msg);
    }
  }

  const keptArtifacts = {};
  const removedArtifacts = {};
  const allArtifacts = flattenArtifactMap(currentStore.artifacts);
  for (const artifact of allArtifacts) {
    const endMs = new Date(artifact.endTimestamp).getTime();
    if (endMs <= cutoffMs) {
      if (!keptArtifacts[artifact.level]) keptArtifacts[artifact.level] = [];
      keptArtifacts[artifact.level].push(artifact);
    } else {
      if (!removedArtifacts[artifact.level]) removedArtifacts[artifact.level] = [];
      removedArtifacts[artifact.level].push(artifact);
    }
  }

  let lastL1End = null;
  const l1 = keptArtifacts[1] || [];
  if (l1.length > 0) {
    const sorted = [...l1].sort((a, b) => store.compareTimestamps(a.endTimestamp, b.endTimestamp));
    lastL1End = sorted[sorted.length - 1].endTimestamp;
  }

  const nextStoreMessages = lastL1End
    ? keptMessages.filter((m) => store.compareTimestamps(m.timestamp, lastL1End) > 0)
    : keptMessages;
  const nextArchivedMessages = lastL1End
    ? keptMessages.filter((m) => store.compareTimestamps(m.timestamp, lastL1End) <= 0)
    : [];

  const dateSet = new Set();
  for (const msg of nextArchivedMessages) {
    dateSet.add(msg.timestamp.split('T')[0]);
  }

  const session = computeSessionRollbackPlan(agentId, cutoffMs);

  return {
    agentId,
    cutoffTs: cutoff,
    current: {
      storeMessages: (currentStore.messages || []).length,
      archivedMessages: archived.length,
      totalMessages: allMessages.length,
      artifactsByLevel: Object.fromEntries(
        Object.entries(currentStore.artifacts || {}).map(([level, arr]) => [String(level), Array.isArray(arr) ? arr.length : 0])
      )
    },
    result: {
      storeMessages: nextStoreMessages.length,
      archivedMessages: nextArchivedMessages.length,
      totalMessages: keptMessages.length,
      archiveDates: Array.from(dateSet).sort(),
      artifactsByLevel: Object.fromEntries(
        Object.entries(keptArtifacts).map(([level, arr]) => [String(level), arr.length])
      )
    },
    removed: {
      totalMessages: removedMessages.length,
      artifactsByLevel: Object.fromEntries(
        Object.entries(removedArtifacts).map(([level, arr]) => [String(level), arr.length])
      ),
      session: session.removed
    },
    session,
    payload: {
      nextStoreMessages,
      nextArchivedMessages,
      keptArtifacts,
      nextSessionLines: session.payload.nextLines
    }
  };
}

function backupAgentState(agentId, cutoffTs) {
  const agentDir = getAgentDir(agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  const backupsDir = getBackupsDir(agentId);
  fs.mkdirSync(backupsDir, { recursive: true });

  const backupId = `rbk-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}-${Math.random().toString(16).slice(2, 8)}`;
  const backupDir = path.join(backupsDir, backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  const entries = [
    'store.json',
    'messages',
    'artifacts',
    'artifacts-index.json',
    'CONTEXT.md',
    'config.json',
    'last-session.json'
  ];

  const copied = [];
  for (const name of entries) {
    const src = path.join(agentDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backupDir, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
      copied.push({ path: name, type: 'dir' });
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst);
      copied.push({ path: name, type: 'file' });
    }
  }

  const sessionSource = resolveActiveSessionFile(agentId);
  let session = null;
  if (sessionSource.jsonlPath && fs.existsSync(sessionSource.jsonlPath)) {
    const relPath = path.join('__session__', 'active-session.jsonl');
    const dst = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(sessionSource.jsonlPath, dst);
    copied.push({ path: relPath, type: 'file' });
    session = {
      sourcePath: sessionSource.jsonlPath,
      sessionId: sessionSource.sessionId || null,
      sessionKey: sessionSource.sessionKey || null,
      backupPath: relPath
    };
  }

  const manifest = {
    backupId,
    agentId,
    cutoffTs,
    createdAt: new Date().toISOString(),
    files: copied,
    session
  };
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { backupId, backupDir, manifest };
}

function applySessionRollback(sessionPlan) {
  if (!sessionPlan || !sessionPlan.available || !sessionPlan.jsonlPath) {
    return { available: false, truncated: false };
  }
  const nextContent = sessionPlan.payload.nextLines.length > 0
    ? `${sessionPlan.payload.nextLines.join('\n')}\n`
    : '';
  fs.writeFileSync(sessionPlan.jsonlPath, nextContent, 'utf8');
  return {
    available: true,
    truncated: true,
    jsonlPath: sessionPlan.jsonlPath,
    removed: sessionPlan.removed,
    result: sessionPlan.result
  };
}

function applyRollback(agentId, cutoffTs) {
  return withRollbackLock(agentId, () => {
    const plan = computeRollbackPlan(agentId, cutoffTs);
    const backup = backupAgentState(agentId, plan.cutoffTs);

    const nextStore = {
      messages: plan.payload.nextStoreMessages,
      artifacts: plan.payload.keptArtifacts
    };

    try {
      store.saveStore(agentId, nextStore);
      store.rewriteArchivedMessages(agentId, plan.payload.nextArchivedMessages);
      applySessionRollback(plan.session);
    } catch (err) {
      restoreRollbackInternal(agentId, backup.backupId);
      throw err;
    }

    const event = {
      type: 'rollback-apply',
      agentId,
      cutoffTs: plan.cutoffTs,
      backupId: backup.backupId,
      timestamp: new Date().toISOString(),
      result: {
        storeMessages: plan.result.storeMessages,
        archivedMessages: plan.result.archivedMessages,
        totalMessages: plan.result.totalMessages,
        artifactsByLevel: plan.result.artifactsByLevel,
        session: plan.session?.result || null
      }
    };
    appendHistory(agentId, event);

    return {
      ...plan,
      backupId: backup.backupId,
      backupPath: backup.backupDir
    };
  });
}

function previewRollback(agentId, cutoffTs) {
  return computeRollbackPlan(agentId, cutoffTs);
}

function restoreRollbackInternal(agentId, backupId) {
  const backupDir = path.join(getBackupsDir(agentId), backupId);
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  const agentDir = getAgentDir(agentId);
  fs.mkdirSync(agentDir, { recursive: true });
  let manifest = null;
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_e) {
      manifest = null;
    }
  }

  const restoreEntries = [
    'store.json',
    'messages',
    'artifacts',
    'artifacts-index.json',
    'CONTEXT.md',
    'config.json',
    'last-session.json'
  ];

  for (const name of restoreEntries) {
    const target = path.join(agentDir, name);
    fs.rmSync(target, { recursive: true, force: true });
    const src = path.join(backupDir, name);
    if (!fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(src, target);
    }
  }

  const sessionInfo = manifest && manifest.session && typeof manifest.session === 'object'
    ? manifest.session
    : null;
  if (sessionInfo && sessionInfo.sourcePath && sessionInfo.backupPath) {
    const src = path.join(backupDir, sessionInfo.backupPath);
    const target = sessionInfo.sourcePath;
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { force: true });
      fs.cpSync(src, target);
    }
  }
}

function restoreRollback(agentId, backupId) {
  return withRollbackLock(agentId, () => {
    restoreRollbackInternal(agentId, backupId);
    const event = {
      type: 'rollback-restore',
      agentId,
      backupId,
      timestamp: new Date().toISOString()
    };
    appendHistory(agentId, event);

    return {
      success: true,
      agentId,
      backupId
    };
  });
}

module.exports = {
  parseCutoff,
  previewRollback,
  applyRollback,
  restoreRollback,
  listBackups,
  readHistory
};
