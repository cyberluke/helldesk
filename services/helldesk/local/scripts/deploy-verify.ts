// Deploy verification against the live persistent daemon on 4789.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeGitFixture } from '../tests/helpers';

const BASE = 'http://127.0.0.1:4789';
const DD = 'C:\\Users\\lukes.COREI9\\AppData\\Local\\CyberLuke\\LocalGasDepartment';
const token = readFileSync(join(DD, 'token'), 'utf-8').trim();
const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const get = (p: string) => fetch(BASE + p).then((r) => r.json()).catch(() => null);

function ws(instanceId: string, roots: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`${BASE.replace('http', 'ws')}/v1/ws?token=${encodeURIComponent(token)}`);
    w.onopen = () => {
      w.send(JSON.stringify({ type: 'hello.authenticate', body: { instanceId, runtimeId: 'nv', pid: 0, workspaceRoots: roots, pluginVersion: '1.0', sdkVersion: '1.0', capabilities: ['chat.message'], token } }));
      setTimeout(() => {
        for (const r of roots) w.send(JSON.stringify({ type: 'session.upsert', body: { instanceId, sessionId: r, workspaceRoot: r, status: 'active' } }));
        setTimeout(() => resolve(w), 500);
      }, 300);
    };
    w.onerror = (e) => reject(new Error(String((e as ErrorEvent)?.message ?? 'ws error')));
  });
}

await get('/health').then((h: any) => console.log('health.alive=', h?.alive, 'hostCount=', h?.hostCount));

// Attach two simulated plugin hosts.
const w1 = await ws('instance_neo_1', ['C:/mock/host/one']);
const w2 = await ws('instance_neo_2', ['C:/mock/host/two']);
const hosts = await get('/v1/hosts');
console.log('[attach] hosts registered:', hosts?.hosts?.length, 'ids=', (hosts?.hosts ?? []).map((h: any) => h.instanceId ?? h.hostId));
const sessions = await get('/v1/sessions');
console.log('[attach] sessions:', (sessions?.sessions ?? []).map((s: any) => s.sessionId));

// Register a committed repo (two commits so base=HEAD~1 resolves) and run ONE
// review via detached workers against the live persistent daemon.
const g = makeGitFixture();
const reg = await fetch(BASE + '/v1/workspaces/register', { method: 'POST', headers: A, body: JSON.stringify({ path: g.dir }) });
const wsRec = await reg.json();
const enq = await fetch(BASE + '/v1/reviews', { method: 'POST', headers: A, body: JSON.stringify({ workspaceId: wsRec.workspace.workspaceId, subject: { workspaceId: wsRec.workspace.workspaceId, subjectKind: 'git-head', source: 'api' } }) });
const enqBody = await enq.json();
const jobId = enqBody.jobId;
console.log('[job] enqueued', jobId, 'status', enq.status);

let state;
for (let i = 0; i < 60; i++) {
  const j = await get(`/v1/jobs/${jobId}`);
  state = j?.job?.state;
  if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE'].includes(state)) break;
  await new Promise((r) => setTimeout(r, 250));
}
console.log('[job] final state=', state);

const workers = await get('/v1/workers');
const rows = workers?.workers ?? [];
console.log('[workers] roles/status:', rows.map((w: any) => `${w.role}:${w.status}`));
const adjOk = rows.some((w: any) => w.role === 'adjudicator' && w.status === 'succeeded');

const rep = await get(`/v1/reports/${jobId}`);
console.log('[report] persisted:', !!rep?.report?.jobId, 'coverage.changedFiles=', rep?.report?.coverage?.changedFiles);

console.log('[verify-result]', JSON.stringify({ jobState: state, adjSucceeded: adjOk, reportOK: !!rep?.report?.jobId }));

w1.close(); w2.close();
// Leave the daemon running (persistent).