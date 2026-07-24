# Development rules

## Privacy in this PUBLIC repo (MANDATORY)

This repo is public. Never commit personal data — not in files AND not in
commit messages: family member names, birth dates, room ids / share links /
password hashes of new secrets, or anything identifying. Personal
configuration belongs in synced app state (server-side), HA's private
secrets.yaml/config, or gitignored files (like `backups/`). Keep committed
examples name-neutral ("the baby"). The Cloudflare account handle is
unavoidably visible in the workers.dev URLs; don't add more than that.

## Quota-aware design (MANDATORY)

Everything in this repo runs on free tiers (Cloudflare Workers/KV/Pages). Free
quotas are a hard design constraint, not an afterthought — we once burned 87%
of the KV daily *list* quota purely on cron discovery scans.

Whenever code touches a service with a usage quota:

1. **Know the limits per operation class before designing.** Limits are
   per-class, not one pool — e.g. Workers KV free tier: 100k reads/day but
   only 1k writes, 1k deletes, and 1k LISTS/day. The cheap-looking operation
   class is rarely the binding one.
2. **Write the math down.** ops/day = frequency × ops-per-run × device count.
   A "*/5 cron" is 288 runs/day; a 10s poll in one open tab is 8,640
   requests/day. Record the resulting budget in CODE-MAP (see "KV ops
   budget") and keep it under ~20% of every limit so organic growth and
   future features have headroom.
3. **Recurring beats rare.** Any op inside a cron, poll, or per-load hook is
   multiplied by hundreds daily. Optimize those paths first; one-off user
   actions almost never matter.
4. **Standing patterns:**
   - Never LIST in a hot path. Maintain index/blob keys instead (one blob of
     many small records + one index of blobs) and migrate lazily.
   - Skip no-op writes: compare before writing (clients re-send identical
     payloads constantly).
   - Batch bookkeeping: aggregate all of a run's record updates into one
     write.
   - Poll only when useful: skip while `document.hidden`, pull on
     visibilitychange; pick the slowest interval the UX tolerates.
   - Throttle diagnostics/heartbeats (e.g. write at most every 30 min).
5. **Every future change that adds a recurring operation must redo the math**
   and update the CODE-MAP budget — that includes new crons, new polls, new
   devices/apps sharing a namespace, and shortening any interval.
6. **If the budget can't fit under the free tier**, say so explicitly and
   present the trade-off (paid tier vs. redesign) instead of shipping and
   hoping.
