const fs = require('fs');
const { parseMessage } = require('./message-parser');

/**
 * Count countable messages in session JSONL after last compaction event.
 * Uses the same parse/filter logic as watcher runtime (parseMessage.shouldCount).
 */
function countSessionMessagesFromJsonl(jsonlPath, agentConfig = null) {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return 0;

  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());

    let lastCompactionIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        if (data.type === 'compaction') {
          lastCompactionIndex = i;
          break;
        }
      } catch (_e) {}
    }

    const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
    let count = 0;

    for (let i = startIndex; i < lines.length; i++) {
      const msg = parseMessage(lines[i], agentConfig);
      if (msg?.shouldCount) {
        count += 1;
      }
    }

    return count;
  } catch (_e) {
    return 0;
  }
}

module.exports = {
  countSessionMessagesFromJsonl
};

