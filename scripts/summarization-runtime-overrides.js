const { toPositiveInt } = require('./summarization-thresholds');

function normalizeThresholdOverrides(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw)) {
    const parsed = toPositiveInt(value);
    if (!parsed) continue;

    const trimmed = String(key || '').trim();
    if (!trimmed) continue;
    if (/^L\d+$/i.test(trimmed)) {
      out[`L${Math.floor(Number(trimmed.slice(1)))}`] = parsed;
      continue;
    }
    if (trimmed === 'L1' || trimmed === 'default') {
      out[trimmed] = parsed;
    }
  }

  return out;
}

function normalizePromptMap(raw = {}) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw)) {
    const level = toPositiveInt(key);
    const prompt = String(value || '').trim();
    if (!level || !prompt) continue;
    out[String(level)] = prompt;
  }
  return out;
}

function mergeAgentConfigWithRuntime(baseConfig = {}, runtime = {}) {
  const merged = {
    ...baseConfig,
    thresholds: {
      ...(baseConfig.thresholds || {})
    },
    prompts: {
      ...(baseConfig.prompts || {})
    }
  };

  if (runtime && typeof runtime === 'object') {
    const thresholdOverrides = normalizeThresholdOverrides(runtime.thresholds || {});
    merged.thresholds = {
      ...merged.thresholds,
      ...thresholdOverrides
    };

    if (runtime.prompts && typeof runtime.prompts === 'object') {
      for (const key of ['l1', 'aggregate']) {
        if (typeof runtime.prompts[key] === 'string' && runtime.prompts[key].trim()) {
          merged.prompts[key] = runtime.prompts[key].trim();
        }
      }
      if (runtime.prompts.aggregateBySourceLevel && typeof runtime.prompts.aggregateBySourceLevel === 'object') {
        merged.prompts.aggregateBySourceLevel = {
          ...(baseConfig.prompts?.aggregateBySourceLevel || {}),
          ...normalizePromptMap(runtime.prompts.aggregateBySourceLevel)
        };
      }
    }
  }

  return merged;
}

function composeLearnL1Prompt(basePrompt, learningIntent, extraPrompt) {
  const parts = [];
  const base = String(basePrompt || '').trim();
  const intent = String(learningIntent || '').trim();
  const extra = String(extraPrompt || '').trim();

  if (base) parts.push(base);
  if (intent) {
    parts.push(`Learning intent:\n${intent}`);
  }
  if (extra) {
    parts.push(`Additional instructions for first-level artifacts:\n${extra}`);
  }

  return parts.filter(Boolean).join('\n\n');
}

module.exports = {
  normalizeThresholdOverrides,
  normalizePromptMap,
  mergeAgentConfigWithRuntime,
  composeLearnL1Prompt
};
