const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACT_CHUNK_SIZE = 50;

function compareArtifactOrdering(a, b) {
  const aEnd = new Date(a?.endTimestamp || 0).getTime();
  const bEnd = new Date(b?.endTimestamp || 0).getTime();
  if (aEnd !== bEnd) return aEnd - bEnd;
  const aStart = new Date(a?.startTimestamp || 0).getTime();
  const bStart = new Date(b?.startTimestamp || 0).getTime();
  if (aStart !== bStart) return aStart - bStart;
  return String(a?.artifactId || '').localeCompare(String(b?.artifactId || ''));
}

function stableStringify(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashArtifactsMap(artifactsByLevel) {
  const levels = Object.keys(artifactsByLevel)
    .map((key) => Number(key))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const canonical = levels.map((level) => ({
    level,
    artifacts: (artifactsByLevel[level] || []).map((artifact) => ({
      artifactId: artifact.artifactId,
      level: artifact.level,
      startTimestamp: artifact.startTimestamp || null,
      endTimestamp: artifact.endTimestamp || null,
      createdAt: artifact.createdAt || null,
      content: artifact.content || '',
      contentHash: artifact.contentHash || null,
      contextEligible: artifact.contextEligible !== false,
      messageCount: artifact.messageCount,
      sourceLevel: artifact.sourceLevel,
      artifactCount: artifact.artifactCount
    }))
  }));

  return crypto.createHash('sha1').update(stableStringify(canonical)).digest('hex');
}

function parseArtifactPayload(filePath, content, normalizeArtifact, levelHint) {
  const ext = path.extname(filePath).toLowerCase();
  const payloads = [];

  if (ext === '.jsonl') {
    const lines = String(content || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      payloads.push(JSON.parse(line));
    }
  } else {
    const parsed = JSON.parse(String(content || '{}'));
    if (Array.isArray(parsed)) {
      for (const item of parsed) payloads.push(item);
    } else if (parsed && typeof parsed === 'object') {
      payloads.push(parsed);
    }
  }

  return payloads
    .map((raw) => normalizeArtifact(levelHint ?? raw?.level, raw))
    .filter(Boolean);
}

function walkArtifactFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      files.push(absPath);
    }
  }

  return files.sort();
}

function cleanupEmptyArtifactDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  const dirs = [];
  while (stack.length > 0) {
    const current = stack.pop();
    dirs.push(current);
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  dirs
    .sort((a, b) => b.length - a.length)
    .forEach((dirPath) => {
      if (dirPath === rootDir) return;
      const children = fs.readdirSync(dirPath);
      if (children.length === 0) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    });
}

function createArtifactRepo({
  normalizeArtifact,
  getArtifactsRootDir,
  getArtifactsIndexPath
}) {
  function loadLegacyArtifacts(storePath) {
    const artifactsPath = path.join(path.dirname(storePath), 'artifacts.json');
    if (!fs.existsSync(artifactsPath)) {
      return {};
    }
    try {
      const artifactsData = fs.readFileSync(artifactsPath, 'utf8');
      const parsed = JSON.parse(artifactsData);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_err) {
      return {};
    }
  }

  function loadLongTermArtifacts(agentId) {
    const rootDir = getArtifactsRootDir(agentId);
    const indexPath = getArtifactsIndexPath(agentId);
    if (!fs.existsSync(rootDir) && !fs.existsSync(indexPath)) {
      return {};
    }

    const result = {};

    function appendArtifact(level, artifact) {
      if (!artifact) return;
      if (!result[level]) {
        result[level] = [];
      }
      result[level].push(artifact);
    }

    function loadByIndex(indexPayload) {
      if (!indexPayload || !Array.isArray(indexPayload.artifacts) || indexPayload.artifacts.length === 0) {
        return false;
      }

      const baseDir = path.dirname(indexPath);
      const byPath = new Map();
      for (const item of indexPayload.artifacts) {
        if (!item || !item.path) continue;
        if (!byPath.has(item.path)) byPath.set(item.path, []);
        byPath.get(item.path).push(item);
      }

      let loadedAny = false;
      for (const [relPath, entries] of byPath.entries()) {
        const absPath = path.resolve(baseDir, relPath);
        if (!fs.existsSync(absPath)) continue;
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          const ext = path.extname(absPath).toLowerCase();
          let parsedItems = [];
          if (ext === '.jsonl') {
            parsedItems = String(content || '')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => JSON.parse(line));
          } else {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              parsedItems = parsed;
            } else if (parsed && typeof parsed === 'object') {
              parsedItems = [parsed];
            }
          }

          for (const item of entries) {
            const level = Number(item.level);
            const offset = Number(item.offset);
            let raw = null;

            if (Number.isInteger(offset) && offset >= 0 && offset < parsedItems.length) {
              raw = parsedItems[offset];
            } else {
              raw = parsedItems.find((candidate) => candidate?.artifactId === item.artifactId) || null;
            }
            const normalized = normalizeArtifact(level, raw);
            if (!normalized) continue;
            appendArtifact(level, normalized);
            loadedAny = true;
          }
        } catch (_e) {
          // Fall through to directory scan if index references invalid files.
        }
      }
      return loadedAny;
    }

    if (fs.existsSync(indexPath)) {
      try {
        const indexPayload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (loadByIndex(indexPayload)) {
          for (const [levelKey, artifacts] of Object.entries(result)) {
            result[levelKey] = artifacts.sort(compareArtifactOrdering);
          }
          return result;
        }
      } catch (_e) {
        // Fall back to directory scan.
      }
    }

    if (!fs.existsSync(rootDir)) {
      return {};
    }

    const levelDirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^L\d+$/.test(entry.name))
      .map((entry) => entry.name);

    for (const levelDirName of levelDirs) {
      const level = Number(levelDirName.slice(1));
      const levelDir = path.join(rootDir, levelDirName);
      const files = walkArtifactFiles(levelDir);
      for (const filePath of files) {
        try {
          const data = fs.readFileSync(filePath, 'utf8');
          const parsedArtifacts = parseArtifactPayload(filePath, data, normalizeArtifact, level);
          if (parsedArtifacts.length === 0) continue;
          if (!result[level]) {
            result[level] = [];
          }
          result[level].push(...parsedArtifacts);
        } catch (_e) {
          // skip invalid artifact payload
        }
      }
    }

    for (const [levelKey, artifacts] of Object.entries(result)) {
      result[levelKey] = artifacts.sort(compareArtifactOrdering);
    }

    return result;
  }

  function writeLongTermArtifacts(agentId, artifactsMap) {
    const rootDir = getArtifactsRootDir(agentId);
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    const normalizedByLevel = {};
    for (const [levelKey, artifacts] of Object.entries(artifactsMap || {})) {
      const level = Number(levelKey);
      if (!Number.isFinite(level)) continue;
      if (!Array.isArray(artifacts) || artifacts.length === 0) continue;
      const normalizedArtifacts = artifacts
        .map((artifact) => normalizeArtifact(level, artifact))
        .filter(Boolean)
        .sort(compareArtifactOrdering);
      if (normalizedArtifacts.length > 0) {
        normalizedByLevel[level] = normalizedArtifacts;
      }
    }

    const artifactsHash = hashArtifactsMap(normalizedByLevel);
    const indexPath = getArtifactsIndexPath(agentId);
    if (fs.existsSync(indexPath)) {
      try {
        const currentIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (
          Number(currentIndex?.version) === 2 &&
          Number(currentIndex?.chunkSize) === ARTIFACT_CHUNK_SIZE &&
          String(currentIndex?.artifactsHash || '') === artifactsHash
        ) {
          return;
        }
      } catch (_e) {
        // Rewrite index/files if current index is invalid.
      }
    }

    const indexPayload = {
      version: 2,
      chunkSize: ARTIFACT_CHUNK_SIZE,
      generatedAt: new Date().toISOString(),
      artifactsHash,
      artifacts: []
    };
    const expectedFiles = new Set();

    for (const [levelKey, artifacts] of Object.entries(normalizedByLevel)) {
      const level = Number(levelKey);
      if (!Array.isArray(artifacts) || artifacts.length === 0) continue;

      const levelDir = path.join(rootDir, `L${level}`);
      if (!fs.existsSync(levelDir)) {
        fs.mkdirSync(levelDir, { recursive: true });
      }

      const chunksDir = path.join(levelDir, 'chunks');
      if (!fs.existsSync(chunksDir)) {
        fs.mkdirSync(chunksDir, { recursive: true });
      }

      for (let offset = 0; offset < artifacts.length; offset += ARTIFACT_CHUNK_SIZE) {
        const chunk = artifacts.slice(offset, offset + ARTIFACT_CHUNK_SIZE);
        const chunkIndex = Math.floor(offset / ARTIFACT_CHUNK_SIZE) + 1;
        const chunkId = String(chunkIndex).padStart(6, '0');
        const fileName = `${chunkId}.jsonl`;
        const filePath = path.join(chunksDir, fileName);
        const lines = chunk.map((artifact) => JSON.stringify(artifact)).join('\n');
        fs.writeFileSync(filePath, lines ? `${lines}\n` : '', 'utf8');
        expectedFiles.add(filePath);

        chunk.forEach((artifact, itemOffset) => {
          indexPayload.artifacts.push({
            artifactId: artifact.artifactId,
            level: artifact.level,
            startTimestamp: artifact.startTimestamp || null,
            endTimestamp: artifact.endTimestamp || null,
            contextEligible: artifact.contextEligible !== false,
            contentHash: artifact.contentHash,
            path: path.relative(path.dirname(indexPath), filePath),
            chunkId,
            offset: itemOffset
          });
        });
      }
    }

    const existingFiles = walkArtifactFiles(rootDir);
    for (const existingFile of existingFiles) {
      if (!expectedFiles.has(existingFile)) {
        fs.rmSync(existingFile, { force: true });
      }
    }

    cleanupEmptyArtifactDirs(rootDir);

    const tmpIndexPath = `${indexPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpIndexPath, JSON.stringify(indexPayload, null, 2), 'utf8');
    fs.renameSync(tmpIndexPath, indexPath);
  }

  return {
    loadLegacyArtifacts,
    loadLongTermArtifacts,
    writeLongTermArtifacts
  };
}

module.exports = {
  createArtifactRepo
};
