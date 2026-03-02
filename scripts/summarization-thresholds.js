function toPositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function resolveThresholdForLevel(agentConfig, level, fallback) {
  const fallbackInt = toPositiveInt(fallback) || 1;
  const thresholds = agentConfig?.thresholds || {};

  const explicitLevel = toPositiveInt(thresholds[`L${level}`]);
  if (explicitLevel) return explicitLevel;

  if (level === 1) {
    const l1 = toPositiveInt(thresholds.L1);
    if (l1) return l1;
  }

  const defaultThreshold = toPositiveInt(thresholds.default);
  if (defaultThreshold) return defaultThreshold;

  return fallbackInt;
}

module.exports = {
  toPositiveInt,
  resolveThresholdForLevel
};
