const fs = require('fs');
const path = require('path');
const store = require('./store');
const { toPositiveInt } = require('./summarization-thresholds');
const { clampArtifactsToParentRange } = require('../web/services/artifact-levels');

function toTimestampMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseDateInput(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const parsed = toTimestampMs(value);
  if (parsed === null) {
    throw new Error(`${fieldName} must be a valid date`);
  }
  return parsed;
}

function sortArtifactsAsc(artifacts) {
  return [...artifacts].sort((a, b) => {
    const aEnd = toTimestampMs(a.endTimestamp) || 0;
    const bEnd = toTimestampMs(b.endTimestamp) || 0;
    if (aEnd !== bEnd) return aEnd - bEnd;
    const aStart = toTimestampMs(a.startTimestamp) || 0;
    const bStart = toTimestampMs(b.startTimestamp) || 0;
    if (aStart !== bStart) return aStart - bStart;
    return String(a.artifactId || '').localeCompare(String(b.artifactId || ''));
  });
}

function sortMessagesAsc(messages) {
  return [...messages].sort((a, b) => {
    const aTs = toTimestampMs(a.timestamp) || 0;
    const bTs = toTimestampMs(b.timestamp) || 0;
    return aTs - bTs;
  });
}

function messageIdentity(message) {
  return [
    String(message.timestamp || ''),
    String(message.role || ''),
    String(message.content || ''),
    String(message.messageClass || ''),
    String(message.direction || '')
  ].join('|');
}

function dedupeMessages({ archived, active }) {
  const map = new Map();
  for (const message of archived || []) {
    map.set(messageIdentity(message), message);
  }
  for (const message of active || []) {
    map.set(messageIdentity(message), message);
  }
  return Array.from(map.values());
}

function artifactInDateRange(artifact, dateFromMs, dateToMs) {
  const startMs = toTimestampMs(artifact.startTimestamp);
  const endMs = toTimestampMs(artifact.endTimestamp);
  if (startMs === null || endMs === null) return false;
  if (dateFromMs !== null && endMs < dateFromMs) return false;
  if (dateToMs !== null && startMs > dateToMs) return false;
  return true;
}

function messageInDateRange(message, dateFromMs, dateToMs) {
  const ts = toTimestampMs(message.timestamp);
  if (ts === null) return false;
  if (dateFromMs !== null && ts < dateFromMs) return false;
  if (dateToMs !== null && ts > dateToMs) return false;
  return true;
}

function escapeMdInline(text) {
  return String(text || '').replace(/[`]/g, '\\`');
}

function normalizeFileName(rawName) {
  const original = String(rawName || '').trim();
  if (!original) return '';
  const cleaned = original.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!cleaned) return '';
  return cleaned.toLowerCase().endsWith('.md') ? cleaned : `${cleaned}.md`;
}

function computeMaxLevel(artifactsMap = {}) {
  const levels = Object.keys(artifactsMap)
    .map((level) => Number(level))
    .filter((level) => Number.isInteger(level) && level > 0);
  return levels.length > 0 ? Math.max(...levels) : 0;
}

function normalizeLevelRange(fromLevel, toLevel, maxLevel) {
  if (maxLevel < 1) {
    throw new Error('No artifacts found for this agent');
  }

  const from = toPositiveInt(fromLevel) || 1;
  const toRaw = toPositiveInt(toLevel) || maxLevel;
  const to = Math.min(toRaw, maxLevel);

  if (from > to) {
    throw new Error(`Invalid level range: fromLevel (${from}) > toLevel (${to})`);
  }
  if (from > maxLevel) {
    throw new Error(`fromLevel (${from}) is out of range (max ${maxLevel})`);
  }

  return { fromLevel: from, toLevel: to };
}

function buildArtifactsByLevel(artifactsMap = {}) {
  const result = {};
  for (const [key, list] of Object.entries(artifactsMap || {})) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 1) continue;
    if (!Array.isArray(list)) {
      result[level] = [];
      continue;
    }
    result[level] = sortArtifactsAsc(list.map((artifact) => ({
      ...artifact,
      level
    })));
  }
  return result;
}

function createExportLearnedContextService(deps = {}) {
  const runtime = {
    fs: deps.fs || fs,
    path: deps.path || path,
    loadStore: deps.loadStore || store.loadStore,
    getArchivedMessages: deps.getArchivedMessages || store.getArchivedMessages,
    getDataDir: deps.getDataDir || store.getDataDir
  };

  function formatNodeMarkdownLines(node, indent = 0) {
    const pad = '  '.repeat(indent);
    if (node.type === 'message') {
      const archivedLabel = node.archived ? ' [ARCHIVED]' : '';
      const role = String(node.role || 'unknown').toUpperCase();
      return [
        `${pad}- L0 message${archivedLabel} [${node.timestamp || 'unknown'}] ${role}`,
        `${pad}  > ${String(node.content || '').split('\n').join(`\n${pad}  > `)}`
      ];
    }

    const lines = [
      `${pad}- L${node.level} artifact \`${escapeMdInline(node.artifactId || 'no-id')}\` (${node.startTimestamp || 'unknown'} -> ${node.endTimestamp || 'unknown'})`
    ];
    const content = String(node.content || '').trim();
    if (content) {
      lines.push(`${pad}  > ${content.split('\n').join(`\n${pad}  > `)}`);
    }
    for (const child of node.children || []) {
      lines.push(...formatNodeMarkdownLines(child, indent + 1));
    }
    return lines;
  }

  function buildMarkdown({
    agentId,
    filters,
    roots,
    stats,
    generatedAt
  }) {
    const lines = [
      '# Learned Context Export',
      '',
      `- Agent: \`${escapeMdInline(agentId)}\``,
      `- Generated: ${generatedAt}`,
      `- Level range: L${filters.fromLevel} -> L${filters.toLevel}`,
      `- Date range: ${filters.dateFrom || 'all'} -> ${filters.dateTo || 'all'}`,
      `- Include archived L0 messages: ${filters.includeArchivedMessages ? 'yes' : 'no'}`,
      `- Root artifacts: ${stats.rootArtifacts}`,
      `- Total nodes: ${stats.totalNodes} (artifacts=${stats.artifactNodes}, messages=${stats.messageNodes})`,
      '',
      '## Drilldown',
      ''
    ];

    if (!Array.isArray(roots) || roots.length === 0) {
      lines.push('_No artifacts matched selected filters._');
      return lines.join('\n');
    }

    for (const root of roots) {
      lines.push(...formatNodeMarkdownLines(root, 0));
    }

    return lines.join('\n');
  }

  async function runExportLearnedContext({
    agentId,
    fromLevel,
    toLevel,
    dateFrom,
    dateTo,
    includeArchivedMessages = true,
    outputFileName,
    maxNodes
  } = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }

    const storeData = runtime.loadStore(agentId);
    const artifactsByLevel = buildArtifactsByLevel(storeData.artifacts || {});
    const maxLevel = computeMaxLevel(artifactsByLevel);
    const levels = normalizeLevelRange(fromLevel, toLevel, maxLevel);

    const dateFromMs = parseDateInput(dateFrom, 'dateFrom');
    const dateToMs = parseDateInput(dateTo, 'dateTo');
    if (dateFromMs !== null && dateToMs !== null && dateFromMs > dateToMs) {
      throw new Error('Invalid date range: dateFrom is after dateTo');
    }

    const capNodes = toPositiveInt(maxNodes) || 5000;
    let totalNodes = 0;
    let artifactNodes = 0;
    let messageNodes = 0;

    function nextNode(type) {
      totalNodes += 1;
      if (type === 'artifact') artifactNodes += 1;
      if (type === 'message') messageNodes += 1;
      if (totalNodes > capNodes) {
        throw new Error(`Export tree exceeded maxNodes limit (${capNodes})`);
      }
    }

    function buildMessageChildren(parentArtifact) {
      const fromTs = parentArtifact.startTimestamp;
      const toTs = parentArtifact.endTimestamp;
      const archivedRaw = includeArchivedMessages
        ? runtime.getArchivedMessages(agentId, fromTs, toTs)
        : [];

      const archived = (archivedRaw || []).map((message) => ({ ...message, archived: true }));
      const active = (storeData.messages || [])
        .filter((message) => {
          const ts = toTimestampMs(message.timestamp);
          const minTs = toTimestampMs(fromTs);
          const maxTs = toTimestampMs(toTs);
          return ts !== null && minTs !== null && maxTs !== null && ts >= minTs && ts <= maxTs;
        })
        .map((message) => ({ ...message, archived: false }));

      const merged = dedupeMessages({ archived, active })
        .filter((message) => messageInDateRange(message, dateFromMs, dateToMs));

      return sortMessagesAsc(merged).map((message) => {
        nextNode('message');
        return {
          type: 'message',
          level: 0,
          timestamp: message.timestamp || null,
          role: message.role || null,
          content: String(message.content || ''),
          archived: message.archived === true
        };
      });
    }

    function buildArtifactNode(artifact, level) {
      nextNode('artifact');
      const node = {
        type: 'artifact',
        level,
        artifactId: artifact.artifactId || null,
        startTimestamp: artifact.startTimestamp || null,
        endTimestamp: artifact.endTimestamp || null,
        content: String(artifact.content || ''),
        children: []
      };

      if (level === 1 && levels.fromLevel <= 1) {
        node.children = buildMessageChildren(artifact);
        return node;
      }

      const sourceLevel = level - 1;
      if (sourceLevel < levels.fromLevel) {
        return node;
      }

      const sourceArtifacts = artifactsByLevel[sourceLevel] || [];
      node.children = clampArtifactsToParentRange(sourceArtifacts, artifact)
        .filter((child) => artifactInDateRange(child, dateFromMs, dateToMs))
        .map((child) => buildArtifactNode(child, sourceLevel));
      return node;
    }

    const rootCandidates = artifactsByLevel[levels.toLevel] || [];
    const rootArtifacts = rootCandidates.filter((artifact) => artifactInDateRange(artifact, dateFromMs, dateToMs));
    const roots = rootArtifacts.map((artifact) => buildArtifactNode(artifact, levels.toLevel));

    const generatedAt = new Date().toISOString();
    const exportDir = runtime.path.join(runtime.getDataDir(), agentId, 'exports');
    runtime.fs.mkdirSync(exportDir, { recursive: true });

    const generatedFileName = normalizeFileName(outputFileName)
      || `learned-context-export-${generatedAt.replace(/[:.]/g, '-')}.md`;
    const exportPath = runtime.path.join(exportDir, generatedFileName);

    const filters = {
      fromLevel: levels.fromLevel,
      toLevel: levels.toLevel,
      dateFrom: dateFrom ? new Date(dateFrom).toISOString() : null,
      dateTo: dateTo ? new Date(dateTo).toISOString() : null,
      includeArchivedMessages: includeArchivedMessages !== false
    };
    const stats = {
      rootArtifacts: roots.length,
      totalNodes,
      artifactNodes,
      messageNodes
    };

    const markdown = buildMarkdown({
      agentId,
      filters,
      roots,
      stats,
      generatedAt
    });
    runtime.fs.writeFileSync(exportPath, markdown, 'utf8');

    return {
      agentId,
      generatedAt,
      filters,
      stats,
      tree: {
        roots
      },
      file: {
        path: exportPath,
        name: generatedFileName,
        bytes: Buffer.byteLength(markdown, 'utf8')
      }
    };
  }

  return {
    runExportLearnedContext,
    normalizeLevelRange,
    buildArtifactsByLevel
  };
}

module.exports = {
  createExportLearnedContextService
};
