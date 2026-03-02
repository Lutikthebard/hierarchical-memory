function validateAgentConfig(config, messageClasses) {
  if (config.thresholds && typeof config.thresholds !== 'object') {
    return 'thresholds must be an object';
  }
  if (config.prompts && typeof config.prompts !== 'object') {
    return 'prompts must be an object';
  }
  if (config.filters && typeof config.filters !== 'object') {
    return 'filters must be an object';
  }
  if (config.autoInjectContext && typeof config.autoInjectContext !== 'object') {
    return 'autoInjectContext must be an object';
  }
  if (config.autoCompact && typeof config.autoCompact !== 'object') {
    return 'autoCompact must be an object';
  }
  if (config.learnContext && typeof config.learnContext !== 'object') {
    return 'learnContext must be an object';
  }
  if (
    config.autoCompact &&
    Object.prototype.hasOwnProperty.call(config.autoCompact, 'postCompactMessage') &&
    typeof config.autoCompact.postCompactMessage !== 'string'
  ) {
    return 'autoCompact.postCompactMessage must be a string';
  }

  if (config.autoInjectContext) {
    const stringFields = ['preText', 'postText'];
    for (const field of stringFields) {
      if (
        Object.prototype.hasOwnProperty.call(config.autoInjectContext, field) &&
        typeof config.autoInjectContext[field] !== 'string'
      ) {
        return `autoInjectContext.${field} must be a string`;
      }
    }

    const arrayFields = ['preMdFiles', 'postMdFiles'];
    for (const field of arrayFields) {
      if (!Object.prototype.hasOwnProperty.call(config.autoInjectContext, field)) {
        continue;
      }
      if (!Array.isArray(config.autoInjectContext[field])) {
        return `autoInjectContext.${field} must be an array`;
      }
      const invalidValue = config.autoInjectContext[field].find((v) => typeof v !== 'string');
      if (typeof invalidValue !== 'undefined') {
        return `autoInjectContext.${field} must contain only strings`;
      }
    }
  }

  if (config.filters) {
    const filterArrayFields = [
      'exclude',
      'excludePatterns',
      'countRoles',
      'storeRoles',
      'storeMessageClasses',
      'countMessageClasses',
      'contextMessageClasses',
      'commandAllowlist'
    ];
    for (const field of filterArrayFields) {
      if (Object.prototype.hasOwnProperty.call(config.filters, field) && !Array.isArray(config.filters[field])) {
        return `filters.${field} must be an array`;
      }
    }

    const classFields = ['storeMessageClasses', 'countMessageClasses', 'contextMessageClasses'];
    for (const field of classFields) {
      const classes = config.filters[field];
      if (!classes) continue;
      const invalid = classes.filter((name) => !messageClasses.includes(String(name)));
      if (invalid.length > 0) {
        return `filters.${field} has invalid classes: ${invalid.join(', ')}`;
      }
    }
  }

  if (config.learnContext) {
    const stringFields = ['learningIntent', 'l1ArtifactPrompt', 'aggregatePrompt'];
    for (const field of stringFields) {
      if (
        Object.prototype.hasOwnProperty.call(config.learnContext, field) &&
        typeof config.learnContext[field] !== 'string'
      ) {
        return `learnContext.${field} must be a string`;
      }
    }

    const nullableNumberFields = ['fromBlock', 'toBlock', 'maxTargetLevel', 'aggregateBatch'];
    for (const field of nullableNumberFields) {
      if (!Object.prototype.hasOwnProperty.call(config.learnContext, field)) continue;
      const value = config.learnContext[field];
      if (value === null || typeof value === 'undefined' || value === '') continue;
      if (!Number.isFinite(Number(value))) {
        return `learnContext.${field} must be a number or null`;
      }
    }

    const numberFields = ['wordsPerBlock'];
    for (const field of numberFields) {
      if (!Object.prototype.hasOwnProperty.call(config.learnContext, field)) continue;
      if (!Number.isFinite(Number(config.learnContext[field]))) {
        return `learnContext.${field} must be a number`;
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(config.learnContext, 'runFullSummarize') &&
      typeof config.learnContext.runFullSummarize !== 'boolean'
    ) {
      return 'learnContext.runFullSummarize must be a boolean';
    }

    if (
      Object.prototype.hasOwnProperty.call(config.learnContext, 'thresholds') &&
      (typeof config.learnContext.thresholds !== 'object' || Array.isArray(config.learnContext.thresholds))
    ) {
      return 'learnContext.thresholds must be an object';
    }

    if (
      Object.prototype.hasOwnProperty.call(config.learnContext, 'aggregatePromptsByLevel') &&
      (typeof config.learnContext.aggregatePromptsByLevel !== 'object' || Array.isArray(config.learnContext.aggregatePromptsByLevel))
    ) {
      return 'learnContext.aggregatePromptsByLevel must be an object';
    }
  }

  return null;
}

module.exports = {
  validateAgentConfig
};
