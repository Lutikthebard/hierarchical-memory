/**
 * Encapsulates auto-compact state machine for watcher runtime.
 */
class CompactController {
  constructor() {
    this.sessionMessageCount = 0;
    this.awaitingCompaction = false;
    this.lastCompactCommandTime = 0;
    this.compactRetryCount = 0;
    this.lastRetryLogTime = 0;
  }

  getState() {
    return {
      sessionMessageCount: this.sessionMessageCount,
      awaitingCompaction: this.awaitingCompaction,
      compactRetryCount: this.compactRetryCount
    };
  }

  markMessageProcessed(shouldCount) {
    if (shouldCount) {
      this.sessionMessageCount += 1;
    }
  }

  resetAfterCompaction() {
    this.sessionMessageCount = 0;
    this.awaitingCompaction = false;
    this.compactRetryCount = 0;
    this.lastRetryLogTime = 0;
  }

  resetCounterOnly() {
    this.sessionMessageCount = 0;
  }

  async sendCompactCommand(agentId, postMessage, sendFn) {
    const now = Date.now();
    const minDelayMs = 5000;

    if (now - this.lastCompactCommandTime < minDelayMs) {
      return false;
    }

    this.lastCompactCommandTime = now;
    const message = postMessage ? `/compact ${postMessage}` : '/compact';
    return sendFn(agentId, message);
  }

  async maybeTriggerOrRetry({ agentId, msg, autoCompact, postMessage, sendFn, log }) {
    if (!autoCompact?.enabled) return;

    const threshold = autoCompact.messageThreshold || 150;
    const thresholdReached = this.sessionMessageCount >= threshold;

    if (thresholdReached && !this.awaitingCompaction) {
      log(`\n🗜️  AutoCompact threshold reached: ${this.sessionMessageCount}/${threshold}`);
      this.awaitingCompaction = true;
      this.compactRetryCount = 0;
      this.lastRetryLogTime = Date.now();
      await this.sendCompactCommand(agentId, postMessage, sendFn);
      return;
    }

    if (this.awaitingCompaction && msg.role === 'assistant' && msg.shouldCount) {
      const sent = await this.sendCompactCommand(agentId, postMessage, sendFn);
      if (!sent) return;

      this.compactRetryCount += 1;
      const now = Date.now();
      if (now - this.lastRetryLogTime > 30000) {
        log(`   🔁 ${this.compactRetryCount} compact retries sent`);
        this.lastRetryLogTime = now;
      }
    }
  }
}

module.exports = {
  CompactController
};
