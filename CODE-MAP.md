# CODE-MAP — contraction-timer

_Last verified: 2026-07-18_

Two apps in one repo, each a static page on GitHub Pages + its own Cloudflare Worker for cross-device sync: the contraction timer (root) and the baby activity tracker (`baby/`). They're linked to each other via small nav icons in the header (⏱️ / 🍼) but are otherwise fully independent — separate localStorage keys, separate sync rooms, separate Workers/KV namespaces.

## Contraction timer (root)

- **`index.html`** — the whole app (vanilla JS, no build). Key symbols:
  - `pull` / `pushState` / `applyRemote` / `touch` — sync protocol: full-state last-write-wins, `revision` = `Date.now()` of last local mutation; poll every `POLL_MS` (4s) + on visibility/online.
  - `updateMainUI` — single place button/timer reflect `active`; called for both local taps and remote adoption. `tick` interval guard lives here.
  - Sync room comes from `#r=<id>` URL fragment (kept out of this public repo on purpose), then persisted in `localStorage[ROOM_KEY]`. No fragment ever seen → local-only mode.
  - `localStorage` v2 schema `{revision, contractions, active}`; one-shot migration from v1 in `load()`.
  - Theme: `data-theme` on `<html>`, CSS vars per theme, per-device pref in `localStorage['ctTheme']` (NOT synced). Inline head script applies it pre-paint.
  - Avg window: `#avgWindowSel` picks the span for the two avg stats — a contraction count (`5`/`8`/`10`) or a time span (`15m`/`30m`/`60m`/`120m`); per-device pref in `localStorage['ctAvgWindow']` (NOT synced). `windowSetForGaps`/`windowSetForDuration` resolve it against `contractions`; a 15s interval re-renders while a time-based window is active so contractions age out without a new tap.
  - `editRow`/`deleteRow` — per-row ✎/✕ via event delegation on `#logList` (`data-edit`/`data-del`); edit re-sorts by `start`, both call `touch()` to sync.
  - Deploy habit: snapshot live KV state to `backups/` (gitignored — room id is the credential) BEFORE pushing app changes.
- **`worker/index.js`** — Cloudflare Worker `contraction-sync` (account davidsen908, KV binding `STATE`). GET/PUT `/state/:room`, CORS `*`, validates JSON + numeric `revision`. Deploy: `npx wrangler deploy` (needs `wrangler login`).

Gotchas:
- KV is eventually consistent cross-colo (up to ~60s); same-household devices hit the same colo so sync is effectively instant. Don't "fix" apparent staleness when testing from different networks.
- Conflict model is wholesale LWW — two devices mutating in the same poll window can clobber one tap. Accepted: one person logs in practice.
- Worker PUTs can return CF edge error 1042 for ~1 min right after a fresh deploy — transient, retry.

## Baby activity tracker (`baby/`)

Same architecture as the contraction timer (local-first, `localStorage` + poll-based LWW sync), extended to several activity *types* instead of one.

- **`baby/index.html`** — vanilla JS, no build. Key symbols:
  - Entry shape: `{id, type, start, end?, duration?, note?, ...type-specific fields}`; `type` is one of `sleep`/`nurse`/`bottle`/`diaper`/`solid`. `nurse` has `side` (`L`/`R`/`both`); `bottle` has `amount`/`unit`/`milk`; `diaper` has `kind` (`wet`/`dirty`/`both`); `solid` has `food`.
  - `active = { sleep, nurse }` — two independent in-progress timers (mirrors the contraction timer's single `active`, just two of them since sleep and nursing can each be running/tracked concurrently). Sleep/Nurse buttons toggle start↔stop directly, no modal. Bottle/Diaper/Solids are instantaneous events logged via a small modal (time defaults to now, editable).
  - `pull`/`pushState`/`applyRemote`/`touch` — identical sync protocol to the contraction timer, but its own room/localStorage keys (`babySyncRoom_v1`, `babyLog_v1`) and its own Worker (`SYNC_URL`), so the two apps' sync rooms are unrelated even if the same room id string is reused.
  - `editRow`/`deleteRow` — same delegation pattern as the contraction timer; `editRow` shows/hides field groups (`editEndWrap`, `editSideWrap`, `editAmountWrap`, `editMilkWrap`, `editKindWrap`, `editFoodWrap`) based on `entries[i].type`.
  - Theme: `localStorage['btTheme']` (separate from the contraction timer's `ctTheme`, per-device, NOT synced).
- **`baby-worker/index.js`** + **`baby-worker/wrangler.toml`** — separate Cloudflare Worker `baby-tracker-sync` (account davidsen908), its own KV namespace `BABY_STATE` (bound as `STATE` — binding name must stay `STATE` to match `env.STATE` in the worker code). Same GET/PUT `/state/:room` contract as the contraction timer's worker. Deploy: `npx wrangler deploy` from `baby-worker/` (needs `wrangler login`).
- To share the baby tracker across devices, open `baby/#r=<room-id>` once per device (same convention as the contraction timer's `#r=` link, kept out of this public repo).
