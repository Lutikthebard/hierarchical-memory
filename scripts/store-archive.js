const fs = require('fs');
const path = require('path');

function createArchiveApi({ getDataDir, compareTimestamps }) {
  function getMessagesDir(agentId) {
    const dataDir = getDataDir();
    const messagesDir = path.join(dataDir, agentId, 'messages');
    if (!fs.existsSync(messagesDir)) {
      fs.mkdirSync(messagesDir, { recursive: true });
    }
    return messagesDir;
  }

  function getDateFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toISOString().split('T')[0];
  }

  function archiveMessages(agentId, messages) {
    if (!messages || messages.length === 0) return;

    const messagesDir = getMessagesDir(agentId);
    const byDate = {};
    for (const msg of messages) {
      const date = getDateFromTimestamp(msg.timestamp);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(msg);
    }

    for (const [date, msgs] of Object.entries(byDate)) {
      const filePath = path.join(messagesDir, `${date}.jsonl`);
      const lines = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
      fs.appendFileSync(filePath, lines, 'utf8');
    }

    return Object.keys(byDate).length;
  }

  function readAllArchivedMessages(agentId) {
    const messagesDir = getMessagesDir(agentId);
    if (!fs.existsSync(messagesDir)) {
      return [];
    }

    const files = fs.readdirSync(messagesDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort();

    const messages = [];
    for (const file of files) {
      const filePath = path.join(messagesDir, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim());
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line));
        } catch (err) {
          throw new Error(`Invalid JSONL in ${filePath}: ${err.message}`);
        }
      }
    }

    messages.sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));
    return messages;
  }

  function mergeAndSortMessages(messages) {
    const byTimestamp = new Map();
    for (const msg of messages || []) {
      if (!msg || !msg.timestamp) continue;
      byTimestamp.set(msg.timestamp, msg);
    }
    return Array.from(byTimestamp.values())
      .sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));
  }

  function rewriteArchivedMessages(agentId, messages) {
    const messagesDir = getMessagesDir(agentId);
    fs.rmSync(messagesDir, { recursive: true, force: true });
    fs.mkdirSync(messagesDir, { recursive: true });

    const sorted = mergeAndSortMessages(messages);
    const byDate = new Map();
    for (const msg of sorted) {
      const date = getDateFromTimestamp(msg.timestamp);
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date).push(msg);
    }

    for (const [date, dateMessages] of byDate.entries()) {
      const filePath = path.join(messagesDir, `${date}.jsonl`);
      const lines = dateMessages.map((m) => JSON.stringify(m)).join('\n');
      fs.writeFileSync(filePath, `${lines}\n`, 'utf8');
    }
  }

  function getArchivedMessages(agentId, startTimestamp, endTimestamp) {
    const messagesDir = getMessagesDir(agentId);
    const startDate = getDateFromTimestamp(startTimestamp);
    const endDate = getDateFromTimestamp(endTimestamp);

    const dates = [];
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    const messages = [];
    for (const date of dates) {
      const filePath = path.join(messagesDir, `${date}.jsonl`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n').filter((l) => l);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (compareTimestamps(msg.timestamp, startTimestamp) >= 0 &&
                compareTimestamps(msg.timestamp, endTimestamp) <= 0) {
              messages.push(msg);
            }
          } catch (_e) {}
        }
      }
    }

    messages.sort((a, b) => compareTimestamps(a.timestamp, b.timestamp));
    return messages;
  }

  return {
    getMessagesDir,
    getDateFromTimestamp,
    archiveMessages,
    readAllArchivedMessages,
    mergeAndSortMessages,
    rewriteArchivedMessages,
    getArchivedMessages
  };
}

module.exports = {
  createArchiveApi
};
