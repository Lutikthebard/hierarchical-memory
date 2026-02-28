const fs = require('fs');
const path = require('path');

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
    if (!fs.existsSync(rootDir)) {
      return {};
    }

    const result = {};
    const levelDirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^L\d+$/.test(entry.name))
      .map((entry) => entry.name);

    for (const levelDirName of levelDirs) {
      const level = Number(levelDirName.slice(1));
      const levelDir = path.join(rootDir, levelDirName);
      const files = fs.readdirSync(levelDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name);
      for (const file of files) {
        const filePath = path.join(levelDir, file);
        try {
          const data = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(data);
          if (!result[level]) {
            result[level] = [];
          }
          result[level].push(parsed);
        } catch (_e) {
          // skip invalid artifact payload
        }
      }
    }

    return result;
  }

  function writeLongTermArtifacts(agentId, artifactsMap) {
    const rootDir = getArtifactsRootDir(agentId);
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }

    const indexPayload = {
      generatedAt: new Date().toISOString(),
      artifacts: []
    };
    const expectedFiles = new Set();
    const expectedLevelDirs = new Set();

    for (const [levelKey, artifacts] of Object.entries(artifactsMap || {})) {
      const level = Number(levelKey);
      if (!Array.isArray(artifacts) || artifacts.length === 0) continue;

      const levelDir = path.join(rootDir, `L${level}`);
      expectedLevelDirs.add(levelDir);
      if (!fs.existsSync(levelDir)) {
        fs.mkdirSync(levelDir, { recursive: true });
      }

      for (const artifact of artifacts) {
        const normalized = normalizeArtifact(level, artifact);
        if (!normalized) continue;
        const fileName = `${normalized.artifactId}.json`;
        const filePath = path.join(levelDir, fileName);
        expectedFiles.add(filePath);
        fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
        indexPayload.artifacts.push({
          artifactId: normalized.artifactId,
          level: normalized.level,
          startTimestamp: normalized.startTimestamp || null,
          endTimestamp: normalized.endTimestamp || null,
          contextEligible: normalized.contextEligible !== false,
          contentHash: normalized.contentHash,
          path: path.relative(path.dirname(getArtifactsIndexPath(agentId)), filePath)
        });
      }
    }

    const existingLevelDirs = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^L\d+$/.test(entry.name))
      .map((entry) => path.join(rootDir, entry.name));

    for (const levelDir of existingLevelDirs) {
      const existingFiles = fs.readdirSync(levelDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(levelDir, entry.name));
      for (const existingFile of existingFiles) {
        if (!expectedFiles.has(existingFile)) {
          fs.rmSync(existingFile, { force: true });
        }
      }
      const remaining = fs.readdirSync(levelDir).filter((name) => name.endsWith('.json'));
      if (remaining.length === 0 && !expectedLevelDirs.has(levelDir)) {
        fs.rmSync(levelDir, { recursive: true, force: true });
      }
    }

    fs.writeFileSync(getArtifactsIndexPath(agentId), JSON.stringify(indexPayload, null, 2), 'utf8');
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
