// Baby tracker sync worker — stores one JSON state blob per room in KV,
// plus web push subscriptions and a cron that evaluates alert rules.
// GET  /state/:room        -> stored JSON or null
// PUT  /state/:room        -> store JSON body (last write wins by client revision)
// POST /subscribe/:room    -> store a push subscription for this room
// POST /unsubscribe/:room  -> remove a push subscription ({endpoint})
// POST /test/:room         -> send a test notification to all of the room's devices
// KV: room:<id> = state, sub:<id>:<hash> = subscription, alerted:<id> = {rule: lastFiredTs}

import { sendPush } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SUBJECT = 'mailto:davidsen908@gmail.com';
// Re-alert cadence per rule criticality while a condition keeps holding.
// null = fire once per crossing, no repeats.
const REPEAT_MS = { low: null, normal: 30 * 60000, high: 10 * 60000 };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function endpointHash(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function roomSubs(env, room) {
  const list = await env.STATE.list({ prefix: `sub:${room}:` });
  const subs = [];
  for (const k of list.keys) {
    const v = await env.STATE.get(k.name);
    if (v) { try { subs.push({ key: k.name, sub: JSON.parse(v) }); } catch {} }
  }
  return subs;
}

// Send payload to every device in the room; prune subscriptions the push
// service reports gone (404/410). Returns per-device statuses.
async function pushRoom(env, room, payload) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const urgency = payload.crit === 'low' ? 'normal' : 'high';
  const results = [];
  for (const { key, sub } of await roomSubs(env, room)) {
    let status;
    try { status = await sendPush(sub, payload, jwk, SUBJECT, { urgency }); }
    catch { status = 0; }
    if (status === 404 || status === 410) await env.STATE.delete(key);
    results.push(status);
  }
  return results;
}

function fmtDur(ms) {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

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
  return due;
}

async function checkAlerts(env) {
  const now = Date.now();
  const list = await env.STATE.list({ prefix: 'sub:' });
  const rooms = new Set(list.keys.map((k) => k.name.split(':')[1]));
  for (const room of rooms) {
    const raw = await env.STATE.get('room:' + room);
    if (!raw) continue;
    let state;
    try { state = JSON.parse(raw); } catch { continue; }
    const due = dueAlerts(state, now);
    const alertedKey = 'alerted:' + room;
    let alerted = {};
    try { alerted = JSON.parse((await env.STATE.get(alertedKey)) || '{}'); } catch {}
    let changed = false;
    const dueKeys = new Set(due.map((d) => d.key));
    for (const k of Object.keys(alerted)) {
      if (!dueKeys.has(k)) { delete alerted[k]; changed = true; } // condition reset -> next crossing alerts immediately
    }
    for (const d of due) {
      const repeat = REPEAT_MS[d.crit] ?? REPEAT_MS.normal;
      if (alerted[d.key] && (repeat === null || now - alerted[d.key] < repeat)) continue;
      await pushRoom(env, room, { title: 'Baby Tracker', body: d.body, tag: 'bt-' + d.key, crit: d.crit });
      alerted[d.key] = now;
      changed = true;
    }
    if (changed) await env.STATE.put(alertedKey, JSON.stringify(alerted));
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const m = url.pathname.match(/^\/(state|subscribe|unsubscribe|test)\/([a-z0-9-]{8,64})$/i);
    if (!m) return new Response('not found', { status: 404, headers: CORS });
    const [, action, roomRaw] = m;
    const room = roomRaw.toLowerCase();
    const key = 'room:' + room;

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
      await env.STATE.put(`sub:${room}:${id}`, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }));
      return new Response('ok', { headers: CORS });
    }

    if (action === 'unsubscribe' && req.method === 'POST') {
      let endpoint;
      try { endpoint = JSON.parse(await req.text()).endpoint; if (typeof endpoint !== 'string') throw 0; } catch {
        return new Response('bad json', { status: 400, headers: CORS });
      }
      await env.STATE.delete(`sub:${room}:${await endpointHash(endpoint)}`);
      return new Response('ok', { headers: CORS });
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
    ctx.waitUntil(checkAlerts(env));
  },
};
