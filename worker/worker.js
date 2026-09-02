// Vendor Invoice Request Platform — Worker.
//
// The client raises a request. Every onboarded vendor sees one pending queue;
// whichever approves first takes it,
// and only then does an invoice number get reserved and a PDF become available.
//
// Two invariants worth not breaking:
//   1. An invoice row is created only by a vendor session (`requireOrg`).
//      No row, no PDF — that is what stops client issuing a document on
//      a vendor letterhead.
//   2. The invoice number is assigned at approval, never at request time, so a
//      rejected request cannot leave a gap in the issued sequence.

import {
  authenticate, resolveContext, hashPassword, verifyPassword, verifyAccessJwt,
  signSession, sessionCookie,
} from './auth.js';
import { renderInvoice } from './renderInvoice.js';
import { mergeTemplate, validateTemplate, DEFAULT_TEMPLATE } from '../shared/template.js';
import { FONT_CATALOGUE, fontKeys, REQUIRED_GLYPHS, FALLBACK_FONT } from '../shared/fonts.js';
import { checkPassword, PASSWORD_HINT } from '../shared/password.js';
import fontkit from '@pdf-lib/fontkit';
import {
  REQUEST_TYPES,
  typeFor, numberingSiteIn, invoiceRef, instanceEpoch, downloadName, siteNameIn, buNameIn, periodLabel,
  naira,
} from '../shared/reference.js';

/**
 * Business units, sites and the BU->sites map, from D1.
 *
 * Deliberately NOT cached. The client admin edits these from the Settings
 * page and the change has to show up on the next request; at ~23 requests a
 * month, three small reads per call is nothing, and a stale isolate serving a
 * site that was just disabled is a worse problem than the reads. Revisit only
 * if volume changes by orders of magnitude.
 */
async function loadReference(env) {
  const [bus, sites, links] = await Promise.all([
    env.DB.prepare('SELECT * FROM business_units ORDER BY code').all(),
    env.DB.prepare('SELECT * FROM sites ORDER BY name').all(),
    env.DB.prepare('SELECT * FROM bu_sites').all(),
  ]);
  const buSites = {};
  for (const l of links.results || []) (buSites[l.bu_code] ||= []).push(l.site_code);
  return {
    businessUnits: bus.results || [],
    sites: sites.results || [],
    buSites,
  };
}

/** Only what a requester may raise against: disabled rows stay readable but unusable. */
const activeOnly = (ref) => ({
  businessUnits: ref.businessUnits.filter((b) => b.status === 'active'),
  sites: ref.sites.filter((s) => s.status === 'active'),
  buSites: Object.fromEntries(
    Object.entries(ref.buSites).map(([bu, codes]) => [
      bu, codes.filter((c) => ref.sites.find((s) => s.code === c)?.status === 'active'),
    ]),
  ),
});

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

const fail = (code, message, status = 400, extra = {}) =>
  json({ error: code, message, ...extra }, status);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      // Static SPA assets.
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return fail('server_error', 'Something went wrong.', 500);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  // ── Public ──────────────────────────────────────────────────────────
  if (path === '/api/auth/methods' && method === 'GET') return authMethods(env);
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);

  // client SSO landing. This is the ONLY path that needs a Cloudflare Access
  // policy in front of it. Access authenticates the user, we exchange its JWT
  // for our own session cookie, and every later request uses the cookie.
  //
  // Protecting the whole hostname with Access instead would lock vendors out
  // of the password login, since they have no Access identity.
  if (path === '/api/auth/sso' && method === 'GET') return ssoLanding(request, env);

  // ── Everything below needs a session ────────────────────────────────
  const auth = await authenticate(request, env);
  if (!auth) return fail('unauthenticated', 'Sign in to continue.', 401);
  const me = auth.user;

  // An account whose password an admin has just set is in a half-state: the
  // admin necessarily knows the secret, so it is not one yet. Everything is
  // closed until the owner replaces it, EXCEPT the handful of routes needed to
  // do that — the app has to be able to load and render the form.
  //
  // This sits directly after authentication rather than further down, because
  // a guard placed after the routes it is meant to guard protects nothing.
  const OPEN_WHILE_LOCKED = new Set([
    '/api/bootstrap', '/api/me', '/api/auth/password', '/api/auth/logout',
  ]);
  if (me.must_change_password && !OPEN_WHILE_LOCKED.has(path)) {
    return fail('password_change_required',
      'Set a new password before continuing.', 403);
  }

  if (path === '/api/auth/context' && method === 'POST') {
    const me = await authenticate(request, env);
    if (!me) return fail('unauthorised', 'Sign in first.', 401);
    return switchContext(request, env, me.user);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', { clear: true }) });
  }

  if (path === '/api/me' && method === 'GET') {
    return json({ user: publicUser(me), via: auth.via });
  }

  if (path === '/api/bootstrap' && method === 'GET') {
    const cfg = await env.DB.prepare('SELECT * FROM config WHERE id = 1').first();
    // The requester form shows an INDICATIVE fee: which vendor will take the
    // request is not known yet, and the fee is the vendor's. The figure that
    // is actually billed is copied onto the invoice at approval.
    //
    // A vendor is not sent their own config: they have no screen for it and
    // nobody able to change it. The client admin maintains it.
    // The form may only offer active rows; the admin page asks for the full
    // set separately so it can show and restore disabled ones.
    const ref = activeOnly(await loadReference(env));
    return json({
      user: publicUser(me),
      businessUnits: ref.businessUnits,
      sites: ref.sites,
      buSites: ref.buSites,
      requestTypes: REQUEST_TYPES,
      orgName: cfg?.org_name || '',
      mustChangePassword: !!me.must_change_password,
      passwordHint: PASSWORD_HINT,
      feeKobo: cfg?.default_fee_kobo ?? 10000,
      feeIsIndicative: true,
    });
  }

  if (path === '/api/requests' && method === 'GET')   return listRequests(request, env, me, url);
  if (path === '/api/requests' && method === 'POST')  return createRequest(request, env, me);

  let m;
  if ((m = path.match(/^\/api\/requests\/(\d+)\/withdraw$/)) && method === 'POST')
    return withdrawRequest(env, me, +m[1]);
  if ((m = path.match(/^\/api\/requests\/(\d+)\/approve$/)) && method === 'POST')
    return approveRequest(env, me, +m[1]);
  if ((m = path.match(/^\/api\/requests\/(\d+)\/reject$/)) && method === 'POST')
    return rejectRequest(request, env, me, +m[1]);

  if (path === '/api/invoices' && method === 'GET') return listInvoices(env, me);
  if ((m = path.match(/^\/api\/invoices\/(.+)\/pdf$/)) && method === 'GET')
    return invoicePdf(env, me, decodeURIComponent(m[1]));

  if ((m = path.match(/^\/api\/vendors\/(\d+)\/config$/)) && method === 'PUT')
    return updateVendorConfig(request, env, me, Number(m[1]));
  if (path === '/api/summary' && method === 'GET')   return summary(env, me, url);
  if (path === '/api/reference' && method === 'GET')  return adminReference(env, me);
  if (path === '/api/sites' && method === 'POST')     return upsertSite(request, env, me);
  if ((m = path.match(/^\/api\/sites\/([A-Z0-9]+)$/)) && method === 'PUT')
    return upsertSite(request, env, me, m[1]);
  if (path === '/api/business-units' && method === 'POST') return upsertBu(request, env, me);
  if ((m = path.match(/^\/api\/business-units\/([A-Z0-9]+)$/)) && method === 'PUT')
    return upsertBu(request, env, me, m[1]);
  if (path === '/api/bu-sites' && method === 'POST')  return linkBuSite(request, env, me);
  if (path === '/api/platform-config' && method === 'PUT') return updatePlatformConfig(request, env, me);
  if (path === '/api/numbering' && method === 'GET')   return getNumbering(env, me);
  if (path === '/api/sso-config' && method === 'GET')  return getSsoConfig(env, me);
  if (path === '/api/sso-config' && method === 'PUT')  return putSsoConfig(request, env, me);

  if (path === '/api/fonts' && method === 'GET')   return listFonts(env, me);
  if (path === '/api/fonts' && method === 'POST')  return uploadFont(request, env, me);
  if ((m = path.match(/^\/api\/fonts\/([a-z0-9-]+)$/)) && method === 'DELETE')
    return deleteFont(env, me, m[1]);

  if (path === '/api/vendors' && method === 'GET')  return listVendors(env, me);
  if (path === '/api/vendors' && method === 'POST') return createVendor(request, env, me);
  if ((m = path.match(/^\/api\/vendors\/(\d+)\/status$/)) && method === 'POST')
    return setVendorStatus(request, env, me, Number(m[1]));
  if ((m = path.match(/^\/api\/vendors\/(\d+)\/template$/)) && method === 'GET')
    return getVendorTemplate(env, me, Number(m[1]));
  if ((m = path.match(/^\/api\/vendors\/(\d+)\/template$/)) && method === 'PUT')
    return putVendorTemplate(request, env, me, Number(m[1]));
  if ((m = path.match(/^\/api\/vendors\/(\d+)\/template\/preview$/)) && method === 'POST')
    return previewVendorTemplate(request, env, me, Number(m[1]));

  if (path === '/api/users'  && method === 'GET')  return listUsers(env, me, url);
  if (path === '/api/users'  && method === 'POST') return createUser(request, env, me);
  if ((m = path.match(/^\/api\/users\/(\d+)\/status$/)) && method === 'POST')
    return setUserStatus(request, env, me, Number(m[1]));
  if ((m = path.match(/^\/api\/users\/(\d+)\/password$/)) && method === 'POST')
    return resetUserPassword(request, env, me, Number(m[1]));
  if (path === '/api/auth/password' && method === 'POST')
    return changeOwnPassword(request, env, me);


  return fail('not_found', 'No such route.', 404);
}

const publicUser = (u) => ({
  id: u.id, email: u.email, full_name: u.full_name, org: u.org,
  roles: splitRoles(u.roles),
  default_role: u.default_role || splitRoles(u.roles)[0] || null,
  context: u.ctx ?? null,
  vendor_id: u.vendor_id, vendor_name: u.vendor_name, vendor_code: u.vendor_code,
  job_title: u.job_title, phone: u.phone,
  status: u.status, created_at: u.created_at, created_by: u.created_by,
  must_change_password: !!u.must_change_password,
});

const requireOrg = (me, org) =>
  me.org === org ? null : fail('forbidden', `Only ${org} users may do this.`, 403);

/** 'admin,member' -> ['admin','member']. Tolerates spacing and empties. */
const splitRoles = (v) =>
  String(v || '').split(',').map((r) => r.trim()).filter(Boolean);

const hasRole = (u, ...want) => {
  const held = splitRoles(u?.roles);
  return want.some((r) => held.includes(r));
};

/**
 * Passes when the caller is ACTING IN one of the named roles.
 *
 * Deliberately stricter than "holds the role". Someone with both admin and
 * member has to switch context before doing the other job, which keeps a
 * session scoped to one set of powers at a time. `hasRole` is what the error
 * message uses to tell the two failures apart, because "switch context" and
 * "you do not have this role" are very different problems for the user.
 */
const requireRole = (me, ...roles) => {
  if (roles.includes(me.ctx)) return null;
  if (hasRole(me, ...roles)) {
    return fail('wrong_context',
      `You hold this role but are acting as ${me.ctx}. Switch to `
      + `${roles.filter((r) => hasRole(me, r)).join(' or ')} first.`,
      403, { need: roles, acting: me.ctx });
  }
  return fail('forbidden', 'Your role does not allow this.', 403);
};

const CLIENT_ROLES = ['member', 'admin'];
// Vendors have representatives who approve requests and issue invoices, and
// nothing else. There is exactly ONE administrator in the system and it is the
// client's: they onboard vendors, add vendor reps, and maintain every vendor's
// payment and tax details. A vendor has nobody to log in and configure.
const VENDOR_ROLES = ['approver'];

// ── Auth ──────────────────────────────────────────────────────────────

/**
 * Which sign-in methods this deployment offers.
 *
 * Unauthenticated on purpose: the login screen has to render before anyone has
 * a session, and it must not offer a button that cannot work. Nothing here is
 * a secret — it is the same information a user learns by looking at the page.
 *
 * SSO is only advertised when Access is actually configured, so a deployment
 * that has not set ACCESS_TEAM_DOMAIN / ACCESS_AUD does not show a button that
 * would return 503. Either method can be turned off explicitly; turning both
 * off would lock everyone out, so that is refused.
 */
/**
 * How sign-in is configured, resolved once so the login screen, the login route
 * and the SSO landing all agree.
 *
 * Configuration lives in the database, with the wrangler vars as a fallback for
 * a deployment that set them before this existed.
 *
 * The cutover is deliberately two-stage. `sso_enabled` says an admin has set
 * SSO up; `sso_verified_at` says somebody has actually completed a sign-in with
 * it. Client passwords stop working only when BOTH are true. Flipping a switch
 * with a mistyped AUD tag would otherwise lock out the only person who could
 * unflip it, and there is no route back in.
 */
async function authConfig(env) {
  const cfg = await env.DB.prepare('SELECT * FROM config WHERE id = 1').first();
  const teamDomain = cfg?.access_team_domain || env.ACCESS_TEAM_DOMAIN || null;
  const aud = cfg?.access_aud || env.ACCESS_AUD || null;
  const configured = !!(teamDomain && aud);
  const enabled = !!cfg?.sso_enabled && configured;
  const verified = !!cfg?.sso_verified_at;

  return {
    teamDomain,
    aud,
    allowedDomains: cfg?.sso_allowed_domains || env.SSO_ALLOWED_DOMAINS || '',
    ssoConfigured: configured,
    ssoEnabled: enabled,
    ssoVerified: verified,
    // Vendors are never in the client's directory, so their password sign-in
    // is not something SSO can replace.
    clientPassword: !(enabled && verified),
    vendorPassword: true,
    verifiedAt: cfg?.sso_verified_at || null,
  };
}

/**
 * Move this session into another role the account holds.
 *
 * A new cookie is minted rather than a flag flipped somewhere: the context has
 * to be inside the signed session or it is not a boundary, just a suggestion
 * the client could ignore.
 */
async function switchContext(request, env, user) {
  const b = await request.json().catch(() => ({}));
  const want = String(b.role || '');
  if (!hasRole(user, want)) {
    return fail('forbidden', 'You do not hold that role.', 403,
      { roles: splitRoles(user.roles) });
  }
  const token = await signSession({ uid: user.id, ctx: want }, env.SESSION_SECRET);
  user.ctx = want;
  console.warn('CONTEXT_SWITCHED', user.email, want);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function authMethods(env) {
  const a = await authConfig(env);
  return json({
    sso: a.ssoEnabled,
    password: true,                       // vendors always; client until cutover
    clientPassword: a.clientPassword,
    ssoLabel: String(env.SSO_BUTTON_LABEL || 'Sign in with single sign-on'),
    ssoConfigured: a.ssoConfigured,
  });
}

async function login(request, env) {
  const auth = await authConfig(env);
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return fail('bad_request', 'Email and password are required.');

  const user = await env.DB.prepare(
    `SELECT u.*, v.name AS vendor_name, v.code AS vendor_code
       FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id
      WHERE u.email = ?1 AND u.status = 'active'`,
  ).bind(String(email).toLowerCase().trim()).first();

  // Client staff may use a password until SSO is both set up and proven to
  // work; after that their only way in is the identity provider. Vendors are
  // unaffected either way. A check in React is not a control, so the decision
  // is made here.
  if (user?.org === 'client' && !auth.clientPassword) {
    return fail('password_login_disabled',
      'Staff sign-in uses single sign-on. Use the sign-in button instead.', 403);
  }

  // Same response whether the user is absent, disabled, has no password set, or
  // the password is wrong — no account enumeration.
  const ok = user && (await verifyPassword(password, user));
  if (!ok) return fail('bad_credentials', 'Email or password is incorrect.', 401);

  const ctx = resolveContext(user, null);
  const token = await signSession({ uid: user.id, ctx }, env.SESSION_SECRET);
  user.ctx = ctx;
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token) });
}

/**
 * Cloudflare Access landing. Put an Access policy on THIS PATH ONLY.
 *
 * Access authenticates the client user against Entra or Zoho and forwards the
 * request with Cf-Access-Jwt-Assertion. We verify it, match the email to a
 * users row, mint our own session cookie, and redirect to the app. From then on
 * every request is authorised by the cookie, so the rest of the hostname stays
 * outside Access — which is what leaves the vendor password login reachable.
 */
async function ssoLanding(request, env) {
  const auth = await authConfig(env);
  if (!auth.ssoEnabled) {
    return fail('sso_disabled',
      auth.ssoConfigured
        ? 'Single sign-on is set up but not switched on yet.'
        : 'Single sign-on has not been configured for this deployment.', 403);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');

  if (!token) {
    // Reached without passing through Access — the policy is missing or the
    // path is not covered by it.
    return fail(
      'access_not_configured',
      'This path is not protected by Cloudflare Access, so single sign-on cannot complete. ' +
      'Add an Access application covering /api/auth/sso.',
      503,
    );
  }
  const claims = await verifyAccessJwt(token, {
    teamDomain: auth.teamDomain,
    aud: auth.aud,
  });
  if (!claims) return fail('bad_access_token', 'Could not verify the Access token.', 401);

  const email = String(claims.email).toLowerCase();

  // Open provisioning: Access has already authenticated this person against
  // the client's IdP and the Access policy decides who may reach this route, so
  // a first sign-in creates the account. Always client/requester.
  const resolved = await resolveOrProvisionSsoUser(env, claims, auth.allowedDomains);
  if (!resolved.user) {
    return new Response(noAccessPage(email, resolved.denied), {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const user = resolved.user;

  // Record the provider identity for this person. One human may arrive via both
  // Entra and Zoho; they resolve to one row because email is the join key.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_identities (user_id, provider, subject, first_seen)
     VALUES (?1, ?2, ?3, datetime('now'))`,
  ).bind(user.id, String(claims.idp?.type || 'access'), String(claims.sub || email)).run()
    .catch(() => { /* table is optional; identity logging is not critical path */ });

  // The first completed sign-in is what retires password access for client
  // staff. Recording it here, after a verified token has resolved to a real
  // active user, is the only point at which SSO is known to work end to end.
  if (!auth.ssoVerified) {
    await env.DB.prepare(
      "UPDATE config SET sso_verified_at = datetime('now') WHERE id = 1 AND sso_verified_at IS NULL",
    ).run();
    console.warn('SSO_VERIFIED', email);
  }

  const session = await signSession(
    { uid: user.id, ctx: resolveContext(user, null) }, env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': sessionCookie(session) },
  });
}

const NO_ACCESS_REASON = {
  disabled: 'that account has been disabled. Ask an administrator to re-enable it.',
  domain:   'that email domain is not eligible for access to this application.',
  no_email: 'the sign-in did not include an email address.',
};

const noAccessPage = (email, reason) => `<!doctype html>
<html><head><meta charset="utf-8"><title>No access</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;background:#0f1720;color:#e8eef4;
             display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
  <div style="max-width:420px;padding:24px">
    <h1 style="font-size:19px;margin:0 0 10px">No access</h1>
    <p style="color:#93a4b5;margin:0">
      You signed in as <strong style="color:#e8eef4">${email.replace(/[<>&"]/g, '')}</strong>,
      but ${NO_ACCESS_REASON[reason] || 'that address has not been given access to this application.'}
    </p>
  </div>
</body></html>`;

/**
 * Domains eligible for SSO auto-provisioning.
 *
 * Optional. When unset the Cloudflare Access policy is the only gate, which is
 * how production is configured — Access already restricts the app to the client's
 * IdPs. Setting it is defence in depth: if the Access policy is ever widened by
 * accident, this still refuses to mint accounts for outside addresses.
 */
function ssoDomainAllowed(email, env, configured) {
  const raw = String(configured ?? env.SSO_ALLOWED_DOMAINS ?? '').trim();
  if (!raw) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean).includes(domain);
}

/**
 * Resolve an Access identity to a users row, creating it on first sign-in.
 *
 * Auto-provisioned accounts are always client/requester. The org and role are
 * never read from the token: vendor accounts exist only where a client
 * admin created one through POST /api/users, so no SSO identity can arrive as
 * an approver and no client sign-in can reach the approval path.
 *
 * A disabled account is not resurrected by signing in again.
 */
export async function resolveOrProvisionSsoUser(env, claims, allowedDomains) {
  const email = String(claims?.email || '').toLowerCase().trim();
  if (!email) return { denied: 'no_email' };

  const existing = await env.DB.prepare(
    `SELECT * FROM users WHERE email = ?1`,
  ).bind(email).first();
  if (existing) {
    return existing.status === 'active' ? { user: existing } : { denied: 'disabled' };
  }

  if (!ssoDomainAllowed(email, env, allowedDomains)) return { denied: 'domain' };

  const fullName = String(claims.name || claims.given_name || email.split('@')[0]).slice(0, 120);

  try {
    const user = await env.DB.prepare(
      `INSERT INTO users (email, full_name, org, roles, created_by)
       VALUES (?1, ?2, 'client', 'member', 'sso:auto') RETURNING *`,
    ).bind(email, fullName).first();
    console.warn('USER_AUTOPROVISIONED', email);
    return { user };
  } catch (e) {
    if (!String(e).includes('UNIQUE')) throw e;
    // Two first sign-ins raced. The other one won; use the row it created.
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE email = ?1 AND status = 'active'`,
    ).bind(email).first();
    return user ? { user } : { denied: 'disabled' };
  }
}

// ── Vendor rosters ────────────────────────────────────────────────────
//
// The client admin owns every vendor roster: they onboard vendors and add
// and remove vendor staff. client accounts are not managed here at all --
// they are created by SSO on first sign-in (see resolveOrProvisionSsoUser), so
// these routes only ever touch org = 'vendor'.
const requireRosterAdmin = (me) => requireOrg(me, 'client') || requireRole(me, 'admin');

// ── Locations, run by the client admin ──────────────────────────────
//
// Codes are immutable. They are written as plain text onto every request and
// invoice, so changing one would orphan history; the name is what people read
// and that is editable. Deactivating hides a location from the request form
// without touching anything already raised against it.

const CODE_RE = /^[A-Z0-9]{2,8}$/;   // 'HQ' is two characters. Do not tighten.

/**
 * The optional tax block on a vendor's configuration.
 *
 * Rates arrive as percentages from the form because that is what an admin
 * types, and are stored as basis points so the money arithmetic never touches
 * a float. Everything is optional: a vendor with nothing set produces exactly
 * the document the system produced before tax existed.
 */
function parseTax(b) {
  const pct = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return Math.round(n * 100);            // 7.5 -> 750 bps
  };
  const vat = pct(b.vat_rate_pct);
  const wht = pct(b.wht_rate_pct);
  if (vat === null) return { error: 'vat_rate_pct must be a percentage between 0 and 100.' };
  if (wht === null) return { error: 'wht_rate_pct must be a percentage between 0 and 100.' };

  const basis = String(b.vat_basis || 'invoice');
  if (!['invoice', 'fee'].includes(basis)) {
    return { error: "vat_basis must be 'invoice' or 'fee'." };
  }
  return { tin: String(b.tin || '').trim() || null, vat, wht, basis };
}

/**
 * What has actually been issued: totals over a date range, broken down.
 *
 * Reads `invoices`, never `requests`. A request is an intention; an invoice is
 * a document that exists and is defensible to a tax authority, and those are
 * the only numbers worth reporting. Amounts come off the invoice row too, not
 * the request, because the request's figures were indicative before a vendor
 * took it.
 *
 * Client admins only. A vendor sees its own history on its own screen and has
 * no business seeing what its competitors issued.
 */
async function summary(env, me, url) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  // Default to the current year rather than all time: "how much this year" is
  // the question a tax filing actually asks.
  const now = new Date();
  const from = String(url?.searchParams?.get('from') || `${now.getUTCFullYear()}-01-01`);
  const to = String(url?.searchParams?.get('to') || `${now.getUTCFullYear()}-12-31`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return fail('bad_request', 'from and to must be YYYY-MM-DD.');
  }
  // issued_at is 'YYYY-MM-DD HH:MM:SS'; compare on the date part so `to` is
  // inclusive of its whole day.
  const range = ['date(i.issued_at) BETWEEN ?1 AND ?2', from, to];

  const one = async (sql, ...binds) =>
    (await env.DB.prepare(sql).bind(...binds).all()).results || [];

  const [totals] = await one(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(i.amount_kobo), 0) AS amount_kobo,
            COALESCE(SUM(i.fee_kobo), 0)    AS fee_kobo,
            COALESCE(SUM(i.vat_kobo), 0)    AS vat_kobo,
            COALESCE(SUM(i.wht_kobo), 0)    AS wht_kobo,
            COALESCE(SUM(i.total_kobo), 0)  AS total_kobo
       FROM invoices i WHERE ${range[0]}`, from, to);

  const byType = await one(
    `SELECT r.type_code AS key, COUNT(*) AS count,
            COALESCE(SUM(i.total_kobo), 0) AS total_kobo
       FROM invoices i JOIN requests r ON r.id = i.request_id
      WHERE ${range[0]} GROUP BY r.type_code ORDER BY total_kobo DESC`, from, to);

  const byVendor = await one(
    `SELECT v.name AS key, v.code, COUNT(*) AS count,
            COALESCE(SUM(i.total_kobo), 0) AS total_kobo
       FROM invoices i JOIN vendors v ON v.id = i.vendor_id
      WHERE ${range[0]} GROUP BY v.id ORDER BY total_kobo DESC`, from, to);

  const byBu = await one(
    `SELECT i.bu_code AS key, COUNT(*) AS count,
            COALESCE(SUM(i.total_kobo), 0) AS total_kobo
       FROM invoices i WHERE ${range[0]} GROUP BY i.bu_code ORDER BY total_kobo DESC`, from, to);

  const bySite = await one(
    `SELECT i.site_code AS key, COUNT(*) AS count,
            COALESCE(SUM(i.total_kobo), 0) AS total_kobo
       FROM invoices i WHERE ${range[0]} GROUP BY i.site_code ORDER BY total_kobo DESC LIMIT 20`,
    from, to);

  const byMonth = await one(
    `SELECT i.period AS key, COUNT(*) AS count,
            COALESCE(SUM(i.total_kobo), 0) AS total_kobo
       FROM invoices i WHERE ${range[0]} GROUP BY i.period ORDER BY i.period`, from, to);

  // Requests that never became a document, so the queue is visible next to
  // the totals rather than on a different screen.
  const [pending] = await one(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount_kobo), 0) AS amount_kobo
       FROM requests WHERE status = 'pending'`);

  const ref = await loadReference(env);
  const label = (rows, fn) => rows.map((r) => ({ ...r, label: fn(r) }));

  return json({
    from,
    to,
    totals,
    pending,
    byType: label(byType, (r) => typeFor(r.key)?.label ?? r.key),
    byVendor,
    byBu: label(byBu, (r) => buNameIn(ref, r.key)),
    bySite: label(bySite, (r) => siteNameIn(ref, r.key)),
    byMonth: label(byMonth, (r) => periodLabel(r.key)),
  });
}

async function adminReference(env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;
  const ref = await loadReference(env);
  return json({ ...ref, requestTypes: REQUEST_TYPES });
}

async function upsertSite(request, env, me, code = null) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  if (!name) return fail('bad_request', 'name is required.');

  if (code) {
    const status = b.status === undefined ? null : String(b.status);
    if (status !== null && !['active', 'disabled'].includes(status)) {
      return fail('bad_request', "status must be 'active' or 'disabled'.");
    }
    const r = await env.DB.prepare(
      `UPDATE sites SET name = ?1, status = COALESCE(?2, status) WHERE code = ?3`,
    ).bind(name, status, code).run();
    if (!r.meta.changes) return fail('not_found', 'No such site.', 404);
    const row = await env.DB.prepare('SELECT * FROM sites WHERE code = ?1').bind(code).first();
    return json({ site: row });
  }

  const newCode = String(b.code || '').trim().toUpperCase();
  if (!CODE_RE.test(newCode)) {
    return fail('bad_request', 'code must be 2-8 characters, A-Z or 0-9. It cannot be changed later.');
  }
  try {
    const row = await env.DB.prepare(
      `INSERT INTO sites (code, name, created_by) VALUES (?1,?2,?3) RETURNING *`,
    ).bind(newCode, name, me.email).first();
    // A site nobody can bill against is useless, so attach it in the same call
    // when a BU is named.
    if (b.bu_code) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO bu_sites (bu_code, site_code) VALUES (?1,?2)`,
      ).bind(String(b.bu_code), newCode).run();
    }
    return json({ site: row }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) {
      return fail('duplicate', 'That site code already exists.', 409);
    }
    throw e;
  }
}

async function upsertBu(request, env, me, code = null) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const name = String(b.name || '').trim();
  const numbering = String(b.numbering_site || '').trim().toUpperCase();
  if (!name) return fail('bad_request', 'name is required.');

  // BU-scope requests store site_code NULL and borrow this for the ref, so a
  // BU whose numbering site does not exist would mint an unresolvable number.
  if (numbering) {
    const site = await env.DB.prepare('SELECT code FROM sites WHERE code = ?1').bind(numbering).first();
    if (!site) return fail('bad_request', `numbering_site ${numbering} is not a known site.`);
  }

  if (code) {
    const status = b.status === undefined ? null : String(b.status);
    if (status !== null && !['active', 'disabled'].includes(status)) {
      return fail('bad_request', "status must be 'active' or 'disabled'.");
    }
    const r = await env.DB.prepare(
      `UPDATE business_units
          SET name = ?1, numbering_site = COALESCE(NULLIF(?2,''), numbering_site),
              status = COALESCE(?3, status)
        WHERE code = ?4`,
    ).bind(name, numbering, status, code).run();
    if (!r.meta.changes) return fail('not_found', 'No such business unit.', 404);
    const row = await env.DB.prepare('SELECT * FROM business_units WHERE code = ?1').bind(code).first();
    return json({ business_unit: row });
  }

  const newCode = String(b.code || '').trim().toUpperCase();
  if (!CODE_RE.test(newCode)) {
    return fail('bad_request', 'code must be 2-8 characters, A-Z or 0-9. It cannot be changed later.');
  }
  if (!numbering) return fail('bad_request', 'numbering_site is required.');
  try {
    const row = await env.DB.prepare(
      `INSERT INTO business_units (code, name, numbering_site, created_by)
       VALUES (?1,?2,?3,?4) RETURNING *`,
    ).bind(newCode, name, numbering, me.email).first();
    return json({ business_unit: row }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) {
      return fail('duplicate', 'That business unit code already exists.', 409);
    }
    throw e;
  }
}

/** Attach or detach a site from a BU. Many-to-many: LEK belongs to RFC and REX. */
async function linkBuSite(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const bu = String(b.bu_code || '').trim().toUpperCase();
  const site = String(b.site_code || '').trim().toUpperCase();
  if (!bu || !site) return fail('bad_request', 'bu_code and site_code are required.');

  if (b.attached === false) {
    // Detaching does not touch requests already raised against the pair -- the
    // codes on those rows are plain text and stay resolvable.
    await env.DB.prepare('DELETE FROM bu_sites WHERE bu_code = ?1 AND site_code = ?2')
      .bind(bu, site).run();
    return json({ ok: true, attached: false });
  }

  const known = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM business_units WHERE code = ?1) AS bu,
            (SELECT COUNT(*) FROM sites WHERE code = ?2) AS site`,
  ).bind(bu, site).first();
  if (!known.bu) return fail('bad_request', `No such business unit ${bu}.`);
  if (!known.site) return fail('bad_request', `No such site ${site}.`);

  await env.DB.prepare('INSERT OR IGNORE INTO bu_sites (bu_code, site_code) VALUES (?1,?2)')
    .bind(bu, site).run();
  return json({ ok: true, attached: true });
}

/** The indicative fee shown on the request form. Not a vendor's real fee. */
async function updatePlatformConfig(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const fee = Number(b.default_fee_kobo);
  if (!Number.isInteger(fee) || fee < 0) {
    return fail('bad_request', 'default_fee_kobo must be a whole number of kobo.');
  }
  // The organisation running this deployment. Nothing about any particular
  // company is compiled in; this is where it is set.
  const orgName = b.org_name === undefined ? null : String(b.org_name).trim();
  if (orgName !== null && !orgName) {
    return fail('bad_request', 'org_name cannot be blank.');
  }

  // A floor may only ever rise. Lowering it would let the system re-issue a
  // number it has already used, which is the exact thing it exists to prevent.
  let floor = null;
  if (b.seq_floor !== undefined) {
    const n = Number(b.seq_floor);
    if (!Number.isInteger(n) || n < 0) {
      return fail('bad_request', 'seq_floor must be a whole number, zero or more.');
    }
    const cur = await env.DB.prepare('SELECT seq_floor FROM config WHERE id = 1').first();
    if (n < (cur?.seq_floor ?? 0)) {
      return fail('bad_request',
        `The floor can only be raised. It is already ${cur.seq_floor}.`);
    }
    floor = n;
  }
  await env.DB.prepare(
    `UPDATE config SET default_fee_kobo = ?1,
            org_name = COALESCE(?3, org_name),
            seq_floor = COALESCE(?4, seq_floor),
            updated_at = datetime('now'), updated_by = ?2
      WHERE id = 1`,
  ).bind(fee, me.email, orgName, floor).run();
  const row = await env.DB.prepare('SELECT * FROM config WHERE id = 1').first();
  return json({ config: row });
}

/**
 * Every font a vendor can be given: the bundled catalogue plus anything an
 * admin uploaded. Readable by any signed-in user so the onboarding form and a
 * vendor's own settings screen can both offer the list.
 */
/**
 * Single sign-on for client staff, configured in the app.
 *
 * Kept out of wrangler.toml on purpose: a deployment should be able to start
 * on passwords and adopt SSO later without a redeploy, and the person who sets
 * it up is an admin rather than whoever holds the deploy credentials.
 */
/**
 * What a migration needs to know: the current floor and the highest number
 * ever issued here. Rebuilding elsewhere means setting the new deployment's
 * floor above this.
 */
async function getNumbering(env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;
  const cfg = await env.DB.prepare('SELECT seq_floor FROM config WHERE id = 1').first();
  const { high } = await env.DB.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS high FROM invoices').first();
  const { latest } = await env.DB.prepare(
    'SELECT invoice_no AS latest FROM invoices ORDER BY id DESC LIMIT 1').first()
    || { latest: null };
  return json({ seqFloor: cfg?.seq_floor ?? 0, highestSeq: high, latestInvoiceNo: latest });
}

async function getSsoConfig(env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;
  const a = await authConfig(env);
  return json({
    enabled: a.ssoEnabled,
    configured: a.ssoConfigured,
    verified: a.ssoVerified,
    verifiedAt: a.verifiedAt,
    teamDomain: a.teamDomain,
    aud: a.aud,
    allowedDomains: a.allowedDomains,
    clientPassword: a.clientPassword,
  });
}

async function putSsoConfig(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const teamDomain = String(b.team_domain || '').trim();
  const aud = String(b.aud || '').trim();
  const domains = String(b.allowed_domains || '').trim();
  const enabled = b.enabled === true;

  if (teamDomain && !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain)) {
    return fail('bad_request',
      'team_domain looks like "yourteam.cloudflareaccess.com".');
  }
  // Switching it on without both values would present users a button that can
  // only ever fail.
  if (enabled && !(teamDomain && aud)) {
    return fail('bad_request',
      'Set the team domain and the application AUD tag before switching SSO on.');
  }

  await env.DB.prepare(
    `UPDATE config SET sso_enabled = ?1, access_team_domain = ?2, access_aud = ?3,
            sso_allowed_domains = ?4, updated_at = datetime('now'), updated_by = ?5
      WHERE id = 1`,
  ).bind(enabled ? 1 : 0, teamDomain || null, aud || null, domains || null, me.email).run();

  console.warn('SSO_CONFIG_CHANGED', me.email, enabled ? 'enabled' : 'disabled');
  return getSsoConfig(env, me);
}

async function listFonts(env, me) {
  const { results } = await env.DB.prepare('SELECT * FROM fonts ORDER BY name').all();
  const custom = (results || []).map((f) => ({
    key: f.key, name: f.name, kind: f.kind, metricOf: f.metric_of, builtin: false,
  }));
  const builtin = Object.entries(FONT_CATALOGUE).map(([key, f]) => ({
    key, name: f.name, kind: f.kind, metricOf: f.metricOf, builtin: true,
  }));
  return json({ fonts: [...builtin, ...custom], fallback: FALLBACK_FONT });
}

/**
 * Add a font the catalogue does not cover.
 *
 * Both faces are required and both are checked for the glyphs the renderer can
 * emit BEFORE anything is stored. This is the one control that matters here: a
 * font missing U+20A6 raises no error at render time, it just quietly drops
 * every currency symbol, and the first anyone knows is an approved invoice
 * already sitting in a WhatsApp group.
 */
async function uploadFont(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  let form;
  try { form = await request.formData(); }
  catch { return fail('bad_request', 'Send multipart/form-data with regular and bold files.'); }

  const key = String(form.get('key') || '').trim().toLowerCase();
  const name = String(form.get('name') || '').trim();
  const kind = String(form.get('kind') || 'sans');
  const metricOf = String(form.get('metric_of') || '').trim() || null;

  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(key)) {
    return fail('bad_request', 'key must be 2-31 lowercase letters, digits or hyphens.');
  }
  if (Object.hasOwn(FONT_CATALOGUE, key)) {
    return fail('duplicate', `"${key}" is a bundled font and cannot be replaced.`, 409);
  }
  if (!name) return fail('bad_request', 'name is required.');
  if (!['sans', 'serif', 'mono'].includes(kind)) {
    return fail('bad_request', 'kind must be sans, serif or mono.');
  }

  const files = { regular: form.get('regular'), bold: form.get('bold') };
  for (const [style, file] of Object.entries(files)) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      return fail('bad_request', `A ${style} font file is required.`);
    }
  }

  const bytes = {};
  for (const [style, file] of Object.entries(files)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length < 4096) return fail('bad_request', `The ${style} file is too small to be a font.`);
    if (buf.length > 4 * 1024 * 1024) {
      return fail('bad_request', `The ${style} file is over 4 MB; supply a subset or a lighter face.`);
    }
    let font;
    try { font = fontkit.create(buf); }
    catch { return fail('bad_request', `The ${style} file is not a readable font.`); }
    if (font.fonts) {
      return fail('bad_request', `The ${style} file is a font collection; supply a single face.`);
    }
    const gaps = REQUIRED_GLYPHS.filter(([, cp]) => !font.hasGlyphForCodePoint(cp));
    if (gaps.length) {
      return fail(
        'font_missing_glyphs',
        `The ${style} face is missing ${gaps.map(([ch]) => ch).join(' ')}. `
        + 'A font without these does not fail at render — it silently drops them '
        + 'from every invoice.',
        422,
        { style, missing: gaps.map(([ch, cp, what]) => ({ glyph: ch, codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`, what })) },
      );
    }
    bytes[style] = buf;
  }

  const keys = fontKeys(key);
  await env.ASSETS_KV.put(keys.regular, bytes.regular);
  await env.ASSETS_KV.put(keys.bold, bytes.bold);

  try {
    await env.DB.prepare(
      'INSERT INTO fonts (key, name, kind, metric_of, created_by) VALUES (?1,?2,?3,?4,?5)',
    ).bind(key, name, kind, metricOf, me.email).run();
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) {
      return fail('duplicate', 'A font with that key already exists.', 409);
    }
    throw e;
  }

  assetCache.clear();
  console.warn('FONT_UPLOADED', me.email, key);
  return json({ font: { key, name, kind, metricOf, builtin: false } }, 201);
}

async function deleteFont(env, me, key) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  if (Object.hasOwn(FONT_CATALOGUE, key)) {
    return fail('forbidden', 'Bundled fonts cannot be removed.', 403);
  }
  // A vendor still pointing at it would silently fall back to Arimo, changing
  // how their invoices look without anyone choosing that.
  const { results } = await env.DB.prepare(
    "SELECT code FROM vendors WHERE json_extract(template_json, '$.type.family') = ?1",
  ).bind(key).all();
  if ((results || []).length) {
    return fail('conflict',
      `Still used by ${results.map((v) => v.code).join(', ')}. Change those vendors first.`, 409);
  }

  const r = await env.DB.prepare('DELETE FROM fonts WHERE key = ?1').bind(key).run();
  if (!r.meta.changes) return fail('not_found', 'No such font.', 404);

  const keys = fontKeys(key);
  await env.ASSETS_KV.delete(keys.regular);
  await env.ASSETS_KV.delete(keys.bold);
  assetCache.clear();
  console.warn('FONT_DELETED', me.email, key);
  return json({ ok: true });
}

/**
 * An admin sets someone else's password.
 *
 * There is no email delivery, so this is the reset path: the admin sets a
 * temporary password and hands it over in person or on a call. Because the
 * admin now knows it, the account is flagged and the owner has to replace it
 * before they can do anything else.
 *
 * Deliberately not usable on your own account — that is changeOwnPassword,
 * which requires the current password. Otherwise an unattended session would
 * be enough to lock the real owner out.
 */
async function resetUserPassword(request, env, me, id) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  if (id === me.id) {
    return fail('bad_request',
      'Use the change-password form for your own account; it asks for your current one.');
  }

  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!target) return fail('not_found', 'No such user.', 404);

  const b = await request.json().catch(() => ({}));
  const errs = checkPassword(b.password, { email: target.email, name: target.full_name });
  if (errs.length) {
    return fail('weak_password', errs[0], 422, { errors: errs, hint: PASSWORD_HINT });
  }

  const pw = await hashPassword(String(b.password));
  await env.DB.prepare(
    `UPDATE users SET pw_hash = ?1, pw_salt = ?2, pw_iterations = ?3,
            must_change_password = 1
      WHERE id = ?4`,
  ).bind(pw.hash, pw.salt, pw.iterations, id).run();

  console.warn('PASSWORD_RESET_BY_ADMIN', me.email, target.email);
  return json({ ok: true, mustChange: true });
}

/**
 * Change your own password. Requires the current one, so a session left open
 * on someone's desk cannot be used to take the account over.
 */
async function changeOwnPassword(request, env, me) {
  const b = await request.json().catch(() => ({}));
  const current = String(b.current_password || '');

  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(me.id).first();
  if (!row?.pw_hash) {
    return fail('forbidden', 'This account signs in through single sign-on.', 403);
  }
  if (!(await verifyPassword(current, row))) {
    return fail('bad_credentials', 'Your current password is incorrect.', 401);
  }

  const errs = checkPassword(b.password, { email: me.email, name: me.full_name });
  if (errs.length) {
    return fail('weak_password', errs[0], 422, { errors: errs, hint: PASSWORD_HINT });
  }
  if (String(b.password) === current) {
    return fail('bad_request', 'That is the password you already have.');
  }

  const pw = await hashPassword(String(b.password));
  await env.DB.prepare(
    `UPDATE users SET pw_hash = ?1, pw_salt = ?2, pw_iterations = ?3,
            must_change_password = 0
      WHERE id = ?4`,
  ).bind(pw.hash, pw.salt, pw.iterations, me.id).run();

  console.warn('PASSWORD_CHANGED', me.email);
  return json({ ok: true });
}

async function listVendors(env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;
  const { results } = await env.DB.prepare(
    `SELECT v.*, c.fee_kobo, c.bank_account_name, c.bank_account_number,
            c.bank_name, c.signatory_name, c.signatory_title,
            c.tin, c.vat_rate_bps, c.wht_rate_bps, c.vat_basis,
            (SELECT COUNT(*) FROM users u
              WHERE u.vendor_id = v.id AND u.status = 'active') AS staff_count,
            (SELECT COUNT(*) FROM invoices i WHERE i.vendor_id = v.id) AS invoice_count
       FROM vendors v LEFT JOIN vendor_config c ON c.vendor_id = v.id
      ORDER BY v.status, v.name`,
  ).all();
  return json({ vendors: (results || []).map(publicVendor) });
}

async function createVendor(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const code = String(b.code || '').trim();
  const name = String(b.name || '').trim();
  // The code is the KV prefix for this vendor's letterhead artwork, so it has
  // to be filesystem-safe and stable. It is not editable afterwards. Validated
  // as typed rather than normalised first, so the admin sees exactly what the
  // prefix will be instead of having it silently rewritten under them.
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(code)) {
    return fail('bad_request', 'code must be 2-31 lowercase letters, digits or hyphens.');
  }
  if (!name) return fail('bad_request', 'name is required.');

  const fields = ['bank_account_name', 'bank_account_number', 'bank_name', 'signatory_name', 'signatory_title'];
  for (const f of fields) {
    if (!String(b[f] || '').trim()) return fail('bad_request', `${f} is required.`);
  }
  const fee = Number(b.fee_kobo);
  if (!Number.isInteger(fee) || fee < 0) return fail('bad_request', 'fee_kobo must be a whole number of kobo.');

  const tax = parseTax(b);
  if (tax.error) return fail('bad_request', tax.error);

  const contact = Array.isArray(b.contact_lines)
    ? b.contact_lines.map((l) => String(l)).filter(Boolean).slice(0, 8) : [];

  try {
    const v = await env.DB.prepare(
      `INSERT INTO vendors (code, name, contact_lines, created_by)
       VALUES (?1,?2,?3,?4) RETURNING *`,
    ).bind(code, name, JSON.stringify(contact), me.email).first();

    await env.DB.prepare(
      `INSERT INTO vendor_config (vendor_id, bank_account_name, bank_account_number,
                                  bank_name, fee_kobo, signatory_name, signatory_title,
                                  tin, vat_rate_bps, wht_rate_bps, vat_basis, updated_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    ).bind(v.id, b.bank_account_name.trim(), b.bank_account_number.trim(), b.bank_name.trim(),
           fee, b.signatory_name.trim(), b.signatory_title.trim(),
           tax.tin, tax.vat, tax.wht, tax.basis, me.email).run();

    console.warn('VENDOR_ONBOARDED', me.email, code);
    return json({ vendor: publicVendor(v) }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail('duplicate', 'That vendor code already exists.', 409);
    throw e;
  }
}

/**
 * Suspend or restore a vendor.
 *
 * Disable, not DELETE: invoices.vendor_id points here, and a suspended vendor's
 * issued documents must keep resolving. A suspended vendor's staff can still
 * sign in and read their own history but cannot approve -- approveRequest
 * re-checks the vendor's status.
 */
async function setVendorStatus(request, env, me, id) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const status = String(b.status || '');
  if (!['active', 'disabled'].includes(status)) {
    return fail('bad_request', "status must be 'active' or 'disabled'.");
  }
  const r = await env.DB.prepare('UPDATE vendors SET status = ?1 WHERE id = ?2').bind(status, id).run();
  if (!r.meta.changes) return fail('not_found', 'No such vendor.', 404);

  console.warn('VENDOR_STATUS_CHANGED', me.email, status, id);
  const v = await env.DB.prepare('SELECT * FROM vendors WHERE id = ?1').bind(id).first();
  return json({ vendor: publicVendor(v) });
}

/**
 * A vendor's digitised layout.
 *
 * Read is open to that vendor's own admin as well as the client admin — it is
 * their stationery, and they are the ones who can tell whether the replica is
 * right. Writing is client-admin only, because a template is produced by the
 * onboarding extraction rather than hand-edited in normal operation.
 */
/**
 * Render a specimen so an admin can see what a vendor's template produces.
 *
 * This is the one place letterhead is drawn from something other than an
 * issued invoice, so it is fenced carefully:
 *
 *   - client admins only, the people who run onboarding
 *   - the content is FIXED here, not taken from the request. A caller cannot
 *     put their own addressee, description or amounts on a letterheaded page
 *   - the output is stamped SPECIMEN across the middle
 *
 * Without those three, this would be exactly the "render letterhead from
 * ad-hoc field values" route that invariant 1 exists to prevent. With them the
 * output is unmistakably a layout proof and cannot function as a payment
 * document.
 */
async function previewVendorTemplate(request, env, me, id) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const vendor = await env.DB.prepare(
    'SELECT v.*, c.* FROM vendors v LEFT JOIN vendor_config c ON c.vendor_id = v.id WHERE v.id = ?1',
  ).bind(id).first();
  if (!vendor) return fail('not_found', 'No such vendor.', 404);

  // Preview what was sent if anything was, so a template can be checked BEFORE
  // it is saved; otherwise preview what is stored.
  const b = await request.json().catch(() => ({}));
  let tpl = b.template ?? null;
  if (tpl === null && b.template !== null) {
    try { tpl = vendor.template_json ? JSON.parse(vendor.template_json) : null; } catch { tpl = null; }
  }
  if (tpl) {
    const errs = validateTemplate(tpl);
    if (errs.length) return fail('invalid_template', errs[0], 422, { errors: errs });
  }

  const merged = mergeTemplate(tpl);
  const assets = await loadAssets(env, vendor.code, vendor.contact_lines,
                                  merged.artwork, merged.type.family);

  // Fixed specimen content. Chosen to exercise the layout: a long-ish
  // description, an extra column, and figures wide enough to show alignment.
  const bytes = await renderInvoice({
    bu_code: 'SPEC', site_code: 'MAIN', period: '2026-01', seq: 1,
    addressee: 'Specimen Branch',
    addressee_loc: 'Lagos.',
    subject: 'Layout Specimen',
    narrative: 'This document exists to show how your letterhead and layout '
      + 'render. It is not a payment request and no money relates to it.',
    extra_column_label: 'Reference',
    lines: [{ description: 'Specimen line item for layout review',
              extra: '0000000000', amount_kobo: 12345600 }],
    amount_kobo: 12345600,
    fee_kobo: vendor.fee_kobo ?? 10000,
    vat_kobo: 0,
    wht_kobo: 0,
    total_kobo: 12345600 + (vendor.fee_kobo ?? 10000),
    bank_account_name: vendor.bank_account_name || 'Account Name',
    bank_account_number: vendor.bank_account_number || '0000000000',
    bank_name: vendor.bank_name || 'Bank',
    signatory_name: vendor.signatory_name || 'Signatory',
    signatory_title: vendor.signatory_title || 'Title',
    approver_name: vendor.signatory_name || 'Approver Name',
    approver_title: vendor.signatory_title || 'Approver Title',
    approver_phone: '+000 000 0000',
    approver_email: 'approver@example.com',
    vendor_name: vendor.name,
    client_name: 'Specimen Client',
    tin: vendor.tin,
    issued_at: new Date().toISOString(),
  }, assets, tpl, { specimen: true });

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="template-specimen.pdf"',
      'Cache-Control': 'no-store',
    },
  });
}

async function getVendorTemplate(env, me, id) {
  // Client admin only. Vendors have no administrator to review a layout, and
  // the reps who approve requests have no reason to see one.
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const v = await env.DB.prepare('SELECT template_json FROM vendors WHERE id = ?1').bind(id).first();
  if (!v) return fail('not_found', 'No such vendor.', 404);
  let tpl = null;
  try { tpl = v.template_json ? JSON.parse(v.template_json) : null; } catch { tpl = null; }
  return json({ template: tpl, isDefault: !tpl, effective: mergeTemplate(tpl), default: DEFAULT_TEMPLATE });
}

async function putVendorTemplate(request, env, me, id) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => null);
  if (b === null) return fail('bad_request', 'Body must be JSON.');

  // Passing null clears the template and returns the vendor to the default
  // layout, which is the escape hatch when an extraction comes out wrong.
  if (b.template === null) {
    const r = await env.DB.prepare('UPDATE vendors SET template_json = NULL WHERE id = ?1').bind(id).run();
    if (!r.meta.changes) return fail('not_found', 'No such vendor.', 404);
    assetCache.clear();
    return json({ template: null, isDefault: true });
  }

  const errs = validateTemplate(b.template);
  if (errs.length) {
    return fail('invalid_template', errs[0], 422, { errors: errs });
  }

  // Shape is checked in shared/template.js; existence is a database question.
  const fam = b.template?.type?.family;
  if (fam && !Object.hasOwn(FONT_CATALOGUE, fam)) {
    const known = await env.DB.prepare('SELECT key FROM fonts WHERE key = ?1').bind(fam).first();
    if (!known) return fail('invalid_template', `Unknown font "${fam}".`, 422, { errors: [`Unknown font "${fam}".`] });
  }

  const r = await env.DB.prepare('UPDATE vendors SET template_json = ?1 WHERE id = ?2')
    .bind(JSON.stringify(b.template), id).run();
  if (!r.meta.changes) return fail('not_found', 'No such vendor.', 404);

  // The artwork a template asks for may have changed, and assets are cached
  // per vendor for the life of the isolate.
  assetCache.clear();
  console.warn('VENDOR_TEMPLATE_CHANGED', me.email, id);
  return json({ template: b.template, isDefault: false, effective: mergeTemplate(b.template) });
}

const publicVendor = (v) => ({
  id: v.id, code: v.code, name: v.name, status: v.status,
  bank_account_name: v.bank_account_name, bank_account_number: v.bank_account_number,
  bank_name: v.bank_name, signatory_name: v.signatory_name,
  signatory_title: v.signatory_title, tin: v.tin,
  vat_rate_bps: v.vat_rate_bps, wht_rate_bps: v.wht_rate_bps, vat_basis: v.vat_basis,
  contact_lines: JSON.parse(v.contact_lines || '[]'),
  has_template: !!v.template_json,
  fee_kobo: v.fee_kobo,
  staff_count: v.staff_count, invoice_count: v.invoice_count,
  created_at: v.created_at,
});

async function listUsers(env, me, url) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const vendorId = Number(url?.searchParams?.get('vendor_id')) || null;
  const org = url?.searchParams?.get('org') === 'client' ? 'client' : 'vendor';
  const { results } = await env.DB.prepare(
    `SELECT u.*, v.name AS vendor_name, v.code AS vendor_code
       FROM users u LEFT JOIN vendors v ON v.id = u.vendor_id
      WHERE u.org = ?2 AND (?1 IS NULL OR u.vendor_id = ?1)
      ORDER BY v.name, u.status, u.full_name`,
  ).bind(vendorId, org).all();
  return json({ users: (results || []).map(publicUser) });
}

async function createUser(request, env, me) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const email = String(b.email || '').toLowerCase().trim();
  const jobTitle = String(b.job_title || '').trim();
  const phone = String(b.phone || '').trim();
  // Name, job title, email and phone are all required: they are copied onto
  // every invoice this person approves, so an account with them missing would
  // produce a document with a blank signature block.
  const org = String(b.org || 'vendor');
  if (!['client', 'vendor'].includes(org)) {
    return fail('bad_request', "org must be 'client' or 'vendor'.");
  }
  // Accepts `roles: ['admin','member']` or a single `role` for convenience.
  const roles = [...new Set(
    (Array.isArray(b.roles) ? b.roles : splitRoles(b.roles || b.role)).map(String),
  )];
  if (!email || !b.full_name || !roles.length) {
    return fail('bad_request', 'email, full_name and at least one role are required.');
  }

  // A vendor user's job title and phone are printed in the signature block of
  // every invoice they approve, so they are required. Client staff never
  // appear on the document, so theirs are optional.
  let vendorId = null;
  let vendor = null;
  if (org === 'vendor') {
    vendorId = Number(b.vendor_id);
    if (!jobTitle || !phone) {
      return fail('bad_request', 'job_title and phone are required for vendor users.');
    }
    if (!Number.isInteger(vendorId)) {
      return fail('bad_request', 'vendor_id is required: a vendor user must belong to a vendor.');
    }
    vendor = await env.DB.prepare(
      `SELECT * FROM vendors WHERE id = ?1 AND status = 'active'`,
    ).bind(vendorId).first();
    if (!vendor) return fail('bad_request', 'No such active vendor.');
  } else if (b.vendor_id) {
    return fail('bad_request', 'A client user does not belong to a vendor.');
  }
  const allowed = org === 'client' ? CLIENT_ROLES : VENDOR_ROLES;
  const bad = roles.filter((r) => !allowed.includes(r));
  if (bad.length) {
    return fail('bad_request',
      `${org} roles must be ${allowed.join(' or ')}; got ${bad.join(', ')}.`);
  }
  // Landing someone in a context they do not hold would show them an empty app.
  const defaultRole = String(b.default_role || roles[0]);
  if (!roles.includes(defaultRole)) {
    return fail('bad_request', `default_role must be one of the roles given (${roles.join(', ')}).`);
  }

  // Client staff get a password too. Once SSO is set up and proven, it stops
  // working for them and the identity provider takes over; until then it is
  // the only way in, and a deployment has to be usable before SSO exists.
  const pwErrs = checkPassword(b.password, { email, name: b.full_name });
  if (pwErrs.length) {
    return fail('weak_password', pwErrs[0], 422, { errors: pwErrs, hint: PASSWORD_HINT });
  }
  const pw = await hashPassword(String(b.password));

  try {
    const r = await env.DB.prepare(
      `INSERT INTO users (email, full_name, org, vendor_id, roles, job_title, phone,
                          pw_hash, pw_salt, pw_iterations, created_by, default_role)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) RETURNING *`,
    ).bind(email, b.full_name, org, vendorId, roles.join(','), jobTitle || null, phone || null,
           pw.hash, pw.salt, pw.iterations, me.email, defaultRole).first();
    r.vendor_name = vendor?.name ?? null;
    r.vendor_code = vendor?.code ?? null;
    return json({ user: publicUser(r) }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail('duplicate', 'That email already exists.', 409);
    throw e;
  }
}

/**
 * Remove or restore a vendor account.
 *
 * Disable, not DELETE. users.id is the target of requests.created_by,
 * requests.decided_by and invoices.issued_by, so deleting a row would orphan
 * the record of who approved an issued invoice -- the audit trail this system
 * exists to produce. A disabled user fails the `status = 'active'` test in
 * authenticate() and cannot sign in.
 */
async function setUserStatus(request, env, me, id) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const status = String(b.status || '');
  if (!['active', 'disabled'].includes(status)) {
    return fail('bad_request', "status must be 'active' or 'disabled'.");
  }

  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  if (!target) return fail('not_found', 'No such user.', 404);
  // An admin disabling themselves would leave nobody able to re-enable them.
  if (target.id === me.id) {
    return fail('forbidden', 'You cannot disable your own account.', 403);
  }

  // Nor may the last one go. Client admins own the vendor list, every vendor
  // roster, the locations and the sign-on settings; with none left active there
  // is no route back into any of it.
  if (status === 'disabled' && target.org === 'client' && hasRole(target, 'admin')) {
    const { c } = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM users
        WHERE org = 'client' AND status = 'active'
          AND (',' || roles || ',') LIKE '%,admin,%'`,
    ).first();
    if (c <= 1) {
      return fail('forbidden',
        'This is the last active administrator. Add another before removing this one.', 403);
    }
  }

  const r = await env.DB.prepare(
    'UPDATE users SET status = ?1 WHERE id = ?2',
  ).bind(status, id).run();
  if (!r.meta.changes) return fail('conflict', 'User was not updated.', 409);

  console.warn('VENDOR_ROSTER_CHANGED', me.email, status, target.email);
  const updated = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  return json({ user: publicUser(updated) });
}

// ── Requests ──────────────────────────────────────────────────────────

async function listRequests(request, env, me, url) {
  const status = url.searchParams.get('status');
  const clauses = [];
  const binds = [];

  // A member sees their OWN requests and nothing else — what a colleague spends
  // is not their business. An admin sees every request, because reconciling the
  // whole picture is the job. Acting context decides which, not roles held: an
  // admin working as a member sees a member's view.
  //
  // A vendor sees the shared pending queue plus whatever it decided itself,
  // never another vendor's decided work. That is what makes the queue a
  // marketplace rather than a mailbox.
  if (me.org === 'client') {
    clauses.push('u.org = ?');
    binds.push('client');
    if (me.ctx !== 'admin') {
      clauses.push('r.created_by = ?');
      binds.push(me.id);
    }
  } else {
    clauses.push("(r.status = 'pending' OR r.decided_vendor_id = ?)");
    binds.push(me.vendor_id);
  }
  if (status) {
    clauses.push('r.status = ?');
    binds.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT r.*, u.full_name AS created_by_name, u.email AS created_by_email,
            d.full_name AS decided_by_name, i.invoice_no,
            i.approver_name, i.approver_title, i.total_kobo AS issued_total_kobo,
            i.fee_kobo AS issued_fee_kobo, dv.name AS decided_vendor_name
       FROM requests r
       JOIN users u ON u.id = r.created_by
       LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN vendors dv ON dv.id = r.decided_vendor_id
       LEFT JOIN invoices i ON i.request_id = r.id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT 500`,
  ).bind(...binds).all();

  const ref = await loadReference(env);
  return json({ requests: (results || []).map((r) => decorate(r, ref)) });
}

function decorate(r, ref) {
  return {
    ...r,
    // Parsed here so every consumer sees an array, not a JSON string.
    ack_flags: JSON.parse(r.ack_flags || '[]'),
    site_label: r.site_code ? siteNameIn(ref, r.site_code) : null,
    bu_label: buNameIn(ref, r.bu_code),
    type_label: typeFor(r.type_code)?.label ?? r.type_code,
    period_label: periodLabel(r.period),
  };
}

async function createRequest(request, env, me) {
  // Members raise requests. An admin who is not also a member does not: their
  // job is the vendor rosters and a read-only view of the queue. Holding both
  // roles is normal and lets one person do both.
  const denied = requireOrg(me, 'client') || requireRole(me, 'member');
  if (denied) return denied;

  const b = await request.json().catch(() => ({}));
  const errors = [];

  const ref = activeOnly(await loadReference(env));
  const bu = ref.businessUnits.find((x) => x.code === b.bu_code);
  if (!bu) errors.push('Unknown business unit.');

  const type = typeFor(b.type_code);
  if (!type) errors.push('Unknown request type.');

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.period || '')) errors.push('Period must be YYYY-MM.');

  // Scope decides whether a site is required or must be absent. Storing NULL
  // for BU-scope keeps per-site spend reporting honest.
  let site_code = null;
  if (type?.scope === 'SITE') {
    if (!b.site_code) errors.push('Select a site.');
    else if (!(ref.buSites[b.bu_code] || []).includes(b.site_code))
      errors.push(`${b.site_code} is not a valid site for ${b.bu_code}.`);
    else site_code = b.site_code;
  }

  const amount_kobo = Number(b.amount_kobo);
  if (!Number.isInteger(amount_kobo) || amount_kobo <= 0) errors.push('Amount must be a positive whole number of kobo.');

  let asset_key = null;
  if (type?.extraField) {
    asset_key = String(b.asset_key || '').trim();
    if (!asset_key) errors.push(`${type.extraField.label} is required.`);
  }

  const description = String(b.description || '').trim();
  if (!description) errors.push('Description is required.');

  // Catches the live defect where a request addressed to Gbagada Clinic carried
  // the line "MTN Router For Surulere Clinic".
  if (site_code) {
    const wrong = ref.sites.find(
      (s) => s.code !== site_code && description.toLowerCase().includes(s.name.toLowerCase()),
    );
    if (wrong) errors.push(`Description names ${wrong.name} but the site is ${siteNameIn(ref, site_code)}.`);
  }

  // Period no more than one month ahead.
  if (/^\d{4}-\d{2}$/.test(b.period || '')) {
    const now = new Date();
    const limit = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const [y, mm] = b.period.split('-').map(Number);
    if (new Date(Date.UTC(y, mm - 1, 1)) > limit) errors.push('Period is too far in the future.');
  }

  if (errors.length) return fail('validation_failed', errors.join(' '), 422, { errors });

  // ── Submit-time warnings ──────────────────────────────────────────
  //
  // The gate is here, not on the approver's screen. Whatever reaches the queue
  // is duplicate-clean, and the approver's remaining job is correctness.
  //
  // An EXACT re-submission never gets this far -- the unique index refuses it
  // outright. What is left is the ambiguous cases: same period at a different
  // amount, and an amount wildly unlike the last approved one. Both are
  // probably wrong and occasionally fine, so they go to a human rather than
  // being silently allowed or bluntly refused.
  const warnings = [];

  const sibling = await activeSibling(env, type, b, { site_code, asset_key, amount_kobo });
  if (sibling) {
    warnings.push({
      key: 'duplicate_period',
      message:
        `${periodLabel(b.period)} ${type.label.toLowerCase()} for ` +
        `${type.scope === 'BU' ? buNameIn(ref, b.bu_code) : siteNameIn(ref, site_code)} already exists as ` +
        `${sibling.request_ref}, for ${naira(sibling.amount_kobo)}. This one is ` +
        `${naira(amount_kobo)}.`,
      existing: sibling,
    });
  }

  const variance = await amountVariance(env, type, b, { site_code, amount_kobo, ref });
  if (variance) warnings.push(variance);

  // `confirm` only clears warnings that were actually raised, and the flags
  // are computed here rather than taken from the payload -- a client cannot
  // post its own ack_flags, and confirming in advance still records what it
  // confirmed past.
  if (warnings.length && b.confirm !== true) {
    return fail(
      'confirm_required',
      warnings.length === 1 ? warnings[0].message
        : 'This request raised more than one warning. Check each before confirming.',
      409,
      { warnings },
    );
  }
  const ack_flags = JSON.stringify(warnings.map((w) => w.key));

  // INDICATIVE only. Which vendor will take this is not known yet and the fee
  // is the vendor's, so the figure that ends up billed is settled at approval
  // and written to invoices.fee_kobo. This is what the requester is shown.
  const cfg = await env.DB.prepare('SELECT * FROM config WHERE id = 1').first();
  const fee_kobo = cfg?.default_fee_kobo ?? 10000;
  const total_kobo = amount_kobo + fee_kobo;
  const addressee = String(b.addressee || '').trim() || (site_code ? siteNameIn(ref, site_code) : bu.name);
  const subject = String(b.subject || '').trim() || type.label;
  const narrative =
    String(b.narrative || '').trim() ||
    `Please find below the billing details for ${subject.toLowerCase()} for ${periodLabel(b.period)} by your organization:`;

  const request_ref = await nextRequestRef(env);

  try {
    const row = await env.DB.prepare(
      `INSERT INTO requests
         (request_ref, bu_code, site_code, type_code, period, asset_key,
          addressee, addressee_loc, subject, narrative, description,
          fee_kobo, amount_kobo, total_kobo, ack_flags, created_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
       RETURNING *`,
    ).bind(
      request_ref, b.bu_code, site_code, b.type_code, b.period, asset_key,
      addressee, String(b.addressee_loc || 'Lagos.'), subject, narrative, description,
      fee_kobo, amount_kobo, total_kobo, ack_flags, me.id,
    ).first();

    return json({ request: decorate(row, ref) }, 201);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return duplicateResponse(env, b, type, ref);
    throw e;
  }
}

/** Turn a bare constraint violation into something an operator can act on. */
/**
 * Tax on an invoice, from the issuing vendor's configuration.
 *
 * Rates are basis points, so the arithmetic stays in integer kobo throughout.
 *
 *   VAT  is ADDED   — the payer transfers amount + fee + VAT.
 *   WHT  is WITHHELD — the payer deducts it and remits it to the tax authority,
 *                      so it does not change the invoice total. It prints as a
 *                      separate line with a net-payable figure, because the
 *                      whole reason the money block spells everything out is
 *                      that AP transfers whatever number it sees first.
 *
 * `vat_basis` decides what is taxed: the whole invoice, or only the vendor's
 * fee where the bill itself is a third-party pass-through.
 */
function taxFor(cfg, amountKobo, feeKobo) {
  const base = cfg.vat_basis === 'fee' ? feeKobo : amountKobo + feeKobo;
  const vatKobo = Math.round(base * (cfg.vat_rate_bps || 0) / 10000);
  const whtKobo = Math.round(base * (cfg.wht_rate_bps || 0) / 10000);
  return { vatKobo, whtKobo, totalKobo: amountKobo + feeKobo + vatKobo };
}

/**
 * How sharply an amount may differ from the last approved comparable before the
 * requester is asked to confirm it.
 *
 * Deliberately loose. Nigerian utility bills are genuinely volatile, and a
 * threshold that fires on ordinary variation trains people to click through
 * warnings -- which would also destroy the duplicate warning sitting next to
 * it. Prefer too loose over too noisy, and retune once there is real history.
 */
const VARIANCE_FACTOR = 3;

/**
 * An active request with the same dedupe identity but a DIFFERENT amount.
 *
 * Keyed off the type's own `dedupe` list, so two routers at one site in one
 * month do not warn about each other -- their asset keys differ, which is
 * exactly why asset_key is in ROUTER's dedupe and not ELEC's.
 */
async function activeSibling(env, type, b, { site_code, asset_key, amount_kobo }) {
  const clauses = ["status IN ('pending','approved')", 'type_code = ?'];
  const binds = [type.code];
  const col = {
    site_code, bu_code: b.bu_code, period: b.period, asset_key,
  };
  for (const k of type.dedupe) {
    clauses.push(`${k} = ?`);
    binds.push(col[k]);
  }
  clauses.push('amount_kobo <> ?');
  binds.push(amount_kobo);

  return env.DB.prepare(
    `SELECT request_ref, amount_kobo, status, period
       FROM requests WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT 1`,
  ).bind(...binds).first();
}

/**
 * Catch the typo the approver has no incentive to catch.
 *
 * Approving an inflated amount costs the vendor nothing -- it over-funds the
 * wallet -- so by the same incentive logic that keeps duplicate policing out of
 * their hands, they are a weak check on an amount that is simply too high.
 * Compare against the last approved request of the same type for the same site
 * or BU. No history means no opinion: say nothing rather than warn on absence.
 */
async function amountVariance(env, type, b, { site_code, amount_kobo, ref }) {
  const scopeCol = type.scope === 'SITE' ? 'site_code' : 'bu_code';
  const scopeVal = type.scope === 'SITE' ? site_code : b.bu_code;
  if (!scopeVal) return null;

  const last = await env.DB.prepare(
    `SELECT amount_kobo, period FROM requests
      WHERE type_code = ?1 AND ${scopeCol} = ?2 AND status = 'approved'
      ORDER BY period DESC, id DESC LIMIT 1`,
  ).bind(type.code, scopeVal).first();

  if (!last?.amount_kobo) return null;

  const high = amount_kobo > last.amount_kobo * VARIANCE_FACTOR;
  const low  = amount_kobo * VARIANCE_FACTOR < last.amount_kobo;
  if (!high && !low) return null;

  const where = type.scope === 'BU' ? buNameIn(ref, b.bu_code) : siteNameIn(ref, site_code);
  return {
    key: 'amount_variance',
    message:
      `The last approved ${type.label.toLowerCase()} for ${where} was ` +
      `${naira(last.amount_kobo)} (${periodLabel(last.period)}). This one is ` +
      `${naira(amount_kobo)}. Confirm this is correct.`,
    previous: { amount_kobo: last.amount_kobo, period: last.period },
  };
}

async function duplicateResponse(env, b, type, ref) {
  const site = type.scope === 'SITE' ? b.site_code : null;
  const existing = await env.DB.prepare(
    `SELECT r.request_ref, r.status, i.invoice_no
       FROM requests r LEFT JOIN invoices i ON i.request_id = r.id
      WHERE r.type_code = ?1 AND r.period = ?2
        AND r.status IN ('pending','approved')
        AND (?3 IS NULL OR r.site_code = ?3)
        AND (?4 IS NULL OR r.bu_code   = ?4)
        AND (?5 IS NULL OR r.asset_key = ?5)
      LIMIT 1`,
  ).bind(
    b.type_code, b.period,
    site,
    type.scope === 'BU' ? b.bu_code : null,
    type.extraField ? String(b.asset_key || '').trim() : null,
  ).first();

  const what = type.scope === 'BU' ? buNameIn(ref, b.bu_code) : siteNameIn(ref, b.site_code);
  return fail(
    'duplicate_period',
    `${periodLabel(b.period)} ${type.label.toLowerCase()} for ${what} already exists.`,
    409,
    { existing: existing || null },
  );
}

async function nextRequestRef(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests').first();
  return `REQ-${String((row?.n ?? 0) + 1).padStart(6, '0')}`;
}

async function withdrawRequest(env, me, id) {
  const denied = requireOrg(me, 'client') || requireRole(me, 'member');
  if (denied) return denied;

  const r = await env.DB.prepare(
    `UPDATE requests SET status = 'withdrawn'
      WHERE id = ?1 AND created_by = ?2 AND status = 'pending'`,
  ).bind(id, me.id).run();

  if (!r.meta.changes) return fail('conflict', 'Only your own pending requests can be withdrawn.', 409);
  return json({ ok: true });
}

async function rejectRequest(request, env, me, id) {
  const denied = requireOrg(me, 'vendor') || requireRole(me, 'approver');
  if (denied) return denied;

  const { reason } = await request.json().catch(() => ({}));
  if (!reason || String(reason).trim().length < 3) {
    return fail('bad_request', 'A reason is required when rejecting.');
  }

  const r = await env.DB.prepare(
    `UPDATE requests
        SET status = 'rejected', decided_by = ?2, decided_vendor_id = ?4,
            decided_at = datetime('now'), reject_reason = ?3
      WHERE id = ?1 AND status = 'pending'`,
  ).bind(id, me.id, String(reason).trim(), me.vendor_id).run();

  if (!r.meta.changes) return fail('conflict', 'That request is no longer pending.', 409);
  return json({ ok: true });
}

/**
 * Per-scope high-water mark for invoice sequences, kept in KV.
 *
 * Nothing stored inside D1 can protect a sequence from D1 being rebuilt, and a
 * reused invoice number is rejected by the downstream approvals system, which
 * blocks a legitimate payment. KV is a separate store, so it survives that.
 *
 * This is a floor, never an authority: the sequence still comes from
 * `invoices`, and the UNIQUE indexes are still what actually prevent a
 * duplicate. If KV is unavailable the mark reads as 0 and issuing carries on
 * from D1 — degraded, not blocked.
 */
const SEQ_WATERMARK_KEY = 'seq/global';

async function seqWatermark(env, key) {
  try {
    const v = await env.ASSETS_KV.get(key);
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch (e) {
    console.warn('SEQ_WATERMARK_READ_FAILED', key, String(e));
    return 0;
  }
}

async function bumpSeqWatermark(env, key, seq) {
  try {
    if (seq > await seqWatermark(env, key)) await env.ASSETS_KV.put(key, String(seq));
  } catch (e) {
    console.warn('SEQ_WATERMARK_WRITE_FAILED', key, seq, String(e));
  }
}

// ── Approval: the only place an invoice number is created ──────────────

async function approveRequest(env, me, id) {
  // Only a vendor may approve. This is what makes the issued document the
  // vendor's own, rather than client self-issuing on someone's letterhead.
  const denied = requireOrg(me, 'vendor') || requireRole(me, 'approver');
  if (denied) return denied;

  const vendor = await env.DB.prepare(
    `SELECT * FROM vendors WHERE id = ?1 AND status = 'active'`,
  ).bind(me.vendor_id).first();
  if (!vendor) return fail('forbidden', 'Your organisation is suspended and cannot approve.', 403);

  const req = await env.DB.prepare('SELECT * FROM requests WHERE id = ?1').bind(id).first();
  if (!req) return fail('not_found', 'No such request.', 404);
  if (req.status !== 'pending') return fail('conflict', `Request is already ${req.status}.`, 409);
  if (req.created_by === me.id) {
    return fail('forbidden', 'You cannot approve a request you raised.', 403);
  }

  // The approving vendor's own bank details, signatory and fee.
  const cfg = await env.DB.prepare(
    'SELECT * FROM vendor_config WHERE vendor_id = ?1',
  ).bind(me.vendor_id).first();
  if (!cfg) return fail('not_configured', 'Your bank details have not been configured yet.', 503);

  // The fee belongs to the vendor, so the total is settled here, not at submit.
  const feeKobo = cfg.fee_kobo;
  const { vatKobo, whtKobo, totalKobo } = taxFor(cfg, req.amount_kobo, feeKobo);
  const platform = await env.DB.prepare(
    'SELECT org_name, seq_floor, instance_epoch FROM config WHERE id = 1').first();
  const cfgFloor = Number(platform?.seq_floor) || 0;

  // Claim this deployment's stamp the first time it issues anything. Written
  // once and never again: every number this system produces carries it, so
  // changing it later would orphan everything already issued.
  let epoch = platform?.instance_epoch || '';
  if (!epoch) {
    epoch = instanceEpoch();
    await env.DB.prepare(
      "UPDATE config SET instance_epoch = ?1 WHERE id = 1 AND instance_epoch = ''",
    ).bind(epoch).run();
    // Another approval may have won the race; whoever wrote first owns it.
    epoch = (await env.DB.prepare('SELECT instance_epoch FROM config WHERE id = 1').first())
      ?.instance_epoch || epoch;
    console.warn('INSTANCE_EPOCH_CLAIMED', epoch);
  }

  const site = numberingSiteIn(await loadReference(env), req.bu_code, req.site_code);

  // Optimistic reservation. If two approvers race, the UNIQUE indexes on
  // invoice_no and (bu, site, period, seq) reject the loser and we retry with
  // a fresh sequence. We never guess a number after a failure.
  const mark = SEQ_WATERMARK_KEY;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { seq: maxSeq } = (await env.DB.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM invoices',
    ).first()) || { seq: 0 };

    // The counter must never go backwards, even if `invoices` is emptied.
    //
    // A number that has been issued is already in the downstream approvals
    // system, which rejects a repeat — so re-issuing RFC/GBG/2026/SEP/001
    // after a mid-month rebuild does not just look untidy, it blocks payment.
    //
    // The high-water mark therefore lives in KV, a different store from D1: a
    // dropped or restored database does not take it with it. D1 remains the
    // source of truth when it is intact, so this only ever raises the floor.
    // Three floors, because each covers a failure the others cannot:
    //   maxSeq    D1, authoritative while the database is intact
    //   watermark KV, survives D1 being dropped or restored
    //   seq_floor configuration, survives the whole deployment being rebuilt
    //             on other infrastructure where neither store comes along
    const seq = Math.max(maxSeq, await seqWatermark(env, mark), cfgFloor) + 1;
    const invoice_no = invoiceRef({ seq, epoch });

    try {
      const [, updated] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO invoices
             (invoice_no, request_id, bu_code, site_code, period, seq,
              bank_account_name, bank_account_number, bank_name,
              signatory_name, signatory_title, issued_by,
              approver_name, approver_title, approver_phone, approver_email,
              vendor_id, amount_kobo, fee_kobo, total_kobo,
              vat_kobo, wht_kobo, tin, client_name)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
        ).bind(
          invoice_no, req.id, req.bu_code, site, req.period, seq,
          cfg.bank_account_name, cfg.bank_account_number, cfg.bank_name,
          cfg.signatory_name, cfg.signatory_title, me.id,
          // Signature block. Copied, not joined -- invariant 3.
          me.full_name, me.job_title, me.phone, me.email,
          me.vendor_id, req.amount_kobo, feeKobo, totalKobo,
          vatKobo, whtKobo, cfg.tin, platform?.org_name || null,
        ),
        env.DB.prepare(
          `UPDATE requests
              SET status = 'approved', decided_by = ?2, decided_vendor_id = ?3,
                  decided_at = datetime('now')
            WHERE id = ?1 AND status = 'pending'`,
        ).bind(req.id, me.id, me.vendor_id),
      ]);

      // Guard against approving something another approver just decided.
      if (!updated.meta.changes) return fail('conflict', 'That request was just decided by someone else.', 409);

      // Raise the mark only after the row is committed, so a failed attempt
      // never burns a number. A failure here is logged and swallowed: the
      // invoice exists and must be returned, and D1 still holds the sequence
      // for as long as it is intact.
      await bumpSeqWatermark(env, mark, seq);

      return json({ invoice_no, download: downloadName(invoice_no) }, 201);
    } catch (e) {
      if (String(e).includes('UNIQUE')) continue; // lost the race; recompute seq
      throw e;
    }
  }

  return fail('contention', 'Could not reserve an invoice number. Try again.', 503);
}

// ── Invoices and PDF ──────────────────────────────────────────────────

async function listInvoices(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT i.*, r.subject, r.description, r.total_kobo, r.type_code,
            u.full_name AS issued_by_name
       FROM invoices i
       JOIN requests r ON r.id = i.request_id
       JOIN users u ON u.id = i.issued_by
      ORDER BY i.issued_at DESC LIMIT 500`,
  ).all();
  return json({ invoices: results || [] });
}

async function invoicePdf(env, me, invoiceNo) {
  // Any user of the ISSUING vendor may regenerate -- it is their letterhead,
  // and the document is unchanged by who asks for it: the approver's details
  // and the money come off the invoices row, not from this session. So a
  // colleague re-downloading months later still produces the original signed
  // document. The client cannot reach this route, and neither can another vendor.
  const denied = requireOrg(me, 'vendor');
  if (denied) return denied;

  // Resolves an ISSUED invoice only. There is deliberately no route that
  // renders letterhead from ad-hoc field values or from a pending request.
  // Note the money comes from i.*, not r.*: the request's figures were
  // indicative before a vendor took it.
  const row = await env.DB.prepare(
    `SELECT i.*, r.addressee, r.addressee_loc, r.subject, r.narrative, r.description,
            r.type_code, r.asset_key, v.code AS vendor_code, v.name AS vendor_name,
            v.template_json
       FROM invoices i
       JOIN requests r ON r.id = i.request_id
       JOIN vendors v ON v.id = i.vendor_id
      WHERE i.invoice_no = ?1`,
  ).bind(invoiceNo).first();

  if (!row) return fail('not_found', 'No such invoice.', 404);
  // Not 403: a vendor should not learn that another vendor's invoice exists.
  if (row.vendor_id !== me.vendor_id) return fail('not_found', 'No such invoice.', 404);

  const type = typeFor(row.type_code);
  // The vendor's own layout. A row with no template renders the default.
  let tpl = null;
  try { tpl = row.template_json ? JSON.parse(row.template_json) : null; } catch { tpl = null; }
  const merged = mergeTemplate(tpl);
  const assets = await loadAssets(env, row.vendor_code, row.contact_lines,
                                  merged.artwork, merged.type.family);

  const bytes = await renderInvoice({
    bu_code: row.bu_code,
    site_code: row.site_code,
    period: row.period,
    seq: row.seq,
    addressee: row.addressee,
    addressee_loc: row.addressee_loc,
    subject: row.subject,
    narrative: row.narrative,
    extra_column_label: type?.extraField?.label ?? null,
    lines: [{
      description: row.description,
      extra: row.asset_key || '',
      amount_kobo: row.amount_kobo,
    }],
    amount_kobo: row.amount_kobo,
    fee_kobo: row.fee_kobo,
    total_kobo: row.total_kobo,
    bank_account_name: row.bank_account_name,
    bank_account_number: row.bank_account_number,
    bank_name: row.bank_name,
    signatory_name: row.signatory_name,
    signatory_title: row.signatory_title,
    approver_name: row.approver_name,
    approver_title: row.approver_title,
    approver_phone: row.approver_phone,
    approver_email: row.approver_email,
    vendor_name: row.vendor_name,
    client_name: row.client_name,
    vat_kobo: row.vat_kobo,
    wht_kobo: row.wht_kobo,
    tin: row.tin,
    issued_at: row.issued_at.replace(' ', 'T') + 'Z',
  }, assets, tpl);

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${downloadName(invoiceNo)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

const assetCache = new Map();   // vendor code -> loaded artwork + fonts

/**
 * Letterhead artwork and fonts from KV, cached per vendor in the isolate.
 *
 * Artwork is namespaced by the vendor code (`<code>/header.png`); the fonts
 * are shared, because they are ours rather than the vendor's. Contact lines are
 * live text from the vendors row, not a raster: in the original source
 * template that image ran 123pt off the page edge and clipped the address.
 */
async function loadAssets(env, vendorCode, contactLinesJson, artwork, family = 'sans') {
  const key = `${vendorCode}:${family}`;
  const cached = assetCache.get(key);
  if (cached) return cached;

  const get = async (key, required = true) => {
    const buf = await env.ASSETS_KV.get(key, 'arrayBuffer');
    if (!buf) {
      if (required) throw new Error(`Missing asset in KV: ${key}`);
      return null;
    }
    return new Uint8Array(buf);
  };

  // Only what this vendor's template actually places. A template referencing
  // artwork that has not been uploaded yet renders without that band rather
  // than failing the download outright.
  const art = {};
  for (const a of artwork) {
    const bytes = await get(`${vendorCode}/${a.asset}.png`, false);
    if (bytes) art[a.asset] = bytes;
  }

  // Fonts are shared across vendors, so they are stored unprefixed. A family
  // whose files have not been uploaded falls back to sans rather than failing
  // the download: the wrong typeface is recoverable, a missing invoice is not.
  const want = fontKeys(family);
  let fontRegular = await get(want.regular, false);
  let fontBold    = await get(want.bold, false);
  if (!fontRegular || !fontBold) {
    const fb = fontKeys(FALLBACK_FONT);
    fontRegular = await get(fb.regular);
    fontBold    = await get(fb.bold);
  }

  const assets = {
    artwork: art,
    fontRegular,
    fontBold,
    contact: JSON.parse(contactLinesJson || '[]'),
  };
  assetCache.set(key, assets);
  return assets;
}

// ── Config ────────────────────────────────────────────────────────────

/**
 * A vendor's bank, signatory and tax details, maintained by the client admin.
 *
 * Bank details decide where money lands, so this is the highest-risk mutable
 * field in the system and it now sits inside the client's own blast radius: a
 * compromised admin session could redirect a vendor's payments, and the
 * invoice would look perfectly legitimate because the details are copied at
 * issue. That is a deliberate trade for having one administrator rather than
 * two, and `BANK_DETAILS_CHANGED` exists precisely so the change is visible
 * afterwards. Wire that log to a real notification before go-live.
 */
async function updateVendorConfig(request, env, me, vendorId) {
  const denied = requireRosterAdmin(me);
  if (denied) return denied;

  const vendor = await env.DB.prepare('SELECT * FROM vendors WHERE id = ?1')
    .bind(vendorId).first();
  if (!vendor) return fail('not_found', 'No such vendor.', 404);

  const b = await request.json().catch(() => ({}));
  const fields = ['bank_account_name', 'bank_account_number', 'bank_name', 'signatory_name', 'signatory_title'];
  for (const f of fields) {
    if (!String(b[f] || '').trim()) return fail('bad_request', `${f} is required.`);
  }
  const fee = Number(b.fee_kobo);
  if (!Number.isInteger(fee) || fee < 0) return fail('bad_request', 'fee_kobo must be a whole number of kobo.');

  const tax = parseTax(b);
  if (tax.error) return fail('bad_request', tax.error);

  const before = await env.DB.prepare(
    'SELECT * FROM vendor_config WHERE vendor_id = ?1',
  ).bind(vendorId).first();

  await env.DB.prepare(
    `UPDATE vendor_config SET bank_account_name=?1, bank_account_number=?2, bank_name=?3,
            fee_kobo=?4, signatory_name=?5, signatory_title=?6,
            tin=?7, vat_rate_bps=?8, wht_rate_bps=?9, vat_basis=?10,
            updated_at=datetime('now'), updated_by=?11
      WHERE vendor_id = ?12`,
  ).bind(
    b.bank_account_name.trim(), b.bank_account_number.trim(), b.bank_name.trim(),
    fee, b.signatory_name.trim(), b.signatory_title.trim(),
    tax.tin, tax.vat, tax.wht, tax.basis, me.email, vendorId,
  ).run();

  // Already-issued invoices keep their own copy of these values, so this
  // change cannot alter a document that has already gone out.
  const bankChanged =
    before && (before.bank_account_number !== b.bank_account_number.trim() ||
               before.bank_account_name !== b.bank_account_name.trim() ||
               before.bank_name !== b.bank_name.trim());

  if (bankChanged) {
    console.warn('BANK_DETAILS_CHANGED', JSON.stringify({
      vendor: vendor.code,
      by: me.email, at: new Date().toISOString(),
      from: { name: before.bank_account_name, number: before.bank_account_number, bank: before.bank_name },
      to:   { name: b.bank_account_name, number: b.bank_account_number, bank: b.bank_name },
    }));
  }

  const after = await env.DB.prepare(
    'SELECT * FROM vendor_config WHERE vendor_id = ?1',
  ).bind(vendorId).first();
  return json({ config: after, bankChanged: !!bankChanged });
}
