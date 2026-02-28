const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  buildAttemptsDistribution,
  collectSummarizationTelemetry,
  resetPreRunAgentState
} = require('../scripts/dev/real-e2e');

describe('real-e2e telemetry helpers', () => {
  it('builds attempts distribution from processed events', () => {
    const dist = buildAttemptsDistribution([
      { attemptsBeforeProcessed: 1 },
      { attemptsBeforeProcessed: 2 },
      { attemptsBeforeProcessed: 2 },
      { attemptsBeforeProcessed: 3 },
      { attemptsBeforeProcessed: 'x' }
    ]);
    assert.deepStrictEqual(dist, { '1': 1, '2': 2, '3': 1 });
  });

  it('collects summarization telemetry aggregates from jsonl log', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-real-e2e-telemetry-'));
    const agentId = 'telemetry-agent';
    const agentDir = path.join(tmp, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    const telemetryPath = path.join(agentDir, 'summarization-events.jsonl');

    const events = [
      { eventType: 'memory_task_sent', sourceLevel: 0, targetLevel: 1, attempt: 1 },
      { eventType: 'memory_task_sent', sourceLevel: 0, targetLevel: 1, attempt: 2 },
      { eventType: 'artifact_processed', sourceLevel: 0, targetLevel: 1, attemptsBeforeProcessed: 2 },
      { eventType: 'memory_task_sent', sourceLevel: 1, targetLevel: 2, attempt: 1 },
      { eventType: 'artifact_failed', sourceLevel: 1, targetLevel: 2, attemptsSent: 3 }
    ];
    fs.writeFileSync(
      telemetryPath,
      events.map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join('\n') + '\n',
      'utf8'
    );

    const summary = collectSummarizationTelemetry(tmp, agentId);
    assert.equal(summary.memoryTaskRequestsTotal, 3);
    assert.equal(summary.artifactsProcessedTotal, 1);
    assert.equal(summary.artifactsFailedTotal, 1);
    assert.deepStrictEqual(summary.attemptsDistribution, { '2': 1 });
    assert.equal(summary.transitions['L0->L1'].requests, 2);
    assert.equal(summary.transitions['L0->L1'].processed, 1);
    assert.equal(summary.transitions['L1->L2'].failed, 1);
  });

  it('parses new drive flags', () => {
    const parsed = parseArgs([
      'node',
      'scripts/dev/real-e2e.js',
      '--turns-per-wave',
      '6',
      '--max-drive-turns',
      '48'
    ]);
    assert.equal(parsed.turnsPerWave, 6);
    assert.equal(parsed.maxDriveTurns, 48);
  });

  it('resets only test-agent run data and session jsonl files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-real-e2e-reset-'));
    const runRoot = path.join(tmp, 'tmp', 'real-e2e', 'run-a');
    const agentsRoot = path.join(tmp, '.openclaw', 'agents');
    const targetAgent = 'hm-real-e2e-agent';
    const otherAgent = 'other-agent';

    const targetSessions = path.join(agentsRoot, targetAgent, 'sessions');
    const otherSessions = path.join(agentsRoot, otherAgent, 'sessions');
    fs.mkdirSync(targetSessions, { recursive: true });
    fs.mkdirSync(otherSessions, { recursive: true });
    fs.mkdirSync(path.join(runRoot, 'data', targetAgent), { recursive: true });

    fs.writeFileSync(path.join(runRoot, 'data', targetAgent, 'store.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(targetSessions, 'session-1.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(targetSessions, 'session-2.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(targetSessions, 'keep.txt'), 'keep', 'utf8');
    fs.writeFileSync(path.join(otherSessions, 'other.jsonl'), '{}\n', 'utf8');

    const result = resetPreRunAgentState({
      runRoot,
      agentsRoot,
      agentId: targetAgent
    });

    assert.equal(result.runRootCleared, true);
    assert.equal(result.sessionJsonlRemoved, 2);
    assert.equal(fs.existsSync(runRoot), false);
    assert.equal(fs.existsSync(path.join(targetSessions, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(otherSessions, 'other.jsonl')), true);
  });
});
