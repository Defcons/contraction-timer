// Baby tracker sync worker — stores one JSON state blob per room in KV,
// plus web push subscriptions and a cron that evaluates alert rules.
// GET  /state/:room           -> stored JSON or null
// PUT  /state/:room           -> store JSON body (clients merge; last PUT wins per blob)
// POST /subscribe/:room       -> store a push subscription (+ that device's alert prefs)
// POST /unsubscribe/:room     -> remove a push subscription ({endpoint})
// POST /test/:room            -> send a test notification to all of the room's devices
// POST /status/:room          -> { lastCron, devices, subscribed } diagnostics ({endpoint} optional)
// POST /log/:room             -> append one entry server-side (Home Assistant etc.):
//                                {type:'diaper'|'bottle'|'nurse'|'sleep'|'solid'|'med', ...fields, ago_min?, note?, by?}
// GET  /summary/:room         -> small JSON for external sensors (gaps, today counts)
// GET  /archive/:room         -> { months: ["2026-07", ...] }
// GET  /archive/:room/:month  -> archived entries for that month
// KV: room:<id> = hot state, subs:<id> = {"<hash>": {endpoint, keys, alerts?}} (one blob
//     per room; legacy sub:<id>:<hash> keys are lazily migrated in), subsrooms = [room,...],
//     alerted:<id> = {"<hash>:<rule>": lastFiredTs}, archive:<id>:<YYYY-MM> = old entries,
//     backup:<id>:<YYYY-MM-DD> = daily snapshots (14 kept), maint:last = date gate,
//     cron:last = last alert-check ts (written at most every 30 min to spare the KV write quota)
//
// Alert rules are PER DEVICE: each subscription carries its own `alerts` config
// (uploaded by the client); a sub without one falls back to the room state's
// legacy shared `alerts` so old clients keep working.

import { sendPush } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SUBJECT = 'mailto:davidsen908@gmail.com';
// Re-alert cadence per rule criticality while a condition keeps holding.
// null = fire once per crossing, no repeats. 'alarm' repeats on every cron run.
const REPEAT_MS = { low: null, normal: 30 * 60000, high: 10 * 60000, alarm: 4.5 * 60000 };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function endpointHash(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- subscription storage ----
// One blob per room (subs:<room> = {<endpointHash>: rec}) plus a rooms index
// (subsrooms = [room,...]) so the every-5-min cron reads a couple of keys
// instead of LIST-scanning — KV free tier allows only 1k lists/day and the
// old scheme burned ~600/day here alone. Legacy per-sub keys (sub:<room>:<id>)
// are migrated lazily on first access and then deleted.
async function getSubs(env, room) {
  const raw = await env.STATE.get('subs:' + room);
  if (raw !== null) { try { return JSON.parse(raw); } catch { return {}; } }
  const map = {};
  const legacy = await env.STATE.list({ prefix: `sub:${room}:` });
  for (const k of legacy.keys) {
    const v = await env.STATE.get(k.name);
    if (v) { try { map[k.name.split(':')[2]] = JSON.parse(v); } catch {} }
  }
  await env.STATE.put('subs:' + room, JSON.stringify(map));
  for (const k of legacy.keys) await env.STATE.delete(k.name);
  return map;
}
const putSubs = (env, room, map) => env.STATE.put('subs:' + room, JSON.stringify(map));
async function addRoomToIndex(env, room) {
  let rooms = [];
  try { rooms = JSON.parse((await env.STATE.get('subsrooms')) || '[]'); } catch {}
  if (!rooms.includes(room)) { rooms.push(room); await env.STATE.put('subsrooms', JSON.stringify(rooms)); }
}
async function getRooms(env) {
  const raw = await env.STATE.get('subsrooms');
  if (raw !== null) { try { return JSON.parse(raw); } catch { return []; } }
  // one-time discovery from legacy per-sub keys
  const list = await env.STATE.list({ prefix: 'sub:' });
  const rooms = [...new Set(list.keys.map((k) => k.name.split(':')[1]))];
  await env.STATE.put('subsrooms', JSON.stringify(rooms));
  return rooms;
}

// Send payload to every device in the room; prune subscriptions the push
// service reports gone (404/410). Returns per-device statuses.
async function pushRoom(env, room, payload) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const urgency = payload.crit === 'low' ? 'normal' : 'high';
  const subs = await getSubs(env, room);
  const results = [];
  let changed = false;
  for (const [id, sub] of Object.entries(subs)) {
    let status;
    try { status = await sendPush(sub, payload, jwk, SUBJECT, { urgency }); }
    catch { status = 0; }
    if (status === 404 || status === 410) { delete subs[id]; changed = true; }
    results.push(status);
  }
  if (changed) await putSubs(env, room, subs);
  return results;
}

function fmtDur(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// Quiet hours: shared config window (in the family's own timezone) during
// which nothing is sent; conditions still holding fire once the window ends.
export function inQuietHours(alerts, date) {
  const q = alerts && alerts.quiet;
  if (!q || !q.on) return false;
  let cur;
  try {
    cur = date.toLocaleTimeString('en-GB', { timeZone: q.tz || 'Europe/Oslo', hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch { return false; }
  const from = q.from || '22:00', to = q.to || '07:00';
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

// Guardrails for forgotten start/stop timers: a stuck timer silently
// suppresses the feed/awake alerts, so nag about it directly.
const NURSE_TIMER_MS = 2 * 3600000;
const SLEEP_TIMER_MS = 14 * 3600000;

// Mirrors the client's stats logic. Rules with no matching entry ever logged
// stay silent (avoids an alert storm on an empty log).
export function dueAlerts(state, now) {
  const a = state.alerts || {};
  const entries = state.entries || [];
  const active = state.active || {};
  const last = (types) => {
    let best = null;
    for (const e of entries) if (types.includes(e.type)) { const t = e.end || e.start; if (best === null || t > best) best = t; }
    return best;
  };
  const over = (t, rule) => rule && rule.on && t !== null && now - t > rule.min * 60000;
  const crit = (rule) => (rule && rule.crit) || 'normal';
  const due = [];
  if (!active.nurse) { const t = last(['nurse', 'bottle', 'solid']); if (over(t, a.feed)) due.push({ key: 'feed', crit: crit(a.feed), body: `🍼 No feed for ${fmtDur(now - t)}` }); }
  { const t = last(['diaper']); if (over(t, a.diaper)) due.push({ key: 'diaper', crit: crit(a.diaper), body: `💧 No diaper change for ${fmtDur(now - t)}` }); }
  if (!active.sleep) { const t = last(['sleep']); if (over(t, a.awake)) due.push({ key: 'awake', crit: crit(a.awake), body: `☀️ Awake for ${fmtDur(now - t)}` }); }
  if (active.sleep) { const t = active.sleep.start; if (over(t, a.sleep)) due.push({ key: 'sleep', crit: crit(a.sleep), body: `😴 Asleep for ${fmtDur(now - t)}` }); }
  if (active.nurse && now - active.nurse.start > NURSE_TIMER_MS)
    due.push({ key: 'nursetimer', crit: 'normal', body: `🤱 Nurse timer has been running ${fmtDur(now - active.nurse.start)} — forgot to stop it?` });
  if (active.sleep && now - active.sleep.start > SLEEP_TIMER_MS)
    due.push({ key: 'sleeptimer', crit: 'normal', body: `😴 Sleep timer has been running ${fmtDur(now - active.sleep.start)} — forgot to stop it?` });
  return due;
}

export async function checkAlerts(env) { // exported for tests
  const now = Date.now();
  const jwk = JSON.parse(env.VAPID_JWK);
  for (const room of await getRooms(env)) {
    const subsMap = await getSubs(env, room);
    if (!Object.keys(subsMap).length) continue;
    const raw = await env.STATE.get('room:' + room);
    if (!raw) continue;
    let state;
    try { state = JSON.parse(raw); } catch { continue; }
    // evaluate each device's own rules (fallback: the legacy shared config)
    const devices = [];
    for (const [id, sub] of Object.entries(subsMap)) {
      const cfg = sub.alerts || state.alerts || {};
      devices.push({ id, sub, cfg, due: dueAlerts({ ...state, alerts: cfg }, now) });
    }
    const alertedKey = 'alerted:' + room;
    let alerted = {};
    try { alerted = JSON.parse((await env.STATE.get(alertedKey)) || '{}'); } catch {}
    let changed = false;
    const dueKeys = new Set(); // "<deviceId>:<rule>" entries currently due
    for (const dev of devices) for (const d of dev.due) dueKeys.add(`${dev.id}:${d.key}`);
    for (const k of Object.keys(alerted)) {
      if (!dueKeys.has(k)) { delete alerted[k]; changed = true; } // condition reset -> next crossing alerts immediately
    }
    let subsChanged = false;
    for (const dev of devices) {
      if (inQuietHours(dev.cfg, new Date(now))) continue; // per-device quiet hours
      for (const d of dev.due) {
        const ak = `${dev.id}:${d.key}`;
        const repeat = REPEAT_MS[d.crit] ?? REPEAT_MS.normal;
        if (alerted[ak] && (repeat === null || now - alerted[ak] < repeat)) continue;
        let status;
        try {
          status = await sendPush(dev.sub, { title: 'Baby Tracker', body: d.body, tag: 'bt-' + d.key, crit: d.crit }, jwk, SUBJECT, { urgency: d.crit === 'low' ? 'normal' : 'high' });
        } catch { status = 0; }
        if (status === 404 || status === 410) { delete subsMap[dev.id]; subsChanged = true; }
        alerted[ak] = now;
        changed = true;
      }
    }
    if (subsChanged) await putSubs(env, room, subsMap);
    if (changed) await env.STATE.put(alertedKey, JSON.stringify(alerted));
  }
  // heartbeat for the in-app status line; throttled to respect the KV write quota
  try {
    const last = +(await env.STATE.get('cron:last')) || 0;
    if (now - last > 30 * 60000) await env.STATE.put('cron:last', String(now));
  } catch {}
}

// Daily (gated by maint:last) per-room housekeeping:
// 1. snapshot the hot state to backup:<room>:<date>, keep 14 days
// 2. move entries older than 35 days into monthly archive keys and set the
//    archivedBefore watermark so clients drop them from their hot copies
const HOT_DAYS = 35;
const BACKUP_KEEP_DAYS = 14;

async function dailyMaintenance(env) {
  const today = new Date().toISOString().slice(0, 10);
  if ((await env.STATE.get('maint:last')) === today) return;
  await env.STATE.put('maint:last', today); // claim before working: at most one run/day
  const now = Date.now();
  const cut = now - HOT_DAYS * 86400000;
  const backupCut = new Date(now - BACKUP_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const rooms = (await env.STATE.list({ prefix: 'room:' })).keys.map((k) => k.name.slice(5));
  for (const room of rooms) {
    const raw = await env.STATE.get('room:' + room);
    if (!raw) continue;
    await env.STATE.put(`backup:${room}:${today}`, raw);
    const backups = await env.STATE.list({ prefix: `backup:${room}:` });
    for (const k of backups.keys) {
      if (k.name.split(':')[2] < backupCut) await env.STATE.delete(k.name);
    }
    let s;
    try { s = JSON.parse(raw); } catch { continue; }
    const entries = s.entries || [];
    const old = entries.filter((e) => e.start < cut);
    if (!old.length) continue;
    const byMonth = {};
    for (const e of old) (byMonth[new Date(e.start).toISOString().slice(0, 7)] ||= []).push(e);
    for (const [mon, list] of Object.entries(byMonth)) {
      const akey = `archive:${room}:${mon}`;
      let arch = [];
      try { arch = JSON.parse((await env.STATE.get(akey)) || '[]'); } catch {}
      const ids = new Set(arch.map((e) => e.id));
      for (const e of list) if (!ids.has(e.id)) arch.push(e);
      arch.sort((x, y) => x.start - y.start);
      await env.STATE.put(akey, JSON.stringify(arch));
    }
    s.entries = entries.filter((e) => e.start >= cut);
    s.archivedBefore = Math.max(s.archivedBefore || 0, cut);
    if (s.deleted) for (const id of Object.keys(s.deleted)) if (s.deleted[id] < cut) delete s.deleted[id];
    s.revision = now;
    await env.STATE.put('room:' + room, JSON.stringify(s));
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(state|subscribe|unsubscribe|test|status|log|summary|archive)\/([a-z0-9-]{8,64})(?:\/(\d{4}-\d{2}))?$/i);
    if (!m) return new Response('not found', { status: 404, headers: CORS });
    const [, action, roomRaw, month] = m;
    const room = roomRaw.toLowerCase();
    const key = 'room:' + room;

    if (action === 'archive' && req.method === 'GET') {
      if (!month) {
        const list = await env.STATE.list({ prefix: `archive:${room}:` });
        return json({ months: list.keys.map((k) => k.name.split(':')[2]).sort() });
      }
      const val = await env.STATE.get(`archive:${room}:${month}`);
      return new Response(val || '[]', {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (action === 'state' && req.method === 'GET') {
      const val = await env.STATE.get(key);
      return new Response(val || 'null', {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (action === 'state' && req.method === 'PUT') {
      const text = await req.text();
      if (text.length > 500000) return new Response('too large', { status: 413, headers: CORS });
      try {
        const d = JSON.parse(text);
        if (typeof d.revision !== 'number') throw 0;
      } catch {
        return new Response('bad json', { status: 400, headers: CORS });
      }
      await env.STATE.put(key, text);
      return new Response('ok', { headers: CORS });
    }

    if (action === 'subscribe' && req.method === 'POST') {
      let sub;
      try {
        sub = JSON.parse(await req.text());
        if (!/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1024) throw 0;
        if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') throw 0;
      } catch {
        return new Response('bad subscription', { status: 400, headers: CORS });
      }
      const id = await endpointHash(sub.endpoint);
      const rec = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
      // per-device alert prefs ride along with the subscription
      if (sub.alerts && typeof sub.alerts === 'object' && JSON.stringify(sub.alerts).length <= 4096) rec.alerts = sub.alerts;
      const subs = await getSubs(env, room);
      // clients re-POST on every load — skip the write when nothing changed
      if (JSON.stringify(subs[id]) !== JSON.stringify(rec)) { subs[id] = rec; await putSubs(env, room, subs); }
      await addRoomToIndex(env, room);
      return new Response('ok', { headers: CORS });
    }

    if (action === 'unsubscribe' && req.method === 'POST') {
      let endpoint;
      try { endpoint = JSON.parse(await req.text()).endpoint; if (typeof endpoint !== 'string') throw 0; } catch {
        return new Response('bad json', { status: 400, headers: CORS });
      }
      const subs = await getSubs(env, room);
      const id = await endpointHash(endpoint);
      if (subs[id]) { delete subs[id]; await putSubs(env, room, subs); }
      return new Response('ok', { headers: CORS });
    }

    // Append one entry without the client merge dance — for Home Assistant &
    // friends. Room id is the credential (same trust model as PUT /state).
    // Tiny race vs a concurrent stale client PUT is accepted (clients repair
    // their own entries via merge; family-scale odds are negligible).
    if (action === 'log' && req.method === 'POST') {
      let d;
      try { d = JSON.parse(await req.text()); } catch { return new Response('bad json', { status: 400, headers: CORS }); }
      const raw = await env.STATE.get(key);
      if (!raw) return new Response('unknown room', { status: 404, headers: CORS });
      let state;
      try { state = JSON.parse(raw); } catch { return new Response('corrupt state', { status: 500, headers: CORS }); }
      const now = Date.now();
      const ago = Math.min(Math.max(+d.ago_min || 0, 0), 720) * 60000;
      const by = ((typeof d.by === 'string' && d.by.trim()) || 'Home Assistant').slice(0, 16);
      const num = (v, lo, hi) => { const n = +v; return isFinite(n) && n >= lo && n <= hi ? n : null; };
      let e = null;
      if (d.type === 'diaper') {
        e = { id: 'd' + now, type: 'diaper', start: now - ago, kind: ['wet', 'dirty', 'both'].includes(d.kind) ? d.kind : 'wet' };
      } else if (d.type === 'bottle') {
        const amount = num(d.amount, 1, 500);
        if (amount === null) return new Response('bad amount', { status: 400, headers: CORS });
        e = { id: 'b' + now, type: 'bottle', start: now - ago, amount, unit: d.unit === 'oz' ? 'oz' : 'ml' };
        if (['formula', 'breast', 'mixed'].includes(d.milk)) e.milk = d.milk;
      } else if (d.type === 'nurse' || d.type === 'sleep') {
        const dur = num(d.duration_min, 1, d.type === 'nurse' ? 180 : 960);
        if (dur === null) return new Response('bad duration_min', { status: 400, headers: CORS });
        const end = now - ago;
        const start = end - dur * 60000;
        e = { id: (d.type === 'nurse' ? 'n' : 's') + start, type: d.type, start, end, duration: end - start };
        if (d.type === 'nurse') e.side = ['L', 'R', 'both'].includes(d.side) ? d.side : 'both';
      } else if (d.type === 'solid') {
        if (typeof d.food !== 'string' || !d.food.trim()) return new Response('bad food', { status: 400, headers: CORS });
        e = { id: 'f' + now, type: 'solid', start: now - ago, food: d.food.trim().slice(0, 120) };
      } else if (d.type === 'med') {
        if (typeof d.name !== 'string' || !d.name.trim()) return new Response('bad name', { status: 400, headers: CORS });
        e = { id: 'm' + now, type: 'med', start: now - ago, name: d.name.trim().slice(0, 60) };
      } else {
        return new Response('bad type', { status: 400, headers: CORS });
      }
      if (typeof d.note === 'string' && d.note.trim()) e.note = d.note.trim().slice(0, 120);
      e.mt = now;
      e.by = by;
      state.entries = state.entries || [];
      state.entries.push(e);
      state.revision = now;
      await env.STATE.put(key, JSON.stringify(state));
      return json({ ok: true, entry: e });
    }

    if (action === 'summary' && req.method === 'GET') {
      const raw = await env.STATE.get(key);
      if (!raw) return new Response('unknown room', { status: 404, headers: CORS });
      let s;
      try { s = JSON.parse(raw); } catch { return json({ ok: false }, 500); }
      const now = Date.now();
      const entries = s.entries || [];
      const last = (types) => { let best = null; for (const e of entries) if (types.includes(e.type)) { const t = e.end || e.start; if (best === null || t > best) best = t; } return best; };
      let lastDiaper = null, lastDiaperKind = null;
      for (const e of entries) if (e.type === 'diaper' && (lastDiaper === null || e.start > lastDiaper)) { lastDiaper = e.start; lastDiaperKind = e.kind || null; }
      const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo' });
      const today = dayFmt.format(new Date(now));
      const todays = entries.filter((e) => { try { return dayFmt.format(new Date(e.start)) === today; } catch { return false; } });
      const min = (t) => (t === null ? null : Math.round((now - t) / 60000));
      const sleeping = !!(s.active && s.active.sleep);
      return json({
        baby: (s.baby && s.baby.name) || null,
        sleeping,
        nursing: !!(s.active && s.active.nurse),
        sinceFeedMin: s.active && s.active.nurse ? 0 : min(last(['nurse', 'bottle', 'solid'])),
        sinceDiaperMin: min(lastDiaper),
        lastDiaperKind,
        awakeMin: sleeping ? null : min(last(['sleep'])),
        asleepMin: sleeping ? min(s.active.sleep.start) : null,
        todayFeeds: todays.filter((e) => ['nurse', 'bottle', 'solid'].includes(e.type)).length,
        todayDiapers: todays.filter((e) => e.type === 'diaper').length,
        todaySleepMin: Math.round(todays.filter((e) => e.type === 'sleep').reduce((n, e) => n + (e.duration || 0), 0) / 60000),
      });
    }

    if (action === 'status' && req.method === 'POST') {
      let endpoint = null;
      try { endpoint = JSON.parse(await req.text()).endpoint || null; } catch {}
      const subs = await getSubs(env, room);
      const subscribed = typeof endpoint === 'string' ? !!subs[await endpointHash(endpoint)] : false;
      const lastCron = +(await env.STATE.get('cron:last')) || null;
      return json({ lastCron, devices: Object.keys(subs).length, subscribed });
    }

    if (action === 'test' && req.method === 'POST') {
      const statuses = await pushRoom(env, room, {
        title: 'Baby Tracker',
        body: 'Test notification ✓ — push works on this device.',
        tag: 'bt-test',
      });
      return json({ devices: statuses.length, statuses });
    }

    return new Response('method not allowed', { status: 405, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([checkAlerts(env), dailyMaintenance(env)]));
  },
};
