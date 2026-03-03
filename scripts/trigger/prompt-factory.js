const { formatTimestamp } = require('../store');

function getArtifactTagName(level) {
  const normalizedLevel = Number(level);
  if (!Number.isInteger(normalizedLevel) || normalizedLevel < 1) {
    throw new Error(`Invalid artifact level: ${level}`);
  }
  return `memory_artifact_L${normalizedLevel}`;
}

function createL1Prompt(messages, agentConfig = null, options = {}) {
  const startTs = messages[0].timestamp;
  const endTs = messages[messages.length - 1].timestamp;
  const startFormatted = formatTimestamp(startTs);
  const endFormatted = formatTimestamp(endTs);

  const customPrompt = String(options.promptOverride || '').trim() || agentConfig?.prompts?.l1 || '';
  const promptInstructions = customPrompt
    || 'Summarize messages into a concise memory artifact. Focus on: decisions made, problems solved, key insights, action items. Use markdown headers for structure. Be concise but complete.';

  const artifactTag = getArtifactTagName(1);

  return `🧠 MEMORY TASK: This is a system message.

Summarize ${messages.length} messages from: ${startFormatted} → ${endFormatted}.

${promptInstructions}

Your answer to this message will be stored as a summary.

Wrap your entire response in <${artifactTag}>...</${artifactTag}> tags.
  Reply with ONLY the summary inside the tags.
  Add NO_REPLY at the end of the message.`;
}

function createAggregationPrompt(artifacts, sourceLevel, targetLevel, agentConfig = null, options = {}) {
  const startFormatted = formatTimestamp(artifacts[0].startTimestamp);
  const endFormatted = formatTimestamp(artifacts[artifacts.length - 1].endTimestamp);

  const artifactsText = artifacts.map((artifact, index) => `[${index + 1}] ${artifact.content}`).join('\n\n');

  let customPrompt = String(options.promptOverride || '').trim() || agentConfig?.prompts?.aggregate || '';
  customPrompt = customPrompt.replace('{level}', sourceLevel);
  const promptInstructions = customPrompt
    || `Create a concise higher-level memory artifact from L${sourceLevel} summaries. Focus on: recurring themes, major decisions, unresolved issues, durable insights. Use markdown headers for structure. Be concise but complete.`;

  const artifactTag = getArtifactTagName(targetLevel);

  return `🧠 MEMORY TASK: This is a system message.

Aggregate ${artifacts.length} L${sourceLevel} summaries into L${targetLevel} for: ${startFormatted} → ${endFormatted}.

${artifactsText}

${promptInstructions}

Your answer to this message will be stored as a summary.

Wrap your entire response in <${artifactTag}>...</${artifactTag}> tags.
  Reply with ONLY the summary inside the tags.
  Add NO_REPLY at the end of the message.`;
}

function createRetryPrompt(_errorMessage, _previousResponse, originalPrompt) {
  return `${originalPrompt}

(Previous attempt was empty or invalid. Please provide a clear summary.)`;
}

function parseAgentResponse(text, expectedLevel) {
  if (!text || text.trim().length === 0) {
    throw new Error('Empty response');
  }

  const artifactTag = getArtifactTagName(expectedLevel);
  const pattern = new RegExp(`<${artifactTag}>([\\s\\S]*?)<\\/${artifactTag}>`);
  const match = text.match(pattern);
  if (match) {
    return match[1].trim();
  }

  throw new Error(`Missing required artifact tag <${artifactTag}>...</${artifactTag}>`);
}

module.exports = {
  getArtifactTagName,
  createL1Prompt,
  createAggregationPrompt,
  createRetryPrompt,
  parseAgentResponse
};
