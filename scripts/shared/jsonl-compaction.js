const fs = require('fs');

function readJsonlLines(jsonlPath) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return [];
  const content = fs.readFileSync(jsonlPath, 'utf8');
  return content.split('\n').filter((line) => line.trim());
}

function countJsonlLines(jsonlPath) {
  return readJsonlLines(jsonlPath).length;
}

function hasCompactionAfterLine(jsonlPath, startLine) {
  const lines = readJsonlLines(jsonlPath).slice(startLine);
  for (const line of lines) {
    try {
      const data = JSON.parse(line);
      if (data.type === 'compaction') return true;
    } catch (_e) {}
  }
  return false;
}

async function waitForCompaction(jsonlPath, startLine, timeoutMs = 45000, pollMs = 1000) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return { detected: false, fallbackDelay: true };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasCompactionAfterLine(jsonlPath, startLine)) {
      return { detected: true, fallbackDelay: false };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { detected: false, fallbackDelay: false };
}

module.exports = {
  readJsonlLines,
  countJsonlLines,
  hasCompactionAfterLine,
  waitForCompaction
};
