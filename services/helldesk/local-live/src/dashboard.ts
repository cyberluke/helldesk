/**
 * Global app-switcher shell — one entry to both HELLDESK experiences.
 *
 * - "Department"   → local HELLDESK control plane (this server, /department)
 * - "ExcellenceGovernor" → the real NAI ExcellenceGovernor UI (served separately, /:8787)
 *
 * Both are shown inside an app shell with a top global menu; each can be
 * opened full-screen.
 */

export function globalShellHtml(): string {
  const excellenceGovernorUrl = process.env.HELLDESK_EXCELLENCE_GOVERNOR_URL ?? 'http://127.0.0.1:8787/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HELLDESK — Global</title>
<style>
:root{--bg:#0a0e17;--panel:#131a2c;--line:rgba(120,140,180,.16);--fg:#e7edf7;--muted:#8ea0bd;--accent:#4f8cff;--accent-2:#7b6cff;--ok:#34d399}
*{box-sizing:border-box}html,body{margin:0;height:100%;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif}
body{background:radial-gradient(1200px 600px at 15% -10%,rgba(79,140,255,.14),transparent 60%),var(--bg);color:var(--fg)}
.appbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:12px;padding:12px 22px;background:rgba(10,14,23,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
.logo{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:grid;place-items:center;color:#fff;font-size:15px;box-shadow:0 4px 14px rgba(79,140,255,.4)}
.spacer{flex:1}
.switch{display:flex;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:4px}
.switch button{border:0;background:transparent;color:var(--muted);padding:8px 18px;border-radius:9px;cursor:pointer;font-weight:600;font-size:13px;transition:.15s}
.switch button.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
.switch button:hover:not(.on){color:var(--fg)}
.link{background:transparent;border:1px solid var(--line);color:var(--muted);padding:7px 12px;border-radius:9px;cursor:pointer;font-size:12px;text-decoration:none}
.link:hover{color:var(--fg)}
.frame-wrap{height:calc(100vh - 58px);width:100%}
iframe{width:100%;height:100%;border:0;background:var(--bg)}
.toast{position:fixed;bottom:22px;right:22px;z-index:60;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 16px;box-shadow:0 8px 40px rgba(0,0,0,.5);font-size:13px;opacity:0;transform:translateY(8px);transition:.2s}
.toast.show{opacity:1;transform:none}
</style>
</head>
<body>
<div class="appbar">
  <div class="brand"><div class="logo">⚙</div>HELLDESK <span class="muted" style="font-weight:400;color:var(--muted);font-size:12px">· local federation</span></div>
  <div class="spacer"></div>
  <nav class="switch" id="appSwitch">
    <button class="on" data-url="/department" data-name="Department">🏛 Department</button>
    <button data-url="/helldesk" data-name="HELLDESK UI">🧩 HELLDESK UI</button>
    <button data-url="${excellenceGovernorUrl}" data-name="ExcellenceGovernor">🔍 ExcellenceGovernor</button>
  </nav>
  <a class="link" id="openTab" href="/department" target="_blank">↗ open in new tab</a>
</div>
<div class="frame-wrap"><iframe id="frame" src="/department"></iframe></div>
<div class="toast" id="toast"></div>
<script>
const f=$('frame'), sw=$('appSwitch'), open=$('openTab');
sw.querySelectorAll('button').forEach(b=>{
  b.addEventListener('click',()=>{
    sw.querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    f.src=b.dataset.url;
    open.href=b.dataset.url;
  });
});
// simple $ helper
function $(id){return document.getElementById(id)}
// open-fullscreen keeps the iframe aligned
document.title='HELLDESK · '+ (sw.querySelector('button.on')?.dataset.name || 'Global');
</script>
</body>
</html>`;
}

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HELLDESK — NAI ExcellenceGovernor</title>
<style>
:root{
  --bg:#0a0e17; --bg2:#0f1524; --panel:rgba(22,29,44,.72); --panel-solid:#161d2e;
  --line:rgba(120,140,180,.14); --fg:#e7edf7; --muted:#8ea0bd; --accent:#4f8cff;
  --accent-2:#7b6cff; --ok:#34d399; --warn:#fbbf24; --bad:#f87171; --glass:rgba(255,255,255,.04);
  --shadow:0 8px 40px rgba(0,0,0,.45); --r:16px;
}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;
  background:
    radial-gradient(1200px 600px at 15% -10%, rgba(79,140,255,.16), transparent 60%),
    radial-gradient(1000px 500px at 90% 10%, rgba(123,108,255,.13), transparent 55%),
    var(--bg);
  color:var(--fg); min-height:100vh;
}
a{color:var(--accent);text-decoration:none}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* header */
header{
  display:flex;align-items:center;gap:16px;padding:14px 22px;position:sticky;top:0;z-index:30;
  background:linear-gradient(180deg,rgba(10,14,23,.9),rgba(10,14,23,.72));backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line)
}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:.2px}
.logo{width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:grid;place-items:center;font-size:14px;color:#fff;box-shadow:0 4px 14px rgba(79,140,255,.4)}
.brand span.sub{font-weight:400;color:var(--muted);font-size:12px;margin-left:2px}
.spacer{flex:1}
.nav{display:flex;gap:4px}
.nav button{background:transparent;border:0;color:var(--muted);padding:8px 14px;border-radius:10px;cursor:pointer;font-size:13px;transition:.15s}
.nav button:hover{color:var(--fg);background:var(--glass)}
.nav button.on{color:var(--fg);background:var(--glass);box-shadow:inset 0 0 0 1px var(--line)}
.status-pill{display:inline-flex;align-items:center;gap:7px;background:var(--glass);border:1px solid var(--line);padding:6px 12px;border-radius:999px;font-size:12px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.dot.red{background:var(--bad);box-shadow:0 0 10px var(--bad)}

/* layout */
main{max-width:1280px;margin:0 auto;padding:24px 22px 48px}
.toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:20px}
.field{display:flex;flex-direction:column;gap:6px;min-width:220px}
.field label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}
input,select,textarea{
  background:var(--panel-solid);border:1px solid var(--line);color:var(--fg);border-radius:12px;
  padding:10px 12px;font-size:13.5px;outline:none;transition:.15s
}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(79,140,255,.15)}
button.primary{
  background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border:0;border-radius:12px;
  padding:11px 20px;font-weight:600;cursor:pointer;font-size:13.5px;transition:.15s;box-shadow:0 6px 20px rgba(79,140,255,.35)
}
button.primary:hover{filter:brightness(1.08);transform:translateY(-1px)}
button.primary:disabled{opacity:.5;cursor:not-allowed;transform:none}
button.ghost{background:var(--glass);border:1px solid var(--line);color:var(--fg);border-radius:12px;padding:10px 16px;cursor:pointer;font-size:13px;transition:.15s}
button.ghost:hover{background:rgba(255,255,255,.08)}
button.danger{color:var(--bad);border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
button.danger:hover{background:rgba(248,113,113,.18)}

/* cards */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px;backdrop-filter:blur(8px);box-shadow:var(--shadow);transition:.15s}
.card:hover{border-color:rgba(120,140,180,.3)}
.card h3{margin:0 0 4px;font-size:14px;display:flex;align-items:center;gap:8px}
.card .muted{color:var(--muted);font-size:12px;margin:0 0 10px}
.chip{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--glass);border:1px solid var(--line)}
.chip.ok{color:var(--ok);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.1)}
.chip.warn{color:var(--warn);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.1)}
.chip.bad{color:var(--bad);border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.1)}
.meta{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}

/* tables */
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--muted);text-align:left;font-weight:500;padding:8px 10px;border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td{padding:9px 10px;border-bottom:1px solid rgba(120,140,180,.07)}
tr:hover td{background:var(--glass)}

/* sections */
.tab-panel{display:none}
.tab-panel.on{display:block;animation:fade .2s ease}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.section-title{font-size:15px;font-weight:700;margin:26px 0 10px;display:flex;align-items:center;gap:8px}
.log{background:#070b12;border:1px solid var(--line);border-radius:12px;padding:12px;height:260px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.6}
.log .t{color:#5c6b87}
.log .ev{color:var(--accent)}
.log .good{color:var(--ok)}

/* topology graph */
.topo{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
.topo-node{background:var(--panel);border:1px solid var(--line);border-radius:12px;min-width:200px;max-width:260px;padding:12px}
.topo-node h4{margin:0 0 6px;font-size:13px;display:flex;align-items:center;gap:6px}
.topo-node .role{font-size:11px;color:var(--muted)}
.topo-node .links{margin-top:8px;display:flex;gap:4px;flex-wrap:wrap}
.topo-node .links .mono{font-size:10.5px;color:var(--muted);background:var(--glass);border:1px solid var(--line);padding:2px 6px;border-radius:6px}
.topo-empty{color:var(--muted);font-size:13px;padding:20px}

/* ticket board / kanban */
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.board-col{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;min-height:120px}
.board-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);display:flex;align-items:center;gap:8px;margin-bottom:8px}
.board-cards{display:flex;flex-direction:column;gap:8px}
.bcard{background:var(--panel-solid);border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-size:12.5px}
.bcard .bt{font-weight:600}
.bcard .bm{margin-top:4px;color:var(--muted);font-size:11px;display:flex;gap:8px;align-items:center}
.bcard .bm .cb{font-size:10px}

/* shift timeline */
.timeline{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}
.tl-row{display:flex;gap:10px;align-items:center}
.tl-row .bar{flex:1;height:6px;background:var(--panel);border-radius:99px;overflow:hidden}
.tl-row .bar > div{height:100%;background:linear-gradient(90deg,var(--accent),var(--ok))}
.tl-step{width:18px;height:18px;border-radius:50%;background:var(--panel);border:1px solid var(--line);display:grid;place-items:center;font-size:10px;color:var(--muted);flex:none}
.tl-step.done{background:var(--ok);color:#032;border-color:var(--ok)}

/* frontDesk chat */
.chat-log{background:#070b12;border:1px solid var(--line);border-radius:12px;padding:12px;height:300px;overflow:auto;font-size:13px;line-height:1.6}
.chat-log .you{color:var(--accent);font-weight:600}
.chat-log .frontDesk{color:var(--ok);font-weight:600}
.chat-log .t{color:#5c6b87;font-size:11px}
.toast{position:fixed;bottom:22px;right:22px;z-index:50;background:var(--panel-solid);border:1px solid var(--line);border-radius:14px;padding:12px 16px;box-shadow:var(--shadow);font-size:13px;opacity:0;transform:translateY(8px);transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:none}
footer{margin-top:40px;border-top:1px solid var(--line);padding-top:14px;color:var(--muted);font-size:12px;display:flex;gap:16px;flex-wrap:wrap}
</style>
</head>
<body>
<header>
  <div class="brand"><div class="logo">⚙</div>HELLDESK <span class="sub">NAI ExcellenceGovernor · local</span></div>
  <div class="spacer"></div>
  <nav class="nav" id="nav">
    <button class="on" data-tab="overview">Overview</button>
    <button data-tab="topology">Topology</button>
    <button data-tab="board">Ticket Board</button>
    <button data-tab="tasks">Tasks</button>
    <button data-tab="shift">Shift</button>
    <button data-tab="agents">Agents</button>
    <button data-tab="chat">FrontDesk Chat</button>
    <button data-tab="project">Project</button>
    <button data-tab="config">⚙ Config</button>
    <button data-tab="activity">Activity</button>
  </nav>
  <span class="status-pill"><span class="dot" id="healthdot"></span><span id="health">connecting…</span></span>
  <button class="ghost danger" id="restartBtn" onclick="restartDaemons()">⟳ Force-restart daemons</button>
</header>

<main>
  <!-- Overview -->
  <section class="tab-panel on" id="p-overview">
    <div class="toolbar">
      <div class="field">
        <label>Department</label>
        <select id="departmentSel"><option value="default">default</option></select>
      </div>
      <button class="ghost" onclick="loadAll()">↻ Refresh</button>
      <div class="spacer"></div>
      <span class="status-pill mono" id="summary"></span>
    </div>

    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div class="card"><h3>🧮 Workstations</h3><p class="muted">repositories & configs</p><b class="mono" id="statWorkstations" style="font-size:26px">–</b></div>
      <div class="card"><h3>🎯 Tasks</h3><p class="muted">tickets open + in-flight</p><b class="mono" id="statTickets" style="font-size:26px">–</b></div>
      <div class="card"><h3>🤖 Agents</h3><p class="muted">souls · qualityAssurance · frontDesk</p><b class="mono" id="statAgents" style="font-size:26px">–</b></div>
      <div class="card"><h3>🚚 Shift</h3><p class="muted">active missions</p><b class="mono" id="statShifts" style="font-size:26px">–</b></div>
    </div>

    <div class="section-title">⚡ Quick dispatch</div>
    <div class="card" style="max-width:680px">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        <div class="field" style="min-width:260px;flex:1">
          <label>What should I build / fix?</label>
          <input id="taskText" placeholder="e.g. make server.mjs print the OS-local date/time" autofocus>
        </div>
        <button class="primary" id="runBtn" onclick="runTask()">▶ Dispatch</button>
      </div>
      <div class="muted" style="margin-top:10px" id="taskHint">Creates a ticket on the active workstation and starts a shift.</div>
    </div>
  </section>

  <!-- Topology (original HELLDESK SystemTopology) -->
  <section class="tab-panel" id="p-topology">
    <div class="section-title">🕸 System topology <span class="chip" id="topoCount">0</span> <span class="muted mono" style="font-weight:400;font-size:12px">workstations · agents · tickets</span></div>
    <div class="topo" id="topo">
      <div class="topo-empty">render workstations, agents and their hooked tickets as a live graph…</div>
    </div>
  </section>

  <!-- Ticket Board (original HELLDESK TicketBoard — kanban) -->
  <section class="tab-panel" id="p-board">
    <div class="section-title">🗃 Ticket board <span class="chip" id="boardTotal">0</span></div>
    <div class="board" id="ticketBoard">
      <div class="board-col" data-col="open"><div class="board-title">Open <span class="chip" data-count="open">0</span></div><div class="board-cards" data-cards="open"></div></div>
      <div class="board-col" data-col="in_progress"><div class="board-title">In Progress <span class="chip" data-count="in_progress">0</span></div><div class="board-cards" data-cards="in_progress"></div></div>
      <div class="board-col" data-col="in_review"><div class="board-title">In Review <span class="chip" data-count="in_review">0</span></div><div class="board-cards" data-cards="in_review"></div></div>
      <div class="board-col" data-col="closed"><div class="board-title">Closed <span class="chip" data-count="closed">0</span></div><div class="board-cards" data-cards="closed"></div></div>
    </div>
  </section>

  <!-- Tasks -->
  <section class="tab-panel" id="p-tasks">
    <div class="section-title">Task board <span class="chip" id="taskCount">0</span></div>
    <table id="ticketsTable">
      <thead><tr><th>Status</th><th>Title</th><th>Type</th><th>Assignee</th><th>Workstation</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <!-- Shift -->
  <section class="tab-panel" id="p-shift">
    <div class="section-title">Shifts <span class="chip" id="shiftCount">0</span></div>
    <div class="timeline" id="shiftTimeline"></div>
    <table id="shiftTable">
      <thead><tr><th>Shift</th><th>Tickets</th><th>Progress</th><th>Staged</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <!-- Agents -->
  <section class="tab-panel" id="p-agents">
    <div class="section-title">Agents <span class="chip" id="agentCount">0</span></div>
    <div class="grid" id="agentGrid"></div>
  </section>

  <!-- FrontDesk Chat (original HELLDESK FrontDeskChat) -->
  <section class="tab-panel" id="p-chat">
    <div class="section-title">💬 FrontDesk chat <span class="muted mono" style="font-weight:400;font-size:12px">ask the FrontDesk to decompose a mission</span></div>
    <div class="card" style="max-width:880px">
      <div class="chat-log" id="chatLog"><div class="t">… open a project/workstation and ask the FrontDesk a question.</div></div>
      <div style="display:flex;gap:10px;margin-top:12px;align-items:end">
        <div class="field" style="flex:1;min-width:0">
          <label>To the FrontDesk</label>
          <input id="chatInput" placeholder="e.g. decompose: add a /status endpoint and a cache toggle">
        </div>
        <button class="primary" onclick="frontDeskSend()">➤ Send</button>
      </div>
    </div>
  </section>

  <!-- Project (per-entity local-filesystem git config) -->
  <section class="tab-panel" id="p-project">
    <div class="section-title">⚙ Project · local-filesystem git</div>
    <div class="card" style="max-width:720px">
      <p class="muted" style="margin:0 0 14px">Agents operate on a local git checkout per project/workstation — no containers. Point this department at a repo and hit "Dispatch".</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="field" style="min-width:0"><label>Adapter</label>
          <select id="lrAdapter"><option value="local-git">local-git (local filesystem)</option><option value="none">none</option></select>
        </div>
        <div class="field" style="min-width:0"><label>Branch</label><input id="lrBranch" placeholder="main"></div>
        <div class="field" style="grid-column:1 / -1"><label>Local repo path (filesystem)</label><input id="lrRepoPath" placeholder="C:\\dev\\myproject  or  /home/u/proj  or  path to a bare repo"></div>
        <div class="field" style="grid-column:1 / -1;min-width:0"><label>Work directory (HELLDESK clones here)</label><input id="lrWorkdir" placeholder="(default: {data}/work)"></div>
        <div class="field" style="grid-column:1 / -1;min-width:0"><label>Bare remote to push (optional)</label><input id="lrBare" placeholder="C:\\repos\\myproject.git"></div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
        <button class="primary" onclick="saveProject()">💾 Save project config</button>
        <button class="ghost" onclick="dispatchNow()">▶ Dispatch to repo</button>
        <span class="muted mono" id="dispatchOut" style="font-size:12px"></span>
      </div>
      <div class="log" id="projectLog" style="height:120px;margin-top:12px">... project config not loaded ...</div>
    </div>
  </section>

  <!-- Config (control plane /v1 config + daemon lifecycle) -->
  <section class="tab-panel" id="p-config">
    <div class="section-title">⚙ Runtime config <span class="chip" id="cfgChip">–</span></div>
    <div class="card" style="max-width:1100px">
      <p class="muted" style="margin:0 0 14px">
        Control plane (<span class="mono" id="cfgPath">…</span>). Fields marked <span class="chip ok">LIVE</span> apply immediately;
        <span class="chip warn">RESTART</span> apply on next daemon start.
      </p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px" id="cfgGrid">
        ...loading config...
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="primary" onclick="saveConfig()">💾 Save config</button>
        <button class="ghost" onclick="loadConfig()">↻ Reload</button>
        <span class="muted mono" id="cfgOut" style="font-size:12px"></span>
        <button class="ghost danger" onclick="restartDaemons()">⟳ Force-restart all daemons</button>
      </div>
    </div>
  </section>

  <!-- Activity -->
  <section class="tab-panel" id="p-activity">
    <div class="section-title">Live activity</div>
    <div class="log" id="log">... waiting for events ...</div>
  </section>
</main>

<footer>
  <span>HELLDESK local · federated Cloudflare experience</span>
  <span>NAI Lattice secrets · no billing · no cloud</span>
  <span class="mono" id="apiBase">api /api/departments/:id</span>
</footer>

<div class="toast" id="toast"></div>

<script>
const department = () => document.getElementById('departmentSel').value || 'default';
const $ = id => document.getElementById(id);
const STATE = { workstations: [], tickets: [], agents: [], shifts: [] };
let POLL;

function toast(msg, ok=true){const t=$('toast');t.textContent=msg;t.style.background=ok?'var(--panel-solid)':'#2a1116';t.style.borderColor=ok?'var(--ok)':'var(--bad)';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600);}
async function j(u,opt){try{const r=await fetch(u,opt);const t=await r.text();try{return JSON.parse(t)}catch{return {raw:t,status:r.status}}}catch(e){return {error:String(e)}}}

async function loadAll(){
  const d = await j('/dashboard?departmentId='+encodeURIComponent(department()));
  if(!d || d.error){ toast('dashboard unreachable: '+(d&&d.error),false); return }
  STATE.workstations=d.workstations||[]; STATE.tickets=d.tickets||[]; STATE.agents=d.agents||[]; STATE.shifts=d.shifts||[];
  $('statWorkstations').textContent=STATE.workstations.length; $('statTickets').textContent=STATE.tickets.length;
  $('statAgents').textContent=STATE.agents.length; $('statShifts').textContent=STATE.shifts.length;
  $('summary').textContent='department '+d.departmentId;
  renderTasks(); renderShifts(); renderAgents();
  renderTopology(); renderTicketBoard(); renderShiftTimeline();
  // populate department picker
  const sel=$('departmentSel'); const cur=department();
  (d.departments||[]).forEach(t=>{ if(!Array.from(sel.options).some(o=>o.value===t)){ const o=document.createElement('option');o.value=t;o.textContent=t;sel.appendChild(o)}});
  sel.value=cur;
  logEvent('dashboard refreshed — '+STATE.tickets.length+' tasks, '+STATE.agents.length+' agents');
}

function renderTasks(){ const tb=$('ticketsTable').querySelector('tbody'); tb.innerHTML='';
  (STATE.tickets||[]).forEach(b=>{
    const tr=document.createElement('tr');
    const cls=b.status==='closed'?'ok':b.status==='open'?'warn':'warn';
    const aid=(b.assignee_agent_ticket_id||'').replace(/['"\\<>]/g,'');
    tr.innerHTML='<td><span class="chip '+cls+'">'+esc(b.status)+'</span></td><td>'+esc(b.title)+'</td><td>'+esc(b.type||'')+'</td><td>'+esc(b.assignee_agent_ticket_id||'—')+'</td><td class="mono">'+esc((b.workstation_id||'').slice(0,12))+'</td><td><button class="ghost" data-prime="'+esc(aid)+'" onclick="primeFromAttr(this)">▶</button></td>';
    tb.appendChild(tr);
  }); $('taskCount').textContent=STATE.tickets.length;
}
function primeFromAttr(btn){ const id=btn.getAttribute('data-prime'); if(id){ primeAgent(id); } }
function renderShifts(){ const tb=$('shiftTable').querySelector('tbody'); tb.innerHTML='';
  (STATE.shifts||[]).forEach(conv=>{
    const tr=document.createElement('tr');
    const pct=conv.total_tickets? Math.round(100*conv.closed_tickets/conv.total_tickets):0;
    const cid=String(conv.ticket_id||'').replace(/['"\\<>]/g,'');
    tr.innerHTML='<td class="mono">'+esc(conv.ticket_id.slice(0,10))+'</td><td>'+conv.total_tickets+'</td><td><div style="width:120px;height:8px;background:var(--panel);border-radius:99px;overflow:hidden"><div style="width:'+pct+'%;height:100%;background:var(--ok)"></div></div> '+pct+'%</td><td>'+esc(conv.staged?'staged':'active')+'</td><td><button class="ghost" data-startconv="'+esc(cid)+'" onclick="startConvFromAttr(this)">▶ Start</button></td>';
    tb.appendChild(tr);
  }); $('shiftCount').textContent=STATE.shifts.length;
}
function startConvFromAttr(btn){ const id=btn.getAttribute('data-startconv'); if(id){ startShift(id); } }
function renderAgents(){ const g=$('agentGrid'); g.innerHTML='';
  (STATE.agents||[]).forEach(a=>{
    const roleCls = a.role==='frontDesk'?'ok':a.role==='qualityAssurance'?'warn':'';
    const el=document.createElement('div'); el.className='card';
    el.innerHTML='<h3>'+esc(a.name||a.role)+' <span class="chip '+roleCls+'">'+esc(a.role)+'</span></h3><p class="muted">'+esc(a.identity)+'</p>'+
      '<p><span class="chip '+ (a.status==='idle'?'ok':a.status==='working'?'warn':'bad')+'">'+esc(a.status)+'</span></p>'+
      '<div class="meta"><span class="mono" style="font-size:11px;color:var(--muted)">'+(a.current_hook_ticket_id||'idle')+'</span></div>';
    g.appendChild(el);
  }); $('agentCount').textContent=STATE.agents.length;
}

// SystemTopology-style graph: workstations (roots) linking the agents hooked to them.
function renderTopology(){
  const topo=$('topo'); topo.innerHTML='';
  const workstations=STATE.workstations||[];
  if(!workstations.length){ topo.innerHTML='<div class="topo-empty">no workstations yet — create a workstation or run a dispatch.</div>'; $('topoCount').textContent='0'; return; }
  workstations.forEach(workstation=>{
    const rid=String(workstation.workstation_id||workstation.id||'');
    const agents=(STATE.agents||[]).filter(a=>a.workstation_id===rid || (a.workstation_id||'').includes(rid));
    const tickets=(STATE.tickets||[]).filter(b=>b.workstation_id===rid);
    const node=document.createElement('div'); node.className='topo-node';
    node.innerHTML='<h4>🗂 '+esc(workstation.name||'workstation')+' <span class="chip">'+esc(rid.slice(0,8))+'</span></h4>'+
      '<div class="role">'+esc(workstation.default_branch||'main')+'</div>'+
      '<div class="links"><span class="mono">'+agents.length+' agents</span><span class="mono">'+tickets.length+' tasks</span></div>'+
      '<div class="links">'+agents.slice(0,4).map(a=>'<span class="mono '+ (a.status==='working'?'':'') +'">'+esc((a.role||'').slice(0,3))+':'+esc((a.name||'').slice(0,10))+'</span>').join('')+'</div>';
    topo.appendChild(node);
  });
  $('topoCount').textContent=String(workstations.length);
}

// Ticket board (kanban) — group STATE.tickets by status.
function renderTicketBoard(){
  const cols={open:[],in_progress:[],in_review:[],closed:[]};
  (STATE.tickets||[]).forEach(b=>{ const k=(cols[b.status]?b.status:'open'); cols[k].push(b); });
  Object.keys(cols).forEach(k=>{
    const cards=$('[data-cards="'+k+'"]');
    if(!cards) return;
    cards.innerHTML=cols[k].length? cols[k].map(b=>
      '<div class="bcard"><div class="bt">'+esc(b.title)+'</div>'+
      '<div class="bm"><span class="chip cb '+(b.status==='closed'?'ok':b.status==='open'?'warn':'')+'">'+esc(b.status)+'</span>'+
      '<span class="mono">'+esc((b.workstation_id||'').slice(0,8))+'</span>'+
      (b.assignee_agent_ticket_id? '<span class="mono">'+esc(b.assignee_agent_ticket_id.slice(0,6))+'</span>':'')+
      '</div></div>').join('') : '<div class="t">empty</div>';
    const countEl=$('[data-count="'+k+'"]');
    if(countEl) countEl.textContent=String(cols[k].length);
  });
  $('boardTotal').textContent=String((STATE.tickets||[]).length);
}

// Shift timeline — visual step lanes instead of a flat table.
function renderShiftTimeline(){
  const tl=$('shiftTimeline'); if(!tl) return;
  tl.innerHTML='';
  const convs=STATE.shifts||[];
  if(!convs.length){ tl.innerHTML='<div class="t" style="color:var(--muted)">no shifts yet.</div>'; return; }
  convs.forEach(conv=>{
    const total=conv.total_tickets||0; const closed=conv.closed_tickets||0;
    const pct=total? Math.round(100*closed/total):0;
    const cid=String(conv.ticket_id||'').slice(0,10);
    const steps=[closed>0, closed>=1&&pct<100, closed>=Math.max(1||total,1)&&pct<100, pct>=100].map((done,i)=> // closed→inprog→review→closed visual
      '<div class="tl-step '+(done?'done':'')+'">'+(done?'✓':(i+1))+'</div>').join('');
    const row=document.createElement('div'); row.className='tl-row';
    row.innerHTML='<span class="mono" style="min-width:80px;font-size:11px;color:var(--muted)">'+esc(cid)+'</span>'+
      steps+'<div class="bar"><div style="width:'+pct+'%"></div></div>'+
      '<span class="mono" style="min-width:44px;font-size:11px">'+pct+'%</span>';
    tl.appendChild(row);
  });
}

// FrontDesk chat — send a decompose request through the local frontDesk handler.
async function frontDeskSend(){
  const text=$('chatInput').value.trim(); if(!text) return;
  const log=$('chatLog');
  log.innerHTML='<div><span class="you">you ›</span> '+esc(text)+'</div>'+log.innerHTML;
  $('chatInput').value='';
  const t=department(); const workstation=(STATE.workstations[0]||{});
  const rid=workstation.workstation_id||workstation.id||'workstation-local';
  const r=await j('/api/departments/'+t+'/workstations/'+rid+'/frontDesk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:text})});
  const answer=(r&&(r.frontDesk||r.result||r))||{};
  log.innerHTML='<div class="t" style="margin:4px 0">–</div><div><span class="frontDesk">frontDesk ›</span> '+esc(typeof answer==='string'?answer:JSON.stringify(answer).slice(0,400))+'</div><div class="t" style="margin:4px 0"></div>'+log.innerHTML;
  toast(r&&r.error?'frontDesk request failed':'frontDesk responded'); loadAll();
}

async function loadProject(){
  const d=await j('/api/departments/'+department()+'/dispatch/prepare');
  const lr=(d&&d.local_repo)||{adapter:'none'};
  $('lrAdapter').value=lr.adapter==='local-git'?'local-git':'none';
  $('lrRepoPath').value=lr.repo_path||''; $('lrBranch').value=lr.branch||'main';
  $('lrWorkdir').value=lr.workdir||''; $('lrBare').value=lr.bare_remote||'';
  $('projectLog').textContent='project config loaded: adapter='+lr.adapter+' repo='+(lr.repo_path||'(not set)');
}
async function saveProject(){
  const body={ local_repo:{ adapter:$('lrAdapter').value, repo_path:$('lrRepoPath').value||undefined, branch:$('lrBranch').value||'main', workdir:$('lrWorkdir').value||undefined, bare_remote:$('lrBare').value||undefined, allow_commit:true } };
  const r=await j('/api/departments/'+department()+'/config',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r&&r.success===false){ toast('save failed',false); return }
  toast('project config saved'); $('dispatchOut').textContent='saved'; loadProject();
}
async function dispatchNow(){
  const msg=$('taskText').value.trim()||'HELLDESK local work';
  $('dispatchOut').textContent='dispatching…';
  const r=await j('/api/departments/'+department()+'/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg,agentId:'local'})});
  const res=(r&&r.result)||{};
  if(res.ok){ toast('dispatched: '+(res.summary||'ok')); $('dispatchOut').textContent=(res.commit?('#'+res.commit+' '):'')+(res.branch||''); } else { toast('dispatch: '+(res.error||res.summary||'failed'),false); $('dispatchOut').textContent=res.error||res.summary||'failed'; }
  loadProject();
}

async function runTask(){
  const text=$('taskText').value.trim(); if(!text){toast('enter a task first',false);return}
  const t=department(); const workstation=(STATE.workstations[0]||{});
  $('runBtn').disabled=true; $('runBtn').textContent='…';
  // ensure a workstation exists on this department
  let workstationId = workstation.workstation_id || workstation.id;
  if(!workstationId){ const r=await j('/api/departments/'+t+'/workstations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'task-'+(Math.random()*1e4|0)})}); workstationId=(r&&(r.workstation||{}).workstation_id)||'workstation-local'; }
  // create a ticket
  const b=await j('/api/departments/'+t+'/workstations/'+workstationId+'/tickets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'issue',title:text,priority:'high'})});
  // create + start a shift embedding it
  const conv=await j('/api/departments/'+t+'/shifts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:text})});
  const cid=(conv&&(conv.shift||conv.ticket||{}).ticket_id)||(conv&&conv.ticket_id);
  if(cid){ await j('/api/departments/'+t+'/shifts/'+cid+'/start',{method:'POST'}); await j('/api/departments/'+t+'/shifts/'+cid+'/sling',{method:'POST'}); }
  $('runBtn').disabled=false; $('runBtn').textContent='▶ Dispatch';
  toast('dispatched: '+(b&&b.ticket?b.ticket.title:'task')); $('taskText').value='';
  logEvent('task dispatched / shift '+(cid||'created'));
  loadAll();
}
async function startShift(id){ await j('/api/departments/'+department()+'/shifts/'+id+'/start',{method:'POST'}); toast('shift started'); loadAll(); }
async function primeAgent(id){ if(!id)return; await j('/api/departments/'+department()+'/workstations/--/agents/'+id+'/prime',{method:'POST'}).catch(()=>{}); toast('primed'); }

function logEvent(msg){ const log=$('log'); const t=new Date().toLocaleTimeString(); log.innerHTML='<div><span class="t">'+t+'</span> <span class="ev">›</span> '+esc(msg)+'</div>'+log.innerHTML; }
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&','<':'<','>':'>','"':'"'}[c]))}

// nav tabs
document.getElementById('nav').querySelectorAll('button').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav button').forEach(b=>b.classList.remove('on'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('on'));
    btn.classList.add('on'); document.getElementById('p-'+btn.dataset.tab).classList.add('on');
  });
});

// ═══════════ Control-plane runtime config (via /api/v1 proxy) ═════════════
let CFG = { config: {}, meta: {} };
const SECRET_KEY_RE = /token|secret|password|api_?key|auth/i;
function cfgLabel(field){
  const m = CFG.meta||{};
  // find applicability by descending into section.meta then matching field
  for (const sec of Object.keys(m)) {
    const mm = m[sec];
    if (mm && typeof mm==='object' && (mm[field]==='live'||mm[field]==='restart')) return mm[field];
  }
  return 'restart'; // unknown fields default to restart (safe)
}
function valToInput(v){
  if (v===null||v===undefined) return '';
  if (typeof v==='boolean') return v?'true':'false';
  if (typeof v==='object') return JSON.stringify(v);
  return String(v);
}
function inputToVal(s, kind){
  if (kind==='boolean') return s==='true'||s==='1';
  if (kind==='number') { const n=Number(s); return Number.isNaN(n)?s:n; }
  return s;
}
function renderConfig(){
  const grid=$('cfgGrid'); grid.innerHTML='';
  $('cfgPath').textContent = CFG.path||'…';
  const cfg = CFG.config||{};
  // Collate a flat list of editable scalar leaves per section, preserving order.
  const sections = [
    ['daemon', cfg.daemon, 'daemon'],
    ['policy', cfg.policy, 'policy'],
    ['autonomy', cfg.autonomy, 'autonomy'],
    // Context tier ladder (32K..1M) — detection/override knobs are live.
    ['context', cfg.context, 'context'],
  ];
  const build = (secKey, obj, prefix) => {
    for (const k of Object.keys(obj||{})) {
      const v = obj[k];
      if (v===null||typeof v!=='object') {
        const applies = cfgLabel(k);
        const secret = SECRET_KEY_RE.test(k);
        grid.appendChild(renderField(secKey+'.'+k, k, v, applies, secret));
      } else if (Array.isArray(v)) {
        // workspaces-style arrays: render compact JSON editor.
        grid.appendChild(renderField(prefix+'.'+k, k, v, cfgLabel(k)||'live', false));
      } else {
        // nested object (e.g. reviewerModel, providers): render as JSON editor.
        grid.appendChild(renderField(prefix+'.'+k, k, v, cfgLabel(k)||'live', SECRET_KEY_RE.test(k)));
      }
    }
  };
  sections.forEach(([sk,o,p])=> build(sk,o,p));
  // workspaces
  const ws = cfg.workspaces;
  if (Array.isArray(ws)) grid.appendChild(renderField('workspaces','workspaces',ws,'live',false));
  $('cfgChip').textContent = Object.keys(cfg).length+' sections';
}
function renderField(prefix, label, value, applies, secret){
  const d=document.createElement('div'); d.className='field';
  d.style.minWidth='220px'; d.style.position='relative';
  const chip = applies==='live'
    ? '<span class="chip ok" title="Applies immediately">LIVE</span>'
    : '<span class="chip warn" title="Applies on next daemon start">RESTART</span>';
  const isObj = value!==null && typeof value==='object';
  const type = typeof value;
  if (isObj) {
    d.innerHTML = '<label>'+esc(prefix)+' '+chip+' <span class="muted mono" style="font-size:10px">JSON</span></label>'+
      '<textarea data-prefix="'+esc(prefix)+'" data-type="json" rows="'+(Array.isArray(value)?3:2)+'" style="font-family:ui-monospace,monospace;font-size:12px">'+esc(JSON.stringify(value,null,1))+'</textarea>';
  } else {
    const ct = type==='number'?'number':type==='boolean'?'boolean':'text';
    d.innerHTML = '<label>'+esc(prefix)+' '+chip+'</label>'+
      '<input data-prefix="'+esc(prefix)+'" data-type="'+ct+'" value="'+esc(valToInput(value))+'" placeholder="'+esc(label)+'">';
  }
  return d;
}
function collectConfigPatch(){
  const patch = { daemon:{}, policy:{}, autonomy:{}, context:{}, workspaces: undefined };
  const out = { daemon: patch.daemon, policy: patch.policy, autonomy: patch.autonomy, context: patch.context };
  document.querySelectorAll('#cfgGrid input,#cfgGrid textarea').forEach((el)=>{
    const prefix = el.getAttribute('data-prefix'); if(!prefix) return;
    const [sec, ...rest] = prefix.split('.');
    if (!out[sec]) return;
    const path = rest.join('.');
    const key = rest[rest.length-1];
    let v = el.value.trim();
    if (el.getAttribute('data-type')==='json'){ try{ v = JSON.parse(v); }catch{ return; } }
    else v = inputToVal(v, el.getAttribute('data-type'));
    // assign into nested rest path (only one level of nesting supported in form)
    if (path.includes('.')){
      const parent = rest.slice(0,-1).join('.');
      if (!out[sec][parent] || typeof out[sec][parent]!=='object') out[sec][parent]={};
      out[sec][parent][key] = v;
    } else {
      out[sec][key] = v;
    }
  });
  return ({ daemon: out.daemon, policy: out.policy, autonomy: out.autonomy, context: out.context, workspaces: patch.workspaces });
}
async function loadConfig(){
  const r = await j('/api/v1/config');
  if (r && !r.config) { $('cfgGrid').innerHTML='<span class="muted">Control plane unreachable: '+(r.error||'')+'</span>'; $('cfgOut').textContent='unreachable'; return; }
  CFG = r;
  renderConfig();
  $('cfgOut').textContent = 'loaded '+(r.path||'');
}
async function saveConfig(){
  const body = collectConfigPatch();
  const r = await j('/api/v1/config', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r && r.ok===false){ toast('config save failed: '+(r.rejected||[]).map(x=>x.field+' '+x.issues.join('; ')).join(' | ') || r.error, false); $('cfgOut').textContent='FAILED'; return; }
  $('cfgOut').textContent = 'saved · live:'+(r.applied_live||[]).length+' restart:'+(r.applies_on_restart||[]).length;
  toast('config saved'); loadConfig();
}
async function restartDaemons(){
  if (!confirm('Force-kill ALL HELLDESK daemons (control plane, dashboard, NAI ExcellenceGovernor, test daemons) and restart them? The page may drop briefly.')) return;
  const btn=$('restartBtn'); btn.disabled=true; btn.textContent='⟳ restarting…';
  const r = await j('/api/system/restart', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  if (r && r.ok){ toast('restarting all daemons…'); setTimeout(()=>{ location.reload(); }, 2500); }
  else { toast('restart failed: '+(r&&r.error), false); }
  btn.disabled=false; btn.textContent='⟳ Force-restart daemons';
}

// health + polling
async function health(){ const h=await j('/health'); $('healthdot').className='dot'+(h&&h.ok?'':' red'); $('health').textContent=(h&&h.ok)?'online':'offline'; }
// chat: Enter to send
$('chatInput').addEventListener('keydown',e=>{ if(e.key==='Enter') frontDeskSend(); });
health(); loadAll(); loadProject(); loadConfig(); POLL=setInterval(()=>{ health(); loadAll(); }, 4000);
</script>
</body>
</html>`;
}