# CODE-MAP — baby (apps monorepo)

_Last verified: 2026-07-19_

A family of small baby apps, one folder per app, each a static page on GitHub Pages + its own Cloudflare Worker for cross-device sync. Repo layout:

- **`index.html`** (root) — tiny landing page linking the apps; no logic, reuses either app's saved theme pref.
- **`contraction-tracker/`** — contraction timer (`index.html` + `worker/`).
- **`baby-tracker/`** — feeds/diapers/sleep tracker (`index.html` + `worker/`).

Apps cross-link via small nav icons in the header (⏱️ / 🍼) but are fully independent — separate localStorage keys, separate sync rooms, separate Workers/KV namespaces. Each `worker/` dir contains `index.js` + its own `wrangler.toml`; deploy from inside that dir with `npx wrangler deploy` (needs `wrangler login`, account davidsen908).

History note: the repo began as `contraction-timer` with the timer at the root; it was renamed/restructured 2026-07-19. GitHub Pages URLs moved (`/contraction-timer/` → `/baby/contraction-tracker/`) but localStorage survived since it's keyed by origin, so existing devices kept their sync room + log without re-opening a share link.

## Contraction timer (`contraction-tracker/`)

- **`contraction-tracker/index.html`** — the whole app (vanilla JS, no build). Key symbols:
  - `pull` / `pushState` / `applyRemote` / `touch` — sync protocol: full-state last-write-wins, `revision` = `Date.now()` of last local mutation; poll every `POLL_MS` (4s) + on visibility/online.
  - `updateMainUI` — single place button/timer reflect `active`; called for both local taps and remote adoption. `tick` interval guard lives here.
  - Sync room comes from `#r=<id>` URL fragment (kept out of this public repo on purpose), then persisted in `localStorage[ROOM_KEY]`. No fragment ever seen → local-only mode.
  - `localStorage` v2 schema `{revision, contractions, active}`; one-shot migration from v1 in `load()`.
  - Theme: `data-theme` on `<html>`, CSS vars per theme, per-device pref in `localStorage['ctTheme']` (NOT synced). Inline head script applies it pre-paint.
  - Avg window: `#avgWindowSel` picks the span for the two avg stats — a contraction count (`5`/`8`/`10`) or a time span (`15m`/`30m`/`60m`/`120m`); per-device pref in `localStorage['ctAvgWindow']` (NOT synced). `windowSetForGaps`/`windowSetForDuration` resolve it against `contractions`; a 15s interval re-renders while a time-based window is active so contractions age out without a new tap.
  - `editRow`/`deleteRow` — per-row ✎/✕ via event delegation on `#logList` (`data-edit`/`data-del`); edit re-sorts by `start`, both call `touch()` to sync.
  - Deploy habit: snapshot live KV state to `backups/` (gitignored — room id is the credential) BEFORE pushing app changes.
- **`contraction-tracker/worker/index.js`** — Cloudflare Worker `contraction-sync` (KV binding `STATE`). GET/PUT `/state/:room`, CORS `*`, validates JSON + numeric `revision`.

Gotchas:
- GitHub Pages serves with `Cache-Control: max-age=600`: for up to ~10 min after a push, browsers (and the CDN) can serve the OLD page even though curl from another network sees the new one. Verified symptom: after a password-hash change, the correct new password gets "Wrong password" because the cached page still embeds the old hash — hard-refresh or wait, don't debug the app.
- Changing the baby tracker password moves every device to a different sync room (room id is derived from the password), abandoning the old room's KV state — change it only when the log is empty, or migrate the KV value first.
- KV is eventually consistent cross-colo (up to ~60s); same-household devices hit the same colo so sync is effectively instant. Don't "fix" apparent staleness when testing from different networks.
- Conflict model is wholesale LWW — two devices mutating in the same poll window can clobber one tap. Accepted: one person logs in practice.
- Worker PUTs can return CF edge error 1042 for ~1 min right after a fresh deploy — transient, retry.

## Baby activity tracker (`baby-tracker/`)

Same architecture as the contraction timer (local-first, `localStorage` + poll-based LWW sync), extended to several activity *types* instead of one.

Installable PWA (`manifest.webmanifest`, `sw.js`, generated icon PNGs) with web push alerts: shared alert rules live in the synced state (`alerts` key) and are evaluated **server-side** by the worker's cron so notifications arrive with the app closed; the push subscription itself is per-device.

- **`baby-tracker/index.html`** — vanilla JS, no build. Key symbols:
  - Entry shape: `{id, type, start, end?, duration?, note?, ...type-specific fields}`; `type` is one of `sleep`/`nurse`/`bottle`/`diaper`/`solid`. `nurse` has `side` (`L`/`R`/`both`); `bottle` has `amount`/`unit`/`milk`; `diaper` has `kind` (`wet`/`dirty`/`both`); `solid` has `food`.
  - `active = { sleep, nurse }` — two independent in-progress timers (mirrors the contraction timer's single `active`, just two of them since sleep and nursing can each be running/tracked concurrently). Tapping Sleep/Nurse while *idle* opens that type's modal (`openSleepModal`/`openNurseModal`): "Start timer" OR log an already-finished session via `makeWheel` scroll-snap wheel pickers (nurse: minutes 1–90; sleep: hours 0–16 + minutes step 5) — entry is backdated `end = now, start = end − duration`. Tapping while *running* stops directly, no modal. Bottle/Diaper/Solids are instantaneous events logged via a small modal (time defaults to now, editable).
  - Login gate (`doLogin`/`sha256Hex`): full-screen `#loginOverlay` blocks the app until the shared password is entered; page embeds only `PASS_SHA256` (sha256 of the password — brute-forceable for a short password, accepted: it's bot deterrence, not security). The sync room id is *derived* from the password (`sha256('baby-room-v1:'+pw)` first 32 hex chars) so it never appears in the repo and every signed-in device lands in the same room automatically — no `#r=` link (that mechanism was removed from this app; the contraction timer still uses it). Persisted in `localStorage['babyAuthRoom_v1']`; presence of that key == signed in (no logout UI). `crypto.subtle` needs a secure context — https or localhost.
  - `pull`/`pushState`/`applyRemote`/`touch` — identical sync protocol to the contraction timer, but its own localStorage key (`babyLog_v1`) and its own Worker (`SYNC_URL`), so the two apps' sync rooms are unrelated. State shape: `{revision, entries, active, alerts}`.
  - Alerts UI (`RULES`/`paintAlertRules` + 🔔 modal): four rules — feed/diaper gap, awake-too-long, asleep-too-long — each `{on, min, crit}` (`crit`: `low`=silent/once, `normal`=sound/repeat 30 min, `high`="Nag" sound/repeat 10 min + sticky/renotify on Android; absent crit defaults to normal), stored in synced `alerts` so both phones share config; `defaultAlerts` fills absent config. Push side: `subscribePush`/`ensurePush`/`updatePushUI`, `VAPID_PUBLIC` embedded, per-device enabled flag `localStorage['btPushOn_v1']`; `ensurePush` re-POSTs the subscription on every load to survive push-service rotation. iOS: push only works installed to Home Screen (`isStandalone` check shows the hint).
  - `sw.js` — push + notificationclick handlers, network-first navigation cache (offline fallback only, so deploys are never stale).
  - `renderTimeline` — "Last 24 hours" strip, one lane per type (`TL_TYPES`): bars for sleep/nurse (incl. live `active` timers), dots for bottle/diaper/solid. Re-rendered by `render()` + a 15s interval.
  - `agoOr`/`lastOfType` — "X ago" sub-labels on all five action buttons (refreshed in `updateStats`; running timers own their sub text via `updateActionUI`/`startTick`).
  - `editRow`/`deleteRow` — same delegation pattern as the contraction timer; `editRow` shows/hides field groups (`editEndWrap`, `editSideWrap`, `editAmountWrap`, `editMilkWrap`, `editKindWrap`, `editFoodWrap`) based on `entries[i].type`.
  - Theme: `localStorage['btTheme']` (separate from the contraction timer's `ctTheme`, per-device, NOT synced).
- **`baby-tracker/worker/`** — separate Cloudflare Worker `baby-tracker-sync`, its own KV namespace `BABY_STATE` (bound as `STATE` — binding name must stay `STATE` to match `env.STATE` in the worker code). Same GET/PUT `/state/:room` contract as the contraction timer's worker, plus push:
  - `webpush.js` — dependency-free Web Push sender (`sendPush`/`encryptPayload`/`vapidHeaders`): RFC 8291 aes128gcm + RFC 8292 VAPID via WebCrypto. Verified by an offline encrypt→decrypt round-trip test. VAPID private key = worker secret `VAPID_JWK` (JWK JSON, set via `wrangler secret put`, NEVER in the repo); the public key is embedded in `index.html`. Apple rejects JWTs with exp >24h — we use 12h.
  - `index.js` — `POST /subscribe|unsubscribe|test/:room`; `scheduled` (cron `*/5 * * * *` in wrangler.toml) → `checkAlerts`: finds rooms via KV `sub:<room>:<endpointHash>` keys, evaluates `dueAlerts` (exported for tests; mirrors client stats logic, silent on empty logs, nursing/sleeping suppress feed/awake alerts), dedups via `alerted:<room>` map — fires on crossing, repeats per criticality (`REPEAT_MS`: low never / normal 30 min / high 10 min) while the condition holds, resets when it clears; low-crit pushes go out with `Urgency: normal`. 404/410 push responses prune the subscription.
- To share the baby tracker across devices, just sign in with the shared password on each device (room is derived from it — see login gate above).
