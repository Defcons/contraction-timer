// Pure sync/merge logic for the baby tracker — no DOM, loaded by index.html
// and eval'd by the node test suite.
//
// State shape (all fields optional on the wire; normalizeState fills gaps):
//   { revision, entries[], active:{sleep,nurse}, alerts, alertsRev,
//     deleted:{id:ts}, archivedBefore }
// Entries carry `mt` (last-modified ts) for per-entry conflict resolution and
// optionally `by` (device name). Deletes are tombstones so they survive merge.
// `archivedBefore` is the server-set watermark: entries older than it live in
// monthly archive keys and must not be re-added to the hot state by a merge.

function normalizeState(s) {
  s = s || {};
  return {
    revision: s.revision || 0,
    entries: (s.entries || []).map(e => (e.mt ? e : { ...e, mt: e.start })),
    active: s.active || { sleep: null, nurse: null },
    alerts: s.alerts || null,
    alertsRev: s.alertsRev || 0,
    deleted: s.deleted || {},
    archivedBefore: s.archivedBefore || 0,
  };
}

const TOMBSTONE_TTL = 60 * 86400000;

function mergeState(a, b, now) {
  a = normalizeState(a); b = normalizeState(b);
  now = now || Date.now();
  const archivedBefore = Math.max(a.archivedBefore, b.archivedBefore);

  // tombstones: union, newest delete-ts wins, expire after TTL
  const deleted = {};
  for (const src of [a.deleted, b.deleted])
    for (const [id, ts] of Object.entries(src))
      if (now - ts < TOMBSTONE_TTL && !(deleted[id] >= ts)) deleted[id] = ts;

  // entries: union by id, higher mt wins; drop deleted and archived-away ones
  const byId = new Map();
  for (const e of [...a.entries, ...b.entries]) {
    if (deleted[e.id] !== undefined) continue;
    if (e.start < archivedBefore) continue;
    const prev = byId.get(e.id);
    if (!prev || (e.mt || 0) > (prev.mt || 0)) byId.set(e.id, e);
  }
  const entries = [...byId.values()].sort((x, y) => x.start - y.start);

  // active timers: per slot, last writer (mt, falling back to start) wins;
  // a timer whose stop-entry exists (or was logged then deleted) is over.
  const active = { sleep: null, nurse: null };
  for (const k of ['sleep', 'nurse']) {
    const ca = a.active[k], cb = b.active[k];
    let c = null;
    if (ca && cb) c = (ca.mt || ca.start) >= (cb.mt || cb.start) ? ca : cb;
    else c = ca || cb;
    if (c) {
      const id = (k === 'sleep' ? 's' : 'n') + c.start;
      if (byId.has(id) || deleted[id] !== undefined) c = null;
    }
    active[k] = c;
  }

  // alerts config: small, whole-object last-writer-wins by alertsRev
  const alerts = a.alertsRev >= b.alertsRev ? (a.alerts || b.alerts) : (b.alerts || a.alerts);

  return {
    revision: Math.max(a.revision, b.revision),
    entries,
    active,
    alerts,
    alertsRev: Math.max(a.alertsRev, b.alertsRev),
    deleted,
    archivedBefore,
  };
}

// Order-independent stringify so signatures don't depend on JSON key order.
function sortedStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + sortedStringify(v[k])).join(',') + '}';
}

// Cheap content signature (revision excluded) used to decide, after a merge,
// whether local state and/or the remote copy actually changed.
function stateSig(s) {
  const n = normalizeState(s);
  return sortedStringify([
    n.entries.map(e => [e.id, e.mt || 0]).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    n.deleted,
    n.active,
    n.alerts,
    n.alertsRev,
    n.archivedBefore,
  ]);
}
