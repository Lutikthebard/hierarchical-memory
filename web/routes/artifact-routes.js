const { toLevelNumber, clampArtifactsToParentRange } = require('../services/artifact-levels');

function flattenArtifactsByRecency(artifactsMap = {}) {
  const all = [];
  for (const [levelKey, artifacts] of Object.entries(artifactsMap)) {
    const level = toLevelNumber(levelKey);
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      all.push({
        ...artifact,
        level: level || Number(artifact.level || 0)
      });
    }
  }
  all.sort((a, b) => new Date(b.endTimestamp || 0).getTime() - new Date(a.endTimestamp || 0).getTime());
  return all;
}

function findArtifactById(storeData, artifactId) {
  if (!artifactId) return null;
  for (const [levelKey, artifacts] of Object.entries(storeData.artifacts || {})) {
    const level = toLevelNumber(levelKey);
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (artifact.artifactId === artifactId) {
        return {
          artifact: {
            ...artifact,
            level: level || Number(artifact.level || 0)
          },
          level: level || Number(artifact.level || 0)
        };
      }
    }
  }
  return null;
}

function drilldownByArtifact(store, res, agentId, artifact, levelNum) {
  if (levelNum === 1) {
    const messages = store.getArchivedMessages(agentId, artifact.startTimestamp, artifact.endTimestamp);
    return res.json({ artifact, messages, source: 'archive' });
  }

  const s = store.loadStore(agentId);
  const sourceLevel = levelNum - 1;
  const sourceLevelArtifacts = (s.artifacts?.[String(sourceLevel)] || s.artifacts?.[sourceLevel] || []);
  const sourceArtifacts = clampArtifactsToParentRange(sourceLevelArtifacts, artifact)
    .map((item) => ({ ...item, level: Number(item.level || sourceLevel) }));
  return res.json({ artifact, sourceArtifacts, source: `L${sourceLevel}` });
}

function registerArtifactRoutes(app, { store, handleArtifactDrilldown }) {
  app.get('/api/agents/:id/artifact/:level/:index/messages', (req, res) => {
    const { id, level, index } = req.params;
    try {
      handleArtifactDrilldown(res, id, level, index);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/artifacts', (req, res) => {
    const { id } = req.params;
    try {
      const s = store.loadStore(id);
      let artifacts = flattenArtifactsByRecency(s.artifacts);

      const levelFilter = req.query.level ? Number(req.query.level) : null;
      const from = req.query.from ? new Date(String(req.query.from)).getTime() : null;
      const to = req.query.to ? new Date(String(req.query.to)).getTime() : null;
      const contextEligible = req.query.contextEligible;
      const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10)));

      if (!Number.isNaN(levelFilter) && levelFilter !== null) {
        artifacts = artifacts.filter((a) => Number(a.level) === levelFilter);
      }
      if (!Number.isNaN(from) && from !== null) {
        artifacts = artifacts.filter((a) => new Date(a.endTimestamp || 0).getTime() >= from);
      }
      if (!Number.isNaN(to) && to !== null) {
        artifacts = artifacts.filter((a) => new Date(a.startTimestamp || 0).getTime() <= to);
      }
      if (contextEligible === 'true') {
        artifacts = artifacts.filter((a) => a.contextEligible !== false);
      }
      if (contextEligible === 'false') {
        artifacts = artifacts.filter((a) => a.contextEligible === false);
      }

      res.json({
        count: artifacts.length,
        artifacts: artifacts.slice(0, limit)
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/artifacts/search', (req, res) => {
    const { id } = req.params;
    const query = String(req.query.q || '').trim().toLowerCase();
    try {
      const s = store.loadStore(id);
      const all = flattenArtifactsByRecency(s.artifacts);
      const levelFilter = req.query.level ? Number(req.query.level) : null;
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10)));

      let artifacts = all;
      if (!Number.isNaN(levelFilter) && levelFilter !== null) {
        artifacts = artifacts.filter((a) => Number(a.level) === levelFilter);
      }
      if (query) {
        artifacts = artifacts.filter((a) => String(a.content || '').toLowerCase().includes(query));
      }

      const results = artifacts.slice(0, limit).map((artifact) => ({
        artifactId: artifact.artifactId,
        level: artifact.level,
        startTimestamp: artifact.startTimestamp,
        endTimestamp: artifact.endTimestamp,
        contextEligible: artifact.contextEligible !== false,
        snippet: String(artifact.content || '').slice(0, 280)
      }));

      res.json({
        query,
        count: artifacts.length,
        results
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/agents/:id/artifacts/:artifactId/drilldown', (req, res) => {
    const { id, artifactId } = req.params;
    try {
      const s = store.loadStore(id);
      const found = findArtifactById(s, artifactId);
      if (!found) {
        return res.status(404).json({ error: 'Artifact not found' });
      }
      return drilldownByArtifact(store, res, id, found.artifact, found.level);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerArtifactRoutes
};
