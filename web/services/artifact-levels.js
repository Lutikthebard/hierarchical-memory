function toLevelNumber(levelKey) {
  const raw = String(levelKey || '').trim();
  if (!raw) return null;
  if (/^L\d+$/i.test(raw)) {
    return Number(raw.slice(1));
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 0 ? Math.floor(n) : null;
}

function sortedLevelNumbers(artifactsMap = {}, ensureLevels = []) {
  const levels = new Set();
  for (const key of Object.keys(artifactsMap || {})) {
    const level = toLevelNumber(key);
    if (level) levels.add(level);
  }
  for (const ensure of ensureLevels) {
    const level = toLevelNumber(ensure);
    if (level) levels.add(level);
  }
  return Array.from(levels).sort((a, b) => a - b);
}

function buildArtifactsByLevel(artifactsMap = {}, ensureLevels = [1, 2, 3]) {
  const result = {};
  for (const level of sortedLevelNumbers(artifactsMap, ensureLevels)) {
    const list = artifactsMap?.[level] || artifactsMap?.[String(level)];
    result[`L${level}`] = Array.isArray(list) ? list : [];
  }
  return result;
}

function buildArtifactCounts(artifactsMap = {}, ensureLevels = [1, 2, 3]) {
  const result = {};
  for (const level of sortedLevelNumbers(artifactsMap, ensureLevels)) {
    const list = artifactsMap?.[level] || artifactsMap?.[String(level)];
    result[`L${level}`] = Array.isArray(list) ? list.length : 0;
  }
  return result;
}

function clampArtifactsToParentRange(sourceArtifacts = [], parentArtifact) {
  if (!parentArtifact) return [];

  const parentStart = new Date(parentArtifact.startTimestamp || 0).getTime();
  const parentEnd = new Date(parentArtifact.endTimestamp || 0).getTime();
  if (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd)) return [];

  const contained = sourceArtifacts.filter((artifact) => {
    const sourceStart = new Date(artifact.startTimestamp || 0).getTime();
    const sourceEnd = new Date(artifact.endTimestamp || 0).getTime();
    if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) return false;
    return sourceStart >= parentStart && sourceEnd <= parentEnd;
  });

  return contained.sort((a, b) => {
    const aEnd = new Date(a.endTimestamp || 0).getTime();
    const bEnd = new Date(b.endTimestamp || 0).getTime();
    if (aEnd !== bEnd) return aEnd - bEnd;
    const aStart = new Date(a.startTimestamp || 0).getTime();
    const bStart = new Date(b.startTimestamp || 0).getTime();
    return aStart - bStart;
  });
}

module.exports = {
  toLevelNumber,
  sortedLevelNumbers,
  buildArtifactsByLevel,
  buildArtifactCounts,
  clampArtifactsToParentRange
};
