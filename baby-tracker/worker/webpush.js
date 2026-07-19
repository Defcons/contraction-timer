// Minimal Web Push sender for Cloudflare Workers: VAPID (RFC 8292) +
// aes128gcm payload encryption (RFC 8291/8188). WebCrypto only, no deps.
// Also imported by the node round-trip test — keep it runtime-agnostic.

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// RFC 8291: encrypt payload for a subscription's p256dh + auth keys.
export async function encryptPayload(plaintext, p256dhB64, authB64) {
  const uaPub = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, ephPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last record delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); // rs
  header[20] = 65;
  header.set(ephPub, 21);
  return concat(header, ct);
}

// RFC 8292 VAPID: ES256 JWT over the push service origin.
export async function vapidHeaders(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${payload}`)));
  const jwt = `${header}.${payload}.${b64url(sig)}`;
  const pubRaw = concat(new Uint8Array([4]), b64urlDecode(jwk.x), b64urlDecode(jwk.y));
  return { Authorization: `vapid t=${jwt}, k=${b64url(pubRaw)}` };
}

// Send one push. Returns the push service's HTTP status.
export async function sendPush(sub, payloadObj, jwk, subject, { ttl = 3600, urgency = 'high' } = {}) {
  const body = await encryptPayload(JSON.stringify(payloadObj), sub.keys.p256dh, sub.keys.auth);
  const auth = await vapidHeaders(sub.endpoint, jwk, subject);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      ...auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return res.status;
}
