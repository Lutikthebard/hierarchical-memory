(function attachHmAppHelpers(globalObj) {
  const defaultClassFilters = {
    storeMessageClasses: ['dialogue', 'inter_agent'],
    countMessageClasses: ['dialogue'],
    contextMessageClasses: ['dialogue', 'inter_agent'],
    commandAllowlist: []
  };

  function normalizeClassFilterArrays(filters = {}) {
    const out = { ...defaultClassFilters };
    for (const key of Object.keys(defaultClassFilters)) {
      if (Array.isArray(filters[key])) {
        out[key] = filters[key].map((x) => String(x || '').trim()).filter(Boolean);
      }
    }
    return out;
  }

  function parseTextareaList(value) {
    return String(value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function formatTextareaList(values) {
    if (!Array.isArray(values)) return '';
    return values.map((v) => String(v || '').trim()).filter(Boolean).join('\n');
  }

  function parseKeyValueMap(text) {
    const out = {};
    const lines = String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key || !value) continue;
      out[key] = value;
    }
    return out;
  }

  function formatKeyValueMap(map) {
    if (!map || typeof map !== 'object') return '';
    return Object.entries(map)
      .filter(([, value]) => String(value || '').trim())
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
  }

  function extractTitle(content) {
    if (!content) return 'Untitled';
    const match = content.match(/^##\s*(.+)$/m);
    if (match) return match[1].trim();
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed.substring(0, 80);
      }
    }
    return 'Untitled';
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toISOString().substring(0, 16).replace('T', ' ');
  }

  function levelNumberFromKey(levelKey) {
    const raw = String(levelKey || '').trim();
    if (!raw) return null;
    const match = raw.match(/^L(\d+)$/i);
    if (match) {
      return Number(match[1]);
    }
    const direct = Number(raw);
    if (!Number.isFinite(direct)) return null;
    return direct > 0 ? Math.floor(direct) : null;
  }

  function sortLevelKeys(keys = []) {
    return [...keys]
      .map((key) => String(key || '').trim())
      .filter((key) => /^L\d+$/i.test(key))
      .sort((a, b) => levelNumberFromKey(a) - levelNumberFromKey(b));
  }

  function normalizeArtifactMap(map, ensure = [1, 2, 3]) {
    const normalized = {};
    if (map && typeof map === 'object') {
      for (const [key, value] of Object.entries(map)) {
        const level = levelNumberFromKey(key);
        if (!level) continue;
        normalized[`L${level}`] = Array.isArray(value) ? value : [];
      }
    }
    for (const level of ensure) {
      const parsed = levelNumberFromKey(level);
      if (!parsed) continue;
      const key = `L${parsed}`;
      if (!normalized[key]) normalized[key] = [];
    }
    const ordered = {};
    for (const key of sortLevelKeys(Object.keys(normalized))) {
      ordered[key] = normalized[key];
    }
    return ordered;
  }

  function normalizeArtifactCounts(map, ensure = [1, 2, 3]) {
    const normalized = {};
    if (map && typeof map === 'object') {
      for (const [key, value] of Object.entries(map)) {
        const level = levelNumberFromKey(key);
        if (!level) continue;
        const numeric = Number(value);
        normalized[`L${level}`] = Number.isFinite(numeric) ? numeric : 0;
      }
    }
    for (const level of ensure) {
      const parsed = levelNumberFromKey(level);
      if (!parsed) continue;
      const key = `L${parsed}`;
      if (!Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = 0;
    }
    const ordered = {};
    for (const key of sortLevelKeys(Object.keys(normalized))) {
      ordered[key] = normalized[key];
    }
    return ordered;
  }

  globalObj.HmAppHelpers = {
    defaultClassFilters,
    normalizeClassFilterArrays,
    parseTextareaList,
    formatTextareaList,
    parseKeyValueMap,
    formatKeyValueMap,
    extractTitle,
    formatTime,
    levelNumberFromKey,
    sortLevelKeys,
    normalizeArtifactMap,
    normalizeArtifactCounts
  };
}(window));
