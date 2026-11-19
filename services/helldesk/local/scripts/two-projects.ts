// Prove two SIMULTANEOUS real reviews from INDEPENDENT projects on the live daemon.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGitFixture } from '../tests/helpers';

const BASE = 'http://127.0.0.1:4790';
const DD = 'C:\\Users\\lukes.COREI9\\AppData\\Local\\CyberLuke\\LocalGasDepartment';
const token = readFileSync(join(DD, 'token'), 'utf-8').trim();
const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const get = (p: string) => fetch(BASE + p).then((r) => r.json()).catch(() => null);

async function enqueue() {
  // Default fixture = two commits (baseline + change) so HEAD~1 resolves.
  const g = makeGitFixture();
  const reg = await fetch(BASE + '/v1/workspaces/register', { method: 'POST', headers: A, body: JSON.stringify({ path: g.dir }) });
  const { workspace } = await reg.json();
  const enq = await fetch(BASE + '/v1/reviews', { method: 'POST', headers: A, body: JSON.stringify({ workspaceId: workspace.workspaceId, subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api' } }) });
  const { jobId } = await enq.json();
  return { jobId, dir: g.dir };
}

const p1 = await enqueue();
const p2 = await enqueue();
console.log('[two] projectA job=', p1.jobId, ' (different workspace)');
console.log('[two] projectB job=', p2.jobId, ' (different workspace)');

const deadline = Date.now() + 300_000;
let done = { a: false, b: false };
function isTerminal(s?: string) { return ['COMPLETED_PASS','COMPLETED_FINDINGS','INCONCLUSIVE','FAILED_TERMINAL'].includes(s ?? ''); }
while (Date.now() < deadline && (!done.a || !done.b)) {
  if (!done.a) { const j = await get(`/v1/jobs/${p1.jobId}`); if (isTerminal(j?.job?.state)) { done.a = true; console.log('[two] A =>', j?.job?.state); } }
  if (!done.b) { const j = await get(`/v1/jobs/${p2.jobId}`); if (isTerminal(j?.job?.state)) { done.b = true; console.log('[two] B =>', j?.job?.state); } }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('[two] both terminal:', done.a && done.b);

// Workers for BOTH jobs, all real.
const workers = (await get('/v1/workers'))?.workers ?? [];
for (const jobId of [p1.jobId, p2.jobId]) {
  const w = workers.filter((x: any) => x.job_id === jobId);
  const real = w.every((x: any) => x.provider_id === 'litellm-edge');
  console.log(`[two] ${jobId}: roles=${w.map((x: any)=>`${x.role}:${x.status}`).join(', ')} allReal=${real}`);
}
// Reports persisted for both.
const r1 = await get(`/v1/reports/${p1.jobId}`);
const r2 = await get(`/v1/reports/${p2.jobId}`);
console.log('[two] reports persisted:', !!r1?.report?.jobId, !!r2?.report?.jobId);
console.log('[two] findings:', (r1?.report?.findings ?? []).length, (r2?.report?.findings ?? []).length);