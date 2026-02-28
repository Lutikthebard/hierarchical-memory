const crypto = require('crypto');
const { createArtifactRepo } = require('../store-artifacts-repo');

function hashContent(content) {
  return crypto.createHash('sha1').update(String(content || '')).digest('hex');
}

function ensureArtifactId(level, artifact) {
  if (artifact.artifactId) {
    return artifact.artifactId;
  }
  const identity = `L${level}|${artifact.startTimestamp || ''}|${artifact.endTimestamp || ''}|${hashContent(artifact.content || '')}`;
  return `a_${crypto.createHash('sha1').update(identity).digest('hex').slice(0, 20)}`;
}

function createArtifactsApi({ compareTimestamps, getArtifactsRootDir, getArtifactsIndexPath }) {
  function normalizeArtifact(level, artifact) {
    if (!artifact || typeof artifact !== 'object') {
      return null;
    }
    const parsedLevel = Number(level);
    const normalizedLevel = Number.isNaN(parsedLevel) ? Number(artifact.level || 0) : parsedLevel;
    const normalized = {
      ...artifact,
      level: normalizedLevel
    };
    normalized.content = String(normalized.content || '');
    normalized.contentHash = normalized.contentHash || hashContent(normalized.content);
    normalized.artifactId = ensureArtifactId(normalizedLevel, normalized);
    if (typeof normalized.contextEligible !== 'boolean') {
      normalized.contextEligible = normalized.content.trim().length > 0;
    }
    return normalized;
  }

  function compareArtifactOrdering(a, b) {
    const endCmp = compareTimestamps(a.endTimestamp, b.endTimestamp);
    if (endCmp !== 0) return endCmp;
    const startCmp = compareTimestamps(a.startTimestamp, b.startTimestamp);
    if (startCmp !== 0) return startCmp;
    return String(a.artifactId || '').localeCompare(String(b.artifactId || ''));
  }

  function mergeArtifactMaps(maps) {
    const merged = {};
    const seen = new Set();

    for (const map of maps) {
      if (!map || typeof map !== 'object') continue;
      for (const [levelKey, artifacts] of Object.entries(map)) {
        if (!Array.isArray(artifacts)) continue;
        for (const artifact of artifacts) {
          const normalized = normalizeArtifact(levelKey, artifact);
          if (!normalized) continue;
          const dedupeKey =
            normalized.artifactId ||
            `${normalized.level}|${normalized.startTimestamp || ''}|${normalized.endTimestamp || ''}|${normalized.contentHash || ''}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
          if (!merged[normalized.level]) {
            merged[normalized.level] = [];
          }
          merged[normalized.level].push(normalized);
        }
      }
    }

    for (const artifacts of Object.values(merged)) {
      artifacts.sort(compareArtifactOrdering);
    }

    return merged;
  }

  function addArtifact(store, level, { content, startTimestamp, endTimestamp, messageCount, sourceLevel, artifactCount }) {
    if (!store.artifacts[level]) {
      store.artifacts[level] = [];
    }

    const isDuplicate = store.artifacts[level].some(
      (a) => a.startTimestamp === startTimestamp && a.endTimestamp === endTimestamp
    );
    if (isDuplicate) {
      console.log(`[store] Skipping duplicate artifact: ${startTimestamp} → ${endTimestamp}`);
      return null;
    }

    const artifact = {
      content,
      level,
      startTimestamp,
      endTimestamp,
      createdAt: new Date().toISOString()
    };

    if (messageCount !== undefined) {
      artifact.messageCount = messageCount;
    }
    if (sourceLevel !== undefined) {
      artifact.sourceLevel = sourceLevel;
      artifact.artifactCount = artifactCount;
    }

    artifact.contentHash = hashContent(artifact.content);
    artifact.artifactId = ensureArtifactId(level, artifact);
    artifact.contextEligible = artifact.content.trim().length > 0;

    store.artifacts[level].push(artifact);
    return artifact;
  }

  const {
    loadLegacyArtifacts,
    loadLongTermArtifacts,
    writeLongTermArtifacts
  } = createArtifactRepo({
    normalizeArtifact,
    getArtifactsRootDir,
    getArtifactsIndexPath
  });

  return {
    hashContent,
    ensureArtifactId,
    normalizeArtifact,
    mergeArtifactMaps,
    addArtifact,
    loadLegacyArtifacts,
    loadLongTermArtifacts,
    writeLongTermArtifacts
  };
}

module.exports = {
  createArtifactsApi
};
