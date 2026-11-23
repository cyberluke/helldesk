// Real E2E: one review through the production daemon (runner=kilo, real inference).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGitFixture } from '../tests/helpers';

const BASE = process.env.GT_BASE ?? 'http://127.0.0.1:4790';
const DD = 'C:\\Users\\lukes.COREI9\\AppData\\Local\\HELLDESK\\LocalDepartment';
const token = readFileSync(join(DD, 'token'), 'utf-8').trim();
const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const get = (p: string) => fetch(BASE + p).then((r) => r.json()).catch(() => null);

const h = await get('/health');
console.log('[health] alive=', h?.alive, 'queueDepth=', JSON.stringify(h?.queueDepth));

const g = makeGitFixture();
const reg = await fetch(BASE + '/v1/workspaces/register', { method: 'POST', headers: A, body: JSON.stringify({ path: g.dir }) });
const { workspace } = await reg.json();
const enq = await fetch(BASE + '/v1/reviews', { method: 'POST', headers: A, body: JSON.stringify({ workspaceId: workspace.workspaceId, subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api' } }) });
const { jobId } = await enq.json();
console.log('[job] enqueued', jobId);

let state, attempts = 0;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const j = await get(`/v1/jobs/${jobId}`);
  state = j?.job?.state;
  if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(state)) break;
  await new Promise((r) => setTimeout(r, 2000));
  attempts++;
}
console.log('[job] final state=', state, '(polled', attempts, 'x)');

const workers = (await get('/v1/workers'))?.workers ?? [];
console.log('[workers]');
for (const w of workers.filter((x: any) => x.job_id === jobId)) {
  console.log(`  ${w.role}: status=${w.status} exit=${w.exit_code} provider=${w.provider_id}/${w.model_id} err=${w.error?.slice(0, 120) ?? 'none'}`);
}

const rep = await get(`/v1/reports/${jobId}`);
const report = rep?.report;
console.log('[report] jobId=', report?.jobId, 'result=', report?.result);
console.log('[report] models (provenance):', JSON.stringify(report?.models ?? report?.meta?.models ?? 'n/a'));
console.log('[report] findings count=', (report?.findings ?? []).length);
console.log('[report] synthetic?=', report?.synthetic ?? '(no synthetic flag, real)');

// The report should record real provider/model provenance (openai-compatible-edge/demo-model plugin -> deepseek backend).
const models = report?.models ?? [];
const hasReal = models.some((m: any) => m && /openai-compatible|deepseek|demo-model/.test(JSON.stringify(m)));
console.log('[verify] real provenance present:', hasReal ? 'YES' : 'NO');
console.log('DONE');