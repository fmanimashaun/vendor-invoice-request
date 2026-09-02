#!/usr/bin/env node
/**
 * Smoke-test a DEPLOYED instance over HTTP.
 *
 * `npm test` runs the Worker handler in-process against a SQLite shim. It
 * proves the logic and it cannot prove the deployment: a stale database, a
 * missing KV binding, an asset that never uploaded, a route bound to nothing
 * all pass every one of those 340 assertions and still give you a white page.
 * This walks the real thing over the wire.
 *
 * READ-ONLY, deliberately. It signs in and reads; it never creates a request,
 * never approves one, never writes config. A test that issues an invoice
 * against production burns a number out of the live sequence, and that number
 * is what the downstream approvals system keys on. If you extend this, keep it
 * to GETs.
 *
 *   SMOKE_EMAIL=admin@example.com SMOKE_PASSWORD=... \
 *     node scripts/smoke.mjs https://app.example.com
 *
 * Credentials come from the environment so they stay out of the repo and out
 * of your shell history. Without them it runs the unauthenticated checks only,
 * which is still enough to catch a dead deployment.
 */
const BASE = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
// Long enough to clear a cold start, short enough that a hang reports as a
// hang instead of sitting there looking like slow work.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT || 20000);

if (!BASE) {
  console.error('usage: node scripts/smoke.mjs https://app.example.com');
  process.exit(2);
}

let cookie = '';
let pass = 0;
const failures = [];

const ok   = (m) => { pass++; console.log(`  \x1b[32mok\x1b[0m   ${m}`); };
const bad  = (m) => { failures.push(m); console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function req(path, { method = 'GET', body } = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctl.signal,
      redirect: 'manual',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Keep the session for later calls.
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    const bytes = data ? 0 : (await res.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength;
    return { status: res.status, data, bytes, type, ms: Date.now() - started };
  } catch (err) {
    return {
      status: 0, data: null, bytes: 0, type: '', ms: Date.now() - started,
      error: err.name === 'AbortError' ? `no response in ${TIMEOUT_MS}ms` : err.message,
    };
  } finally { clearTimeout(timer); }
}

/** Assert a status, and say what came back when it is not the one wanted. */
async function expect(label, path, want, opts) {
  const r = await req(path, opts);
  const wants = Array.isArray(want) ? want : [want];
  const detail = r.error ? ` — ${r.error}`
    : ` — ${r.data?.error ? `${r.data.error}: ${r.data.message}` : `${r.bytes} bytes`}`;
  if (wants.includes(r.status)) ok(`${label} (${r.status}, ${r.ms}ms)`);
  else bad(`${label} — wanted ${wants.join(' or ')}, got ${r.status}${detail}`);
  return r;
}

const run = async () => {
  console.log(`\nSmoke test: ${BASE}`);

  head('Reachable, and serving the app');
  const page = await req('/');
  if (page.status === 200) ok(`index.html (${page.status}, ${page.ms}ms)`);
  else bad(`index.html — got ${page.status}${page.error ? ` — ${page.error}` : ''}`);

  head('Public routes');
  const methods = await expect('GET /api/auth/methods', '/api/auth/methods', 200);
  if (methods.data) {
    const m = methods.data;
    // The login screen renders off this. If neither method is on, nobody can
    // sign in and the app is a white page with no way forward.
    if (m.password || m.sso) ok(`a sign-in method is enabled (password=${!!m.password} sso=${!!m.sso})`);
    else bad('NO sign-in method is enabled — nobody can get in');
  }

  head('Session is actually required');
  // If any of these answer 200 without a cookie, the auth gate is not doing
  // its job and every request in the system is public.
  await expect('GET /api/bootstrap  unauthenticated', '/api/bootstrap', 401);
  await expect('GET /api/requests   unauthenticated', '/api/requests', 401);
  await expect('GET /api/vendors    unauthenticated', '/api/vendors', 401);
  await expect('GET /api/audit      unauthenticated', '/api/audit', 401);

  if (!EMAIL || !PASSWORD) {
    head('Signed-in checks skipped');
    console.log('  set SMOKE_EMAIL and SMOKE_PASSWORD to run them');
    return;
  }

  head(`Signing in as ${EMAIL}`);
  const login = await req('/api/auth/login', {
    method: 'POST', body: { email: EMAIL, password: PASSWORD },
  });
  if (login.status !== 200 || !cookie) {
    bad(`login — ${login.status}${login.error ? ` ${login.error}` : ''}`
      + `${login.data ? ` ${login.data.error}: ${login.data.message}` : ''}`);
    return;
  }
  ok(`login (${login.ms}ms)`);
  const user = login.data?.user || {};
  console.log(`       ${user.full_name} · ${user.org} · roles=${(user.roles || []).join()}`
    + ` · acting=${user.context}`);

  head('What the app calls on boot');
  // This is the exact sequence App.jsx runs before it will render anything.
  // A white "Loading…" screen means one of these never came back.
  const boot = await expect('GET /api/bootstrap', '/api/bootstrap', 200);
  await expect('GET /api/requests', '/api/requests', 200);
  await expect('GET /api/me', '/api/me', 200);

  if (boot.data) {
    const b = boot.data;
    // The payload is flat. Assert against what the Worker actually sends —
    // a smoke test that checks an imagined shape reports five failures on a
    // healthy deployment and teaches you to ignore it.
    const shape = [
      ['user', b.user],
      ['user.context', b.user?.context],
      ['user.roles', b.user?.roles?.length ? b.user.roles : null],
      ['orgName', b.orgName || null],
      ['businessUnits', b.businessUnits],
      ['sites', b.sites],
      ['buSites', b.buSites],
      ['requestTypes', b.requestTypes],
      ['feeKobo', b.feeKobo],
    ];
    for (const [name, v] of shape) {
      if (v === undefined || v === null) bad(`bootstrap is missing ${name}`);
      else ok(`bootstrap carries ${name}`);
    }
    // Populated tables are not a correctness property, but an empty one means
    // the request form has nothing to offer and the first person to open it
    // concludes the app is broken.
    const bus = b.businessUnits?.length ?? 0;
    const sites = b.sites?.length ?? 0;
    // buSites is a map of bu_code -> [site_code], not an array. Counting it
    // with .length silently yields 0 and reports a healthy deployment broken.
    const map = Object.values(b.buSites || {}).reduce((n, v) => n + (v?.length || 0), 0);
    // Every unit needs at least one site or its cascade comes up empty.
    const unmapped = (b.businessUnits || [])
      .filter((u) => !(b.buSites?.[u.code] || []).length).map((u) => u.code);
    if (unmapped.length) bad(`business units with no sites mapped: ${unmapped.join(', ')}`
      + ' — picking one leaves the site list empty');
    else ok('every business unit has at least one site');
    if (bus && sites && map) ok(`reference is populated (${bus} units, ${sites} sites, ${map} mappings)`);
    else bad(`reference is thin (${bus} units, ${sites} sites, ${map} mappings)`
      + ' — the request form will have nothing to pick');
    // A business unit whose numbering site is not a real site cannot produce a
    // ref for its BU-scope requests.
    const codes = new Set((b.sites || []).map((x) => x.code));
    const orphans = (b.businessUnits || [])
      .filter((u) => u.numberingSite && !codes.has(u.numberingSite))
      .map((u) => `${u.code}->${u.numberingSite}`);
    if (orphans.length) bad(`numbering site is not a real site: ${orphans.join(', ')}`);
    else ok('every business unit points at a real numbering site');
  }

  const acting = user.context;
  const isClient = user.org === 'client';

  if (isClient && acting === 'admin') {
    head('Admin screens');
    await expect('GET /api/vendors', '/api/vendors', 200);
    await expect('GET /api/users', '/api/users', 200);
    await expect('GET /api/reference', '/api/reference', 200);
    await expect('GET /api/fonts', '/api/fonts', 200);
    await expect('GET /api/numbering', '/api/numbering', 200);
    const y = new Date().getUTCFullYear();
    await expect('GET /api/summary', `/api/summary?from=${y}-01-01&to=${y}-12-31`, 200);

    head('Audit trail');
    const audit = await expect('GET /api/audit', '/api/audit', 200);
    if (audit.data) {
      const n = audit.data.entries?.length ?? 0;
      console.log(`       ${n} entries, ${audit.data.total ?? 0} total`);
      // Append-only is a property of the routing table, not a promise.
      for (const method of ['POST', 'PUT', 'DELETE']) {
        await expect(`${method} /api/audit is not a route`, '/api/audit', 404, { method });
      }
      // A log that leaks credentials is a liability, not a control.
      const dump = JSON.stringify(audit.data.entries || []);
      const leaks = ['pw_hash', 'pw_salt'].filter((k) => dump.includes(k));
      if (leaks.length) bad(`the audit trail contains ${leaks.join(', ')}`);
      else ok('no password hashes or salts in the trail');
    }

    head('The admin must NOT be able to issue or read a document');
    // The whole point of the system: the payer cannot produce its own
    // evidence. A 200 here would make every invoice worthless as audit
    // defence, so this is the most important assertion in the file.
    await expect('POST /api/requests/1/approve  is refused', '/api/requests/1/approve',
      [403, 404], { method: 'POST' });
    await expect('GET  /api/invoices/1/pdf      is refused', '/api/invoices/1/pdf', [403, 404]);
  }

  if (!isClient) {
    head('Vendor screens');
    await expect('GET /api/requests?status=pending', '/api/requests?status=pending', 200);
    head('A vendor must NOT be able to manage the roster or read the trail');
    await expect('GET /api/users  is refused', '/api/users', 403);
    await expect('GET /api/vendors is refused', '/api/vendors', 403);
    await expect('GET /api/audit  is refused', '/api/audit', 403);
  }

  head('Signing out');
  await expect('POST /api/auth/logout', '/api/auth/logout', 200, { method: 'POST' });
  cookie = '';
  await expect('GET /api/bootstrap  after logout', '/api/bootstrap', 401);
};

run()
  .catch((err) => bad(`smoke test threw: ${err.stack || err}`))
  .finally(() => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exit(failures.length ? 1 : 0);
  });
