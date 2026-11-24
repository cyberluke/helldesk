# M4 — BrowserOS Neo dashboard capture

The dashboard demo uses the **BrowserOS Neo MCP** (`browseros` remote in the
global Kilo config, MCP allowed for the mutation agent), not Playwright and not
a separate Chrome automation stack.

The M2/M3 visual acceptance gate is also BrowserOS Neo:
`benchmarks/v0/visual-gate-spec.ts` builds the candidate, serves the production
preview, and uses the granular MCP `evaluate` and `screenshot` tools. There is
no Playwright in the benchmark path.

## Start the isolated demo

```powershell
benchmarks\v0\dashboard\start-demo.ps1
```

This copies the latest M3 regression proof DB into a throwaway data dir,
registers the proof workspace, starts the benchmark control plane on `:4791`,
and starts a second local-live dashboard on `:8792` with
`HELLDESK_CONTROL_CONFIG` pointing at the benchmark config. Production
`services/helldesk/local/config.json` and the production daemon on `:4790` are
untouched.

Stop it with:

```powershell
benchmarks\v0\dashboard\stop-demo.ps1
```

## BrowserOS Neo session rules

- Call `tabs action="list"` first on every new connection; record the group id
  for `127.0.0.1:8792`.
- Reuse `ownership === "mine"` pages by URL. Never trust a page id from an
  earlier call; re-derive it with `browser.pages.list()`.
- If the page is gone, `tabs action="new"` with the remembered `groupId`. If the
  group closed with its last tab, open a new tab, create a new group, and update
  the remembered id.
- Keep each `run` under its 30s cap. On timeout, re-list tabs, re-derive by URL,
  and retry once. Use `waitForSelector`/`waitForText` with `matched`, not blind
  sleeps.
- Activate the tab for capture with `page.cdp("Page.bringToFront", "{}")`.
- Never act on `ownership: "user"` or `"other-agent"` tabs.

The exact demo driving code is in `browseros-demo.ts`; the M4 page capture is in
`capture-dashboard.ts`; the saved skill is `/neo-helldesk-dashboard-demo`.

## Capture

The BrowserOS OS window is the cockpit, not the dashboard page. Desktop capture
therefore picks up the cockpit (or whatever window is in front, e.g. a personal
ChatGPT window) instead of the dashboard. The M4 video is captured the reliable
way: each demo state is a real page capture through the granular MCP
`screenshot` tool, then assembled with ffmpeg.

```powershell
# Demo must be running (start-demo.ps1) on :8792.
bun run benchmarks/v0/dashboard/capture-dashboard.ts
benchmarks/v0/dashboard/assemble-video.ps1
```

`capture-dashboard.ts` opens one BrowserOS page, navigates the hash router
in-page (`location.hash`, because the granular `navigate` tool blocks on
hash-only SPA routes), and captures:

- Overview (proof feed)
- Kanban (proof card in review, awaiting acceptance)
- Transcript top (`VERIFIED_10_10`)
- Transcript scrolled to the functional regression blocker
- CSS repair diff with the fabricated browser-gate claim
- Observability (verified mission and cycle metrics)

`assemble-video.ps1` holds each page capture for 6s with 0.5s crossfades:
33.5s, 1920x1080, H.264. `make-gif.ps1` converts that local MP4 into the
committed 480x270 animated GIF (671 KB); the WebP is a 135 KB alternate. MP4 is
LFS, so the source stays local and the GIF/WebP are the committed demo.

Recorded M4 evidence:

- `media/dashboard-demo.gif` — 33.5s 480x270 animated GIF, GitHub inline
- `media/dashboard-demo.webp` — 33.5s 480x270 135 KB alternate
- `media/dashboard-demo.mp4` — 33.5s 1920x1080 source, local only
- `media/dashboard-overview.png` — proof mission verified in the feed
- `media/dashboard-kanban.png` — proof card in review, awaiting acceptance
- `media/dashboard-verified.png` — transcript top, `VERIFIED_10_10`
- `media/dashboard-transcript.png` — PASS/FINDINGS transcript
- `media/dashboard-diff.png` — CSS repair diff and fabricated browser-gate claim
- `media/dashboard-observability.png` — verified/cycle metrics

`record-window.ps1` remains available for a desktop capture only when the
BrowserOS page window (not the cockpit) is foreground; it is not the M4 media
path and its output must be inspected before use.

Proof mission: `mis_a1b1beb2914447ada9f00a616c3eb2bc`
Proof run: `.local/benchmark/v0/m3-regression-proof/2026-11-24T00-29-25-787Z`

## Reconnect evidence

During M4 the tab group's last page was closed, `tabs action="list"` showed no
pages, and reopening created a new ungrouped page. A new group
`FD41F0200E72C7C9DBA6B0FD587DDF73` was created for it. That is the expected
reconnect behavior: page ids are not durable; the URL and ownership are, and
the group id is refreshed when the old group is gone.
