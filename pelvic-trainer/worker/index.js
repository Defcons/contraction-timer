// Pelvic trainer worker — session-log sync + push reminders.
// GET  /state/:room  -> stored JSON or null (session log; merged client-side)
// PUT  /state/:room  -> store JSON body
// POST /subscribe    {endpoint, keys:{p256dh,auth}, times:["09:00",...], tz, room?}
// POST /unsubscribe  {endpoint}
// POST /test         {endpoint} -> send a test push to that device
// GET  /vapid        -> {publicKey}  (derived from the VAPID_JWK secret, so
//                       the app never needs a key baked into its HTML)
// KV: room:<id> = {revision, sessions:[...]},
//     subs = {"<endpointHash>": {endpoint, keys, times, tz, room?, sent:{"HH:MM":"YYYY-MM-DD"}}}
//     (single blob so the cron never LIST-scans; legacy sub:<hash> keys migrate in lazily)
// When a sub carries its room, reminders are skipped once 3 sessions are
// already logged that local day.

import { sendPush } from './webpush.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SUBJECT = 'mailto:davidsen908@gmail.com';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function endpointHash(endpoint) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Public VAPID key for the browser's pushManager.subscribe(), derived from the
// private JWK secret so it never has to be hardcoded client-side.
async function vapidPublicKey(env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const pub = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']
  );
  return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pub)));
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// All subscriptions live in ONE blob so the every-5-min cron costs 1 read
// instead of a LIST scan (KV free tier: only 1k lists/day). Legacy per-sub
// keys are migrated in lazily and deleted.
async function getSubs(env) {
  const raw = await env.STATE.get('subs');
  if (raw !== null) { try { return JSON.parse(raw); } catch { return {}; } }
  const map = {};
  const legacy = await env.STATE.list({ prefix: 'sub:' });
  for (const k of legacy.keys) {
    const v = await env.STATE.get(k.name);
    if (v) { try { map[k.name.slice(4)] = JSON.parse(v); } catch {} }
  }
  await env.STATE.put('subs', JSON.stringify(map));
  for (const k of legacy.keys) await env.STATE.delete(k.name);
  return map;
}
const putSubs = (env, map) => env.STATE.put('subs', JSON.stringify(map));

// Cron (*/5): send each device's due reminders once per local day per slot.
// All sent-map updates aggregate into a single blob write per run.
export async function sendReminders(env, now = new Date()) {
  const subs = await getSubs(env);
  const ids = Object.keys(subs);
  if (!ids.length) return;
  const jwk = JSON.parse(env.VAPID_JWK);
  let blobChanged = false;
  for (const id of ids) {
    const rec = subs[id];
    if (!rec || !Array.isArray(rec.times)) continue;
    let hm, today;
    try {
      hm = new Intl.DateTimeFormat('en-GB', { timeZone: rec.tz || 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      today = new Intl.DateTimeFormat('en-CA', { timeZone: rec.tz || 'Europe/Oslo' }).format(now);
    } catch { continue; } // bad tz: skip rather than spam at wrong times
    const nowMin = +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
    const dueSlots = rec.times.filter((t) => {
      if (!TIME_RE.test(t)) return false;
      const diff = nowMin - (+t.slice(0, 2) * 60 + +t.slice(3, 5));
      return diff >= 0 && diff < 5 && (rec.sent && rec.sent[t]) !== today;
    });
    if (!dueSlots.length) continue;
    // synced session log lets us skip the nudge when today's 3 are already done
    let doneToday = 0;
    if (rec.room) {
      try {
        const st = JSON.parse((await env.STATE.get('room:' + rec.room)) || 'null');
        if (st && Array.isArray(st.sessions)) {
          const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: rec.tz || 'Europe/Oslo' });
          doneToday = st.sessions.filter((s) => { try { return dayFmt.format(new Date(s.ts)) === today; } catch { return false; } }).length;
        }
      } catch {}
    }
    for (const t of dueSlots) {
      (rec.sent ||= {})[t] = today;
      blobChanged = true;
      if (doneToday >= 3) continue; // goal already reached — stay quiet
      let status;
      try {
        status = await sendPush({ endpoint: rec.endpoint, keys: rec.keys },
          { title: 'Pelvic Trainer', body: doneToday ? `🌸 Time for session ${doneToday + 1} of 3 today.` : '🌸 Time for a pelvic floor session — about 3 minutes.', tag: 'pf-remind' },
          jwk, SUBJECT, { urgency: 'high' });
      } catch { status = 0; }
      if (status === 404 || status === 410) { delete subs[id]; blobChanged = true; break; }
    }
  }
  if (blobChanged) await putSubs(env, subs);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname;

    if (path === '/vapid' && req.method === 'GET')
      return json({ publicKey: await vapidPublicKey(env) });

    const sm = path.match(/^\/state\/([a-z0-9-]{8,64})$/i);
    if (sm) {
      const key = 'room:' + sm[1].toLowerCase();
      if (req.method === 'GET') {
        const val = await env.STATE.get(key);
        return new Response(val || 'null', { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      if (req.method === 'PUT') {
        const text = await req.text();
        if (text.length > 200000) return new Response('too large', { status: 413, headers: CORS });
        try {
          const d = JSON.parse(text);
          if (typeof d.revision !== 'number' || !Array.isArray(d.sessions)) throw 0;
        } catch {
          return new Response('bad json', { status: 400, headers: CORS });
        }
        await env.STATE.put(key, text);
        return new Response('ok', { headers: CORS });
      }
    }

    if (path === '/subscribe' && req.method === 'POST') {
      let d;
      try {
        d = JSON.parse(await req.text());
        if (!/^https:\/\//.test(d.endpoint) || d.endpoint.length > 1024) throw 0;
        if (typeof d.keys?.p256dh !== 'string' || typeof d.keys?.auth !== 'string') throw 0;
        if (!Array.isArray(d.times) || d.times.length > 6 || !d.times.every((t) => TIME_RE.test(t))) throw 0;
      } catch {
        return new Response('bad subscription', { status: 400, headers: CORS });
      }
      const rec = { endpoint: d.endpoint, keys: { p256dh: d.keys.p256dh, auth: d.keys.auth }, times: d.times, tz: typeof d.tz === 'string' ? d.tz.slice(0, 64) : 'UTC' };
      if (typeof d.room === 'string' && /^[a-z0-9-]{8,64}$/i.test(d.room)) rec.room = d.room.toLowerCase();
      const subs = await getSubs(env);
      const id = await endpointHash(d.endpoint);
      const prev = subs[id];
      if (prev && prev.sent) rec.sent = prev.sent; // keep today's already-sent markers
      // clients re-POST on every load — skip the write when nothing changed
      if (JSON.stringify(prev) !== JSON.stringify(rec)) { subs[id] = rec; await putSubs(env, subs); }
      return new Response('ok', { headers: CORS });
    }

    if (path === '/unsubscribe' && req.method === 'POST') {
      let endpoint;
      try { endpoint = JSON.parse(await req.text()).endpoint; if (typeof endpoint !== 'string') throw 0; } catch {
        return new Response('bad json', { status: 400, headers: CORS });
      }
      const subs = await getSubs(env);
      const id = await endpointHash(endpoint);
      if (subs[id]) { delete subs[id]; await putSubs(env, subs); }
      return new Response('ok', { headers: CORS });
    }

    if (path === '/test' && req.method === 'POST') {
      let endpoint;
      try { endpoint = JSON.parse(await req.text()).endpoint; if (typeof endpoint !== 'string') throw 0; } catch {
        return new Response('bad json', { status: 400, headers: CORS });
      }
      const rec = (await getSubs(env))[await endpointHash(endpoint)];
      if (!rec) return json({ ok: false, error: 'not subscribed' }, 404);
      let status;
      try {
        status = await sendPush({ endpoint: rec.endpoint, keys: rec.keys },
          { title: 'Pelvic Trainer', body: 'Test notification ✓ — reminders work on this device.', tag: 'pf-test' },
          JSON.parse(env.VAPID_JWK), SUBJECT, { urgency: 'high' });
      } catch { status = 0; }
      return json({ ok: status >= 200 && status < 300, status });
    }

    return new Response('not found', { status: 404, headers: CORS });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};
