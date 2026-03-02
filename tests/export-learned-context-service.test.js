const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createExportLearnedContextService } = require('../scripts/export-learned-context-service');

describe('export-learned-context service', () => {
  it('exports filtered artifact tree to markdown with archived L0 messages', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-export-context-'));
    const agentId = 'export-agent';
    const dataDir = path.join(tmpRoot, 'data');

    const artifacts = {
      1: [
        {
          artifactId: 'l1-1',
          content: 'L1 summary 1',
          startTimestamp: '2026-02-10T10:00:00.000Z',
          endTimestamp: '2026-02-10T10:10:00.000Z'
        },
        {
          artifactId: 'l1-2',
          content: 'L1 summary 2',
          startTimestamp: '2026-02-10T10:10:00.000Z',
          endTimestamp: '2026-02-10T10:20:00.000Z'
        }
      ],
      2: [
        {
          artifactId: 'l2-1',
          content: 'L2 summary',
          startTimestamp: '2026-02-10T10:00:00.000Z',
          endTimestamp: '2026-02-10T10:20:00.000Z'
        }
      ],
      3: [
        {
          artifactId: 'l3-1',
          content: 'L3 summary',
          startTimestamp: '2026-02-10T10:00:00.000Z',
          endTimestamp: '2026-02-10T10:20:00.000Z'
        }
      ]
    };

    const storeData = {
      artifacts,
      messages: [
        {
          timestamp: '2026-02-10T10:05:00.000Z',
          role: 'user',
          content: 'active-msg'
        }
      ]
    };

    const svc = createExportLearnedContextService({
      loadStore: () => storeData,
      getArchivedMessages: () => [
        {
          timestamp: '2026-02-10T10:06:00.000Z',
          role: 'assistant',
          content: 'archived-msg'
        }
      ],
      getDataDir: () => dataDir
    });

    const run = await svc.runExportLearnedContext({
      agentId,
      fromLevel: 1,
      toLevel: 3,
      dateFrom: '2026-02-10T09:59:00.000Z',
      dateTo: '2026-02-10T10:21:00.000Z',
      includeArchivedMessages: true
    });

    assert.equal(run.filters.fromLevel, 1);
    assert.equal(run.filters.toLevel, 3);
    assert.equal(run.stats.rootArtifacts, 1);
    assert.equal(run.tree.roots.length, 1);
    assert.equal(run.tree.roots[0].artifactId, 'l3-1');
    assert.equal(run.tree.roots[0].children.length, 1);
    assert.equal(run.tree.roots[0].children[0].artifactId, 'l2-1');
    assert.equal(run.tree.roots[0].children[0].children.length, 2);
    assert.equal(run.tree.roots[0].children[0].children[0].artifactId, 'l1-1');
    assert.equal(run.tree.roots[0].children[0].children[0].children.length, 2);

    const exported = fs.readFileSync(run.file.path, 'utf8');
    assert.match(exported, /Learned Context Export/);
    assert.match(exported, /L3 artifact/);
    assert.match(exported, /\[ARCHIVED\]/);
    assert.match(exported, /archived-msg/);
    assert.match(exported, /active-msg/);
  });

  it('validates level range', async () => {
    const svc = createExportLearnedContextService({
      loadStore: () => ({
        artifacts: {
          1: [
            {
              artifactId: 'l1-1',
              content: 'L1 summary',
              startTimestamp: '2026-02-10T10:00:00.000Z',
              endTimestamp: '2026-02-10T10:10:00.000Z'
            }
          ]
        },
        messages: []
      }),
      getDataDir: () => os.tmpdir()
    });

    await assert.rejects(
      () => svc.runExportLearnedContext({
        agentId: 'agent',
        fromLevel: 3,
        toLevel: 2
      }),
      /Invalid level range/
    );
  });
});
