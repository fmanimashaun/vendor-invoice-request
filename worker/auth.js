// Authentication.
//
// Two paths, one session representation:
//   client   -> Cloudflare Access (Entra ID or Zoho via SAML). Access puts a
//                 signed JWT in Cf-Access-Jwt-Assertion; we verify it against
//                 the team's public keys and match the email to a users row.
//   Vendors    -> email + password. PBKDF2-HMAC-SHA256 via SubtleCrypto
//                 (bcrypt/argon2 need WASM in Workers). Session is an HMAC
//                 -signed token in an HttpOnly cookie.
//
// In both cases the IdP proves WHO you are; the users table decides WHAT you
// may do. Roles are never read from IdP group claims.

const PBKDF2_ITERATIONS = 210_000; // OWASP guidance for PBKDF2-HMAC-SHA256.
                                   // Re-check this number periodically; it rises.
const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const SESSION_COOKIE = 'session';

const enc = new TextEncoder();
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDecode = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// ── Passwords ─────────────────────────────────────────────────────────

export async function hashPassword(password, saltB64 = null, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? b64uDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return { hash: b64u(bits), salt: b64u(salt), iterations };
}

/** Constant-time-ish comparison. Both inputs are fixed-length base64url. */
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, user) {
  if (!user?.pw_hash || !user?.pw_salt || !user?.pw_iterations) return false;
  const { hash } = await hashPassword(password, user.pw_salt, user.pw_iterations);
  return sameString(hash, user.pw_hash);
}

// ── Session tokens (HMAC-SHA256) ──────────────────────────────────────

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(payload, secret) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const data = b64u(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return `${data}.${b64u(sig)}`;
}

export async function readSession(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uDecode(sig), enc.encode(data));
  if (!ok) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(b64uDecode(data)));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function sessionCookie(token, { clear = false } = {}) {
  const base = `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// ── Cloudflare Access JWT ─────────────────────────────────────────────

let jwksCache = { keys: null, at: 0 };

async function accessKeys(teamDomain) {
  const fresh = Date.now() - jwksCache.at < 60 * 60 * 1000;
  if (jwksCache.keys && fresh) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { keys, at: Date.now() };
  return keys;
}

/**
 * Verify the Cf-Access-Jwt-Assertion header. Returns the claims or null.
 * `aud` must be the Access application AUD tag — without checking it, a token
 * minted for any other app in the same team would be accepted here.
 */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(h)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const jwk = (await accessKeys(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDecode(s), enc.encode(`${h}.${p}`));
  if (!ok) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64uDecode(p)));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return null;
  if (claims.nbf && claims.nbf > now) return null;

  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud || !audList.includes(aud)) return null;

  if (!claims.email) return null;
  return claims;
}

/**
 * Resolve the caller to a users row, or null.
 * Access is tried first so client staff never see a password box.
 */
export async function authenticate(request, env) {
  const accessToken = request.headers.get('Cf-Access-Jwt-Assertion');
  if (accessToken && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const claims = await verifyAccessJwt(accessToken, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
    });
    if (claims) {
      const user = await env.DB.prepare(
        `SELECT * FROM users WHERE email = ?1 AND status = 'active'`,
      ).bind(String(claims.email).toLowerCase()).first();
      // No row means no access. We never auto-provision — otherwise every
      // client employee could raise funding requests.
      return user ? { user, via: 'access' } : null;
    }
  }

  const token = cookieValue(request, SESSION_COOKIE);
  const session = await readSession(token, env.SESSION_SECRET);
  if (session?.uid) {
    // The vendor name travels with the session so the UI can show whose
    // organisation the person is acting for.
    const user = await env.DB.prepare(
      `SELECT u.*, v.name AS vendor_name, v.code AS vendor_code, v.status AS vendor_status
         FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id
        WHERE u.id = ?1 AND u.status = 'active'`,
    ).bind(session.uid).first();
    return user ? { user, via: 'password' } : null;
  }

  return null;
}
