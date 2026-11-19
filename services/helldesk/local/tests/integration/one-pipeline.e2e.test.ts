import { describe, expect, it } from 'bun:test';
import { makeGitFixture, makeTestDb } from '../helpers';
import { Engine } from '../../src/engine';
import { createFakeRunner } from '../../src/inference';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Task gate: committed, uncommitted, and completion-triggered jobs all reach
 * the SAME production review pipeline (the single `review_jobs` table
 * + engine -> report path), not divergent hand-rolled paths.
 */
describe('one production review pipeline for all subject kinds', () => {
  it('git-head (committed), git-dirty (uncommitted), and an auto job all produce review_jobs rows through one engine', { timeout: 30_000 }, async () => {
    const g = makeGitFixture();
    // make a dirty tree
    writeFileSync(join(g.dir, 'tracked.js'), 'export const dirty = true;\n');
    const h = makeTestDb({ runner: 'fake' });
    const engine = new Engine({
      d: h.d,
      config: h.cfg,
      snapshotStore: h.snapshotStore,
      reportDir: h.reportDir,
      runner: createFakeRunner(),
      resolvedModels: new Map([['inherited', { providerID: 'p', modelID: 'm' }]]),
    });
    engine.onStartup();

    const committed = (await engine.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'auto' })).jobId;
    const dirty = (await engine.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-dirty', includeDirty: true, includeUntracked: true, source: 'auto' })).jobId;
    const folder = (await engine.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'fs-folder', fsPath: g.dir, source: 'auto' })).jobId;

    // Distinct subjects -> distinct jobs (proves each routed through the pipeline).
    expect(new Set([committed, dirty, folder]).size).toBe(3);

    // All rows live in the same review_jobs table with the same terminal path.
    const rows = h.d.db
      .query<{ job_id: string; source: string; state: string }, [string, string, string]>(`SELECT job_id, source, state FROM review_jobs WHERE job_id IN (?,?,?)`)
      .all(committed, dirty, folder);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.source === 'auto')).toBe(true);

    // Run all three through the same engine and confirm terminal + report.
    for (const id of [committed, dirty, folder]) {
      await engine.runJob(id);
      const job = h.d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id=?`).get(id)!;
      expect(['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE']).toContain(job.state);
      expect(existsSync(join(h.reportDir, `${id}.json`))).toBe(true);
    }
    h.close();
  });
});