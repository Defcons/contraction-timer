// Baby tracker sync worker — stores one JSON state blob per room in KV.
// GET  /state/:room  -> stored JSON or null
// PUT  /state/:room  -> store JSON body (last write wins by client revision)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const m = url.pathname.match(/^\/state\/([a-z0-9-]{8,64})$/i);
    if (!m) return new Response('not found', { status: 404, headers: CORS });
    const key = 'room:' + m[1].toLowerCase();

    if (req.method === 'GET') {
      const val = await env.STATE.get(key);
      return new Response(val || 'null', {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (req.method === 'PUT') {
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

    return new Response('method not allowed', { status: 405, headers: CORS });
  },
};
