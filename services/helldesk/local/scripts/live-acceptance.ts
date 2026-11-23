// LIVE_ACCEPTANCE v2: real plugin host + auto coding-task review.
// Fixture is a SEVERE, unambiguous regression (function now returns wrong sum
// for any non-empty array) so the real reviewers/adjudicator yield FINDINGS.
import { LocalHelldeskPlugin } from "../plugin/index.ts";
import { loadConfig } from "../src/config.ts";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const WS = "C:/Users/LUKES~1.COR/AppData/Local/Temp/kilo/accept-ws2";
const GT = process.env.HELLDESK_CONTROL_URL ?? `http://127.0.0.1:${loadConfig().daemon.port}`;
const TOKEN = readFileSync("C:/Users/lukes.COREI9/AppData/Local/HELLDESK/LocalDepartment/token", "utf-8").trim();
const j = (a, b) => a.replace(/\\/g, "/").replace(/\/$/, "") + "/" + b;

async function main() {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: WS });
  execFileSync("git", ["config", "user.email", "gt@l"], { cwd: WS });
  execFileSync("git", ["config", "user.name", "gt"], { cwd: WS });
  writeFileSync(j(WS, "sum.js"), "function sumAll(nums) { let t = 0; for (const n of nums) t += n; return t; }\n");
  execFileSync("git", ["add", "."], { cwd: WS });
  execFileSync("git", ["commit", "-qm", "baseline: sumAll sums all"], { cwd: WS });
  // dirty working tree: SEVERE regression (drops the total; returns 0 always)
  writeFileSync(j(WS, "sum.js"), "function sumAll(nums) { return 0; }\n");
  console.log("[accept] workspace ready, dirty sum.js now returns 0 (severe regression)");

  const p = await LocalHelldeskPlugin({ client: {} as any, worktree: WS, directory: WS });
  console.log("[accept] plugin activated");

  const sid = "accept2-session";
  await p["chat.message"]?.({ sessionID: sid, model: { providerID: "openai-compatible", modelID: "demo-model" } } as any);
  await p["event"]?.({ event: { type: "file.edited", properties: { sessionID: sid, file: "sum.js" } } } as any);
  await p["event"]?.({ event: { type: "session.idle", properties: { sessionID: sid, status: "idle" } } } as any);
  console.log("[accept] task events fired; waiting for auto-enqueue...");

  await new Promise((r) => setTimeout(r, 12000));
  const h = { Authorization: "Bearer " + TOKEN };
  const jobs = (await (await fetch(GT + "/v1/jobs", { headers: h })).json())?.jobs || [];
  console.log("[accept] jobs:", jobs.slice(0,3).map((x) => `${x.job_id}:${x.state}:${x.source}`).join(", "));
  const jobId = jobs[0]?.job_id;
  if (!jobId) { console.log("[accept] NO AUTO-ENQUEUED JOB"); process.exit(2); }
  console.log("[accept] auto job", jobId, "state", jobs[0].state, "src", jobs[0].source);

  let state = "";
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const job = (await (await fetch(GT + "/v1/jobs/" + jobId, { headers: h })).json())?.job;
    state = job?.state ?? "?";
    console.log(`[accept] job ${state} result=${job?.result ?? ""}`);
    if (String(state).startsWith("COMPLETED") || state === "FAILED_TERMINAL" || state === "INCONCLUSIVE") break;
  }
  console.log("[accept] final:", state);
  if (!String(state).startsWith("COMPLETED_FINDINGS")) { console.log("[accept] GATE NOT MET (final="+state+")"); process.exit(3); }
  const repPath = join("C:/Users/lukes.COREI9/AppData/Local/HELLDESK/LocalDepartment/reports", jobId + ".json");
  const rep = existsSync(repPath) ? JSON.parse(readFileSync(repPath, "utf-8")) : null;
  console.log("[accept] REPORT result=", rep?.result, "findings=", rep?.findings?.length);
  (rep?.findings || []).slice(0,5).forEach((f) => console.log(`[accept]  - [${f.severity}/${f.confidence}] ${f.title}`));
  console.log("[accept] models=", (rep?.models || []).map((m) => `${m.role}=${m.providerID}/${m.modelID}`).join("; "));
  console.log("[accept] GATE MET: LIVE_AUTO_REVIEW_VERIFIED");
  process.exit(0);
}
main().catch((e) => { console.error("[accept] fatal", e?.message ?? e); process.exit(1); });