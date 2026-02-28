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

  return null;
}

module.exports = {
  validateAgentConfig
};
