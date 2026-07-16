# CODE-MAP — contraction-timer

_Last verified: 2026-07-16_

Two-file app: static page on GitHub Pages + Cloudflare Worker for cross-device sync.

- **`index.html`** — the whole app (vanilla JS, no build). Key symbols:
  - `pull` / `pushState` / `applyRemote` / `touch` — sync protocol: full-state last-write-wins, `revision` = `Date.now()` of last local mutation; poll every `POLL_MS` (4s) + on visibility/online.
  - `updateMainUI` — single place button/timer reflect `active`; called for both local taps and remote adoption. `tick` interval guard lives here.
  - Sync room comes from `#r=<id>` URL fragment (kept out of this public repo on purpose), then persisted in `localStorage[ROOM_KEY]`. No fragment ever seen → local-only mode.
  - `localStorage` v2 schema `{revision, contractions, active}`; one-shot migration from v1 in `load()`.
- **`worker/index.js`** — Cloudflare Worker `contraction-sync` (account davidsen908, KV binding `STATE`). GET/PUT `/state/:room`, CORS `*`, validates JSON + numeric `revision`. Deploy: `npx wrangler deploy` (needs `wrangler login`).

Gotchas:
- KV is eventually consistent cross-colo (up to ~60s); same-household devices hit the same colo so sync is effectively instant. Don't "fix" apparent staleness when testing from different networks.
- Conflict model is wholesale LWW — two devices mutating in the same poll window can clobber one tap. Accepted: one person logs in practice.
- Worker PUTs can return CF edge error 1042 for ~1 min right after a fresh deploy — transient, retry.
