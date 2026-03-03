const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../store');

function safePreview(text, maxLen = 240) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function getTelemetryPath(agentId) {
  return path.join(getDataDir(), agentId, 'summarization-events.jsonl');
}

function logTelemetry(agentId, payload) {
  const telemetryPath = getTelemetryPath(agentId);
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ...payload
  });
  fs.appendFileSync(telemetryPath, `${line}\n`, 'utf8');
}

module.exports = {
  safePreview,
  getTelemetryPath,
  logTelemetry
};
