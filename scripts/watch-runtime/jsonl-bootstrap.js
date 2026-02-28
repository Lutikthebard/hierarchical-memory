function createProcessExistingFile({
  fs,
  compactController,
  processLine,
  saveStore
}) {
  return async function processExistingFile(agentId, storeRef, jsonlPath) {
    if (!fs.existsSync(jsonlPath)) {
      console.log(`File not found: ${jsonlPath}`);
      return 0;
    }

    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());

    let lastCompactionIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        if (data.type === 'compaction') {
          lastCompactionIndex = i;
          console.log(`   Found compaction at line ${i + 1}, counting messages after it`);
          compactController.resetCounterOnly();
          break;
        }
      } catch (_e) {}
    }

    const startIndex = lastCompactionIndex >= 0 ? lastCompactionIndex + 1 : 0;
    let count = 0;
    for (let i = startIndex; i < lines.length; i++) {
      if (await processLine(agentId, storeRef, lines[i], { verbose: false, skipThresholdCheck: true })) {
        count++;
      }
    }

    saveStore(agentId, storeRef.current);
    return count;
  };
}

module.exports = {
  createProcessExistingFile
};
