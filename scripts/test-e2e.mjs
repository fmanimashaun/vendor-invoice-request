// End-to-end test of the Worker against a real SQLite database.
// Exercises the actual HTTP handler — routes, roles, validation, duplicate
// guards, invoice numbering, and PDF rendering.
//
//   npm test

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker, { resolveOrProvisionSsoUser } from '../worker/worker.js';
import { hashPassword } from '../worker/auth.js';
import { D1Shim, KVShim } from './d1-shim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = process.env.ASSET_DIR || join(ROOT, 'assets');
// The renderer needs a font carrying the Naira glyph U+20A6. Production uses
// Arimo; DejaVu has it too and is what CI has. Override on a machine with
// neither -- Arial (which Arimo is metric-compatible with) also works.
const FONT_DIR = process.env.FONT_DIR || '/usr/share/fonts/truetype/dejavu';
const FONT_REGULAR = process.env.FONT_REGULAR || join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = process.env.FONT_BOLD || join(FONT_DIR, 'DejaVuSans-Bold.ttf');

let pass = 0, fail = 0;
const results = [];

function check(name, condition, detail = '') {
  if (condition) { pass++; results.push(`  ok    ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); }
}

// ── Environment ───────────────────────────────────────────────────────

const DB = new D1Shim();
DB.exec(readFileSync(join(ROOT, 'migrations/0001_init.sql'), 'utf8'));

const kv = new KVShim();
for (const [key, file] of [
  ['header.png', 'header.png'],
  ['footer.png', 'footer.png'],
  ['logo.png', 'logo.png'],
  ['tagline_services.png', 'tagline_services.png'],
  ['tagline_slogan.png', 'tagline_slogan.png'],
]) {
  const p = join(ASSET_DIR, file);
  if (!existsSync(p)) {
    console.error(`Missing asset ${p}. Run scripts/extract-assets.py first.`);
    process.exit(1);
  }
  // Artwork is namespaced per vendor, because each issues on its own
  // letterhead. Both seeded vendors get the same stand-in art here.
  for (const vendorCode of ['alpha', 'northwind', 'taxed']) {
    kv.put(`${vendorCode}/${key}`, new Uint8Array(readFileSync(p)));
  }
}
// Production uses Arimo (Arial-metric, has ₦). DejaVu also has ₦ and is what
// is available here. Liberation Sans does NOT and would drop the symbol.
kv.put('Arimo-Regular.ttf', new Uint8Array(readFileSync(FONT_REGULAR)));
kv.put('Arimo-Bold.ttf', new Uint8Array(readFileSync(FONT_BOLD)));

const env = { DB, ASSETS_KV: kv, SESSION_SECRET: 'test-secret-not-for-production' };

// ── Seed ──────────────────────────────────────────────────────────────

DB.db.exec(`
  -- Locations, seeded from shared/reference.js SEED_* just as seed.sql does.
  INSERT INTO sites (code, name) VALUES
  ('LEK','Lekki Clinic'),
  ('IKD','Ikorodu Clinic'),
  ('ABJ','Abuja Clinic'),
  ('OGB','Ogba Clinic'),
  ('AJA','Ajah Clinic'),
  ('EJG','Ejigbo Clinic'),
  ('SUR','Surulere Clinic'),
  ('AKO','Akowonjo Clinic'),
  ('PHC','Port Harcourt Clinic'),
  ('GBG','Gbagada Clinic'),
  ('HQ','Head Office');

  INSERT INTO business_units (code, name, numbering_site) VALUES
  ('RFC','client Family Clinic','LEK'),
  ('REX','Retail','LEK'),
  ('RHMO','Health Services','HQ');

  INSERT INTO bu_sites (bu_code, site_code) VALUES
  ('RFC','LEK'),
  ('RFC','IKD'),
  ('RFC','ABJ'),
  ('RFC','OGB'),
  ('RFC','AJA'),
  ('RFC','EJG'),
  ('RFC','SUR'),
  ('RFC','AKO'),
  ('RFC','PHC'),
  ('RFC','GBG'),
  ('REX','LEK'),
  ('RHMO','HQ');

  INSERT INTO config (id, default_fee_kobo) VALUES (1, 10000);

  INSERT INTO vendors (id, code, name, contact_lines)
  VALUES (1, 'alpha', 'Alpha Services Ltd',
          '["Address: 1 Example Street,","Lagos"]');

  INSERT INTO vendor_config (vendor_id, bank_account_name, bank_account_number,
                             bank_name, fee_kobo, signatory_name, signatory_title)
  VALUES (1, 'Alpha Services Ltd', '0123456789', 'Example Bank', 10000,
          'An Approver', 'Business Development Manager');

  -- A second vendor, to prove decided work is scoped and the queue is shared.
  INSERT INTO vendors (id, code, name, contact_lines)
  VALUES (2, 'northwind', 'Northwind Utilities', '["Address: 4 Ikoyi Road, Lagos"]');

  INSERT INTO vendor_config (vendor_id, bank_account_name, bank_account_number,
                             bank_name, fee_kobo, signatory_name, signatory_title)
  VALUES (2, 'Northwind Utilities Ltd', '1234567890', 'GTBank', 25000,
          'Ngozi Eze', 'Director');
`);

const pw = await hashPassword('correct-horse-battery');
DB.db.prepare(
  `INSERT INTO users (email, full_name, org, vendor_id, role, job_title, phone,
                      pw_hash, pw_salt, pw_iterations)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('approver@alpha.example', 'An Approver', 'vendor', 1, 'approver',
      'Business Development Manager', '+234 803 555 0142', pw.hash, pw.salt, pw.iterations);

const pw2 = await hashPassword('another-long-password');
DB.db.prepare(
  `INSERT INTO users (email, full_name, org, vendor_id, role, job_title, phone,
                      pw_hash, pw_salt, pw_iterations)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('admin@alpha.example', 'Alpha Admin', 'vendor', 1, 'admin',
      'Operations Director', '+234 803 555 0199', pw2.hash, pw2.salt, pw2.iterations);

// A rival vendor's approver: sees the same queue, none of the other vendor's history.
const pw3 = await hashPassword('northwind-long-password');
DB.db.prepare(
  `INSERT INTO users (email, full_name, org, vendor_id, role, job_title, phone,
                      pw_hash, pw_salt, pw_iterations)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('ngozi@northwind.com', 'Ngozi Eze', 'vendor', 2, 'approver',
      'Director', '+234 805 222 3333', pw3.hash, pw3.salt, pw3.iterations);

DB.db.prepare(
  `INSERT INTO users (email, full_name, org, role) VALUES (?,?,?,?)`,
).run('requester@client.example', 'A Requester', 'client', 'requester');

DB.db.prepare(
  `INSERT INTO users (email, full_name, org, role) VALUES (?,?,?,?)`,
).run('roster.admin@client.example', 'Roster Admin', 'client', 'admin');

// ── Request helpers ───────────────────────────────────────────────────

const cookies = {};

async function call(who, path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookies[who]) headers.Cookie = cookies[who];
  // client users arrive via Cloudflare Access. Rather than mint a signed
  // Access JWT here, we give them a password-path session directly; the route
  // logic downstream is identical.
  const req = new Request(`https://app.test${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, {});
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie) cookies[who] = setCookie.split(';')[0];
  const ct = res.headers.get('Content-Type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null)
             : ct.includes('pdf') ? new Uint8Array(await res.arrayBuffer())
             : await res.text();
  return { status: res.status, data, headers: res.headers };
}

/** Give a user a session without going through Access. */
async function sessionFor(who, email) {
  const { signSession, sessionCookie } = await import('../worker/auth.js');
  const row = DB.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const token = await signSession({ uid: row.id }, env.SESSION_SECRET);
  cookies[who] = sessionCookie(token).split(';')[0];
}

// ══ Tests ═════════════════════════════════════════════════════════════

results.push('\nAuthentication');

let r = await call('anon', '/api/bootstrap');
check('unauthenticated bootstrap is rejected', r.status === 401, `got ${r.status}`);

r = await call('victor', '/api/auth/login', { method: 'POST', body: { email: 'approver@alpha.example', password: 'wrong' } });
check('wrong password rejected', r.status === 401);

r = await call('victor', '/api/auth/login', { method: 'POST', body: { email: 'approver@alpha.example', password: 'correct-horse-battery' } });
check('vendor password login works', r.status === 200 && r.data.user.org === 'vendor', JSON.stringify(r.data));
check('the session carries which vendor the person acts for',
  r.data?.user?.vendor_code === 'alpha', JSON.stringify(r.data?.user));

r = await call('rel', '/api/auth/login', { method: 'POST', body: { email: 'requester@client.example', password: 'anything' } });
check('client SSO user cannot password-login', r.status === 401);

await sessionFor('rel', 'requester@client.example');
await sessionFor('admin', 'admin@alpha.example');
await sessionFor('reladmin', 'roster.admin@client.example');
await sessionFor('rival', 'ngozi@northwind.com');

r = await call('rel', '/api/bootstrap');
check('client bootstrap succeeds', r.status === 200 && r.data.user.org === 'client');
check('client does not receive bank details', r.data.config === undefined);

r = await call('victor', '/api/bootstrap');
check('the vendor receives bank details', !!r.data.config?.bank_account_number);

results.push('\nRole separation');

r = await call('victor', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'LEK', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 100, description: 'x' },
});
check('a vendor cannot raise a request', r.status === 403, `got ${r.status}`);

results.push('\nValidation');

const base = { bu_code: 'RFC', site_code: 'GBG', type_code: 'ROUTER', period: '2026-09', amount_kobo: 7500000 };

r = await call('rel', '/api/requests', { method: 'POST', body: { ...base, description: 'MTN Router For Gbagada Clinic' } });
check('router without a number is rejected', r.status === 422, JSON.stringify(r.data));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', description: 'MTN Router For Surulere Clinic' },
});
check('addressee/site mismatch is caught', r.status === 422 && /Surulere/.test(r.data.message), JSON.stringify(r.data));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, site_code: 'HQ', asset_key: '08148648357', description: 'MTN Router' },
});
check('site not permitted for the BU is rejected', r.status === 422);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 100, description: 'Electricity' },
});
check('SITE-scope type requires a site', r.status === 422);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', amount_kobo: 0, description: 'MTN Router For Gbagada Clinic' },
});
check('zero amount is rejected', r.status === 422);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', period: '2027-06', description: 'MTN Router For Gbagada Clinic' },
});
check('far-future period is rejected', r.status === 422);

results.push('\nRequest creation and duplicate guards');

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', description: 'MTN Router For Gbagada Clinic' },
});
check('valid router request created', r.status === 201, JSON.stringify(r.data));
const routerReqId = r.data?.request?.id;
check('total = amount + fee', r.data?.request?.total_kobo === 7510000, String(r.data?.request?.total_kobo));
check('request_ref assigned', /^REQ-\d{6}$/.test(r.data?.request?.request_ref || ''));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', description: 'MTN Router For Gbagada Clinic' },
});
check('an EXACT re-submission is blocked outright',
  r.status === 409 && r.data.error === 'duplicate_period', JSON.stringify(r.data));
check('the block names the existing request', !!r.data?.existing?.request_ref);

// Same identity, different amount: a judgement call, so it warns instead.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', amount_kobo: 8000000, description: 'MTN Router For Gbagada Clinic' },
});
check('same period at a different amount warns rather than blocking',
  r.status === 409 && r.data.error === 'confirm_required', JSON.stringify(r.data));
check('the warning says which request it clashes with',
  (r.data?.warnings || []).some((w) => w.key === 'duplicate_period' && w.existing?.request_ref),
  JSON.stringify(r.data?.warnings));
check('and nothing was inserted',
  DB.db.prepare('SELECT COUNT(*) c FROM requests WHERE amount_kobo = 8000000').get().c === 0);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', amount_kobo: 8000000, confirm: true, description: 'MTN Router For Gbagada Clinic' },
});
check('confirming lets it through', r.status === 201, JSON.stringify(r.data));
check('and the override is recorded against the request',
  (r.data?.request?.ack_flags || []).includes('duplicate_period'),
  JSON.stringify(r.data?.request?.ack_flags));

// A client cannot post its own flags: the server computes them.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08111000222', period: '2026-07', ack_flags: '["amount_variance"]',
          description: 'MTN Router For Gbagada Clinic' },
});
check('ack_flags in the payload are ignored',
  r.status === 201 && (r.data?.request?.ack_flags || []).length === 0,
  JSON.stringify(r.data?.request?.ack_flags));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08099999999', description: 'MTN Router For Gbagada Clinic' },
});
check('different router, same site allowed, with no warning', r.status === 201,
  JSON.stringify(r.data));
check('a second router does not warn about the first',
  (r.data?.request?.ack_flags || []).length === 0, JSON.stringify(r.data?.request?.ack_flags));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { ...base, asset_key: '08148648357', period: '2026-08', description: 'MTN Router For Gbagada Clinic' },
});
check('same router, different month allowed', r.status === 201);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'SUR', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 25000000, description: 'Electricity Bill For Surulere Clinic' },
});
check('electricity at Surulere created', r.status === 201);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'SUR', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 25000000, description: 'Electricity Bill For Surulere Clinic' },
});
check('an identical second September electricity bill is blocked',
  r.status === 409 && r.data.error === 'duplicate_period', JSON.stringify(r.data));

// A typo'd meter number must NOT slip a duplicate through: the meter is
// printed but is deliberately not part of ELEC's dedupe key.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'SUR', type_code: 'ELEC', asset_key: '04521187999',
          period: '2026-09', amount_kobo: 25000000, description: 'Electricity Bill For Surulere Clinic' },
});
check('a different meter number does not slip an identical bill through',
  r.status === 409 && r.data.error === 'duplicate_period', JSON.stringify(r.data));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', type_code: 'STAFFDC', period: '2026-09', amount_kobo: 12600000, description: 'Staff Data & Credit For client Family Clinic' },
});
check('BU-scope staff data created', r.status === 201, JSON.stringify(r.data));
check('BU-scope stores NULL site_code', r.data?.request?.site_code === null, String(r.data?.request?.site_code));
const staffReqId = r.data?.request?.id;

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', type_code: 'STAFFDC', period: '2026-09', amount_kobo: 1, description: 'Staff Data & Credit For client Family Clinic' },
});
check('second RFC staff data for September blocked', r.status === 409);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'REX', type_code: 'STAFFDC', period: '2026-09', amount_kobo: 8100000, description: 'Staff Data & Credit For Retail' },
});
check('Retail staff data for the same month allowed', r.status === 201);

results.push('\nApproval and numbering');

r = await call('rel', `/api/requests/${routerReqId}/approve`, { method: 'POST' });
check('The client cannot approve', r.status === 403, `got ${r.status}`);

r = await call('victor', `/api/requests/${routerReqId}/approve`, { method: 'POST' });
check('vendor approval issues an invoice', r.status === 201, JSON.stringify(r.data));
check('invoice number format', r.data?.invoice_no === 'RFC/GBG/2026/SEP/001', r.data?.invoice_no);
check('download name flattens slashes', r.data?.download === 'RFC-GBG-2026-SEP-001.pdf', r.data?.download);
const routerInvoice = r.data?.invoice_no;

r = await call('victor', `/api/requests/${routerReqId}/approve`, { method: 'POST' });
check('double approval blocked', r.status === 409, `got ${r.status}`);

r = await call('victor', `/api/requests/${staffReqId}/approve`, { method: 'POST' });
check('BU-scope numbers against the BU numbering site', r.data?.invoice_no === 'RFC/LEK/2026/SEP/001', r.data?.invoice_no);

// Independent counters per (BU, site, period).
const surElec = DB.db.prepare(
  `SELECT id FROM requests WHERE type_code='ELEC' AND site_code='SUR' AND status='pending'`,
).get();
r = await call('victor', `/api/requests/${surElec.id}/approve`, { method: 'POST' });
check('Surulere gets its own sequence 001', r.data?.invoice_no === 'RFC/SUR/2026/SEP/001', r.data?.invoice_no);

const rexStaff = DB.db.prepare(
  `SELECT id FROM requests WHERE bu_code='REX' AND status='pending'`,
).get();
r = await call('victor', `/api/requests/${rexStaff.id}/approve`, { method: 'POST' });
check('Retail numbers under REX/LEK', r.data?.invoice_no === 'REX/LEK/2026/SEP/001', r.data?.invoice_no);

// A second Gbagada router in the same month should take seq 002.
const gbg2 = DB.db.prepare(
  `SELECT id FROM requests WHERE asset_key='08099999999' AND status='pending'`,
).get();
r = await call('victor', `/api/requests/${gbg2.id}/approve`, { method: 'POST' });
check('sequence increments within a scope', r.data?.invoice_no === 'RFC/GBG/2026/SEP/002', r.data?.invoice_no);

results.push('\nRejection frees the period');

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'AJA', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 5000000, description: 'Electricity Bill For Ajah Clinic' },
});
const ajaId = r.data?.request?.id;

r = await call('victor', `/api/requests/${ajaId}/reject`, { method: 'POST', body: {} });
check('rejection requires a reason', r.status === 400);

r = await call('victor', `/api/requests/${ajaId}/reject`, { method: 'POST', body: { reason: 'Amount does not match the bill' } });
check('rejection recorded', r.status === 200);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'AJA', type_code: 'ELEC', asset_key: '04521187733', period: '2026-09', amount_kobo: 4800000, description: 'Electricity Bill For Ajah Clinic' },
});
check('corrected resubmission after rejection allowed', r.status === 201, JSON.stringify(r.data));

check('rejected request burned no invoice number',
  DB.db.prepare('SELECT COUNT(*) c FROM invoices').get().c === 5,
  `invoices=${DB.db.prepare('SELECT COUNT(*) c FROM invoices').get().c}`);

results.push('\nWithdrawn and rejected free the period');

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'AKO', type_code: 'ELEC', asset_key: '04500000001',
          period: '2026-09', amount_kobo: 3000000, description: 'Electricity Bill' },
});
check('a fresh site/period is created cleanly', r.status === 201, JSON.stringify(r.data));
const withdrawMe = r.data?.request?.id;

r = await call('rel', `/api/requests/${withdrawMe}/withdraw`, { method: 'POST' });
check('requester withdraws it', r.status === 200, JSON.stringify(r.data));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'AKO', type_code: 'ELEC', asset_key: '04500000001',
          period: '2026-09', amount_kobo: 3000000, description: 'Electricity Bill' },
});
check('the identical request may then be resubmitted', r.status === 201, JSON.stringify(r.data));
check('and a withdrawn row raises no warning',
  (r.data?.request?.ack_flags || []).length === 0, JSON.stringify(r.data?.request?.ack_flags));

results.push('\nAmount variance');

// No history for this site/type yet -- the easiest case to get wrong is
// warning on absence.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-09', amount_kobo: 2000000, description: 'Electricity Bill' },
});
check('no prior approved history means no variance warning', r.status === 201, JSON.stringify(r.data));
check('and no flag is recorded',
  (r.data?.request?.ack_flags || []).length === 0, JSON.stringify(r.data?.request?.ack_flags));
const ogbaFirst = r.data?.request?.id;

r = await call('victor', `/api/requests/${ogbaFirst}/approve`, { method: 'POST' });
check('approving it establishes the baseline', r.status === 201, JSON.stringify(r.data));

// 10x the last approved amount for the same site and type.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-10', amount_kobo: 20000000, description: 'Electricity Bill' },
});
check('an amount far above the last approved one warns',
  r.status === 409 && r.data.error === 'confirm_required', JSON.stringify(r.data));
check('the warning quotes the previous amount and period',
  (r.data?.warnings || []).some((w) => w.key === 'amount_variance' && w.previous?.amount_kobo === 2000000),
  JSON.stringify(r.data?.warnings));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-10', amount_kobo: 20000000, confirm: true, description: 'Electricity Bill' },
});
check('confirming records the variance', r.status === 201
  && (r.data?.request?.ack_flags || []).includes('amount_variance'),
  JSON.stringify(r.data?.request?.ack_flags));

// An ordinary month-to-month swing must stay silent, or people learn to click
// through warnings and the duplicate warning next to it stops working too.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-08', amount_kobo: 3400000, description: 'Electricity Bill' },
});
check('a normal swing does not warn', r.status === 201, JSON.stringify(r.data));

// Both warnings on one submit, both recorded.
r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-10', amount_kobo: 90000000, description: 'Electricity Bill' },
});
check('a submit can raise both warnings at once',
  r.status === 409 && (r.data?.warnings || []).length === 2,
  JSON.stringify((r.data?.warnings || []).map((w) => w.key)));

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RFC', site_code: 'OGB', type_code: 'ELEC', asset_key: '04500000002',
          period: '2026-10', amount_kobo: 90000000, confirm: true, description: 'Electricity Bill' },
});
check('and both land in ack_flags', r.status === 201
  && (r.data?.request?.ack_flags || []).includes('duplicate_period')
  && (r.data?.request?.ack_flags || []).includes('amount_variance'),
  JSON.stringify(r.data?.request?.ack_flags));

results.push('\nSelf-approval');

// Make a vendor admin who is also the creator, to prove the guard.
DB.db.prepare('UPDATE requests SET created_by = (SELECT id FROM users WHERE email=?) WHERE id = ?')
  .run('approver@alpha.example', ajaId);
const selfReq = DB.db.prepare(`SELECT id FROM requests WHERE status='pending' LIMIT 1`).get();
DB.db.prepare('UPDATE requests SET created_by = (SELECT id FROM users WHERE email=?) WHERE id = ?')
  .run('approver@alpha.example', selfReq.id);
r = await call('victor', `/api/requests/${selfReq.id}/approve`, { method: 'POST' });
check('cannot approve a request you raised', r.status === 403, JSON.stringify(r.data));

results.push('\nPDF');

r = await call('rel', `/api/invoices/${encodeURIComponent(routerInvoice)}/pdf`);
check('The client cannot pull the letterhead PDF', r.status === 403, `status=${r.status}`);

r = await call('victor', `/api/invoices/${encodeURIComponent(routerInvoice)}/pdf`);
check('PDF renders', r.status === 200 && r.data?.length > 20000, `status=${r.status} bytes=${r.data?.length}`);
check('PDF magic bytes', new TextDecoder().decode(r.data.slice(0, 5)) === '%PDF-');
check('Content-Disposition uses the flat filename',
  /RFC-GBG-2026-SEP-001\.pdf/.test(r.headers.get('Content-Disposition') || ''),
  r.headers.get('Content-Disposition'));
writeFileSync(join(ROOT, 'test-output.pdf'), r.data);

r = await call('victor', '/api/invoices/RFC%2FGBG%2F2026%2FSEP%2F099/pdf');
check('unknown invoice 404s', r.status === 404);

r = await call('rival', `/api/invoices/${encodeURIComponent(routerInvoice)}/pdf`);
check('another vendor cannot pull the document, and is not told it exists',
  r.status === 404, `status=${r.status}`);

results.push('\nApprover on the issued invoice');

const issued = DB.db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(routerInvoice);
check('approver name copied onto the invoice row',
  issued.approver_name === 'An Approver', String(issued.approver_name));
check('approver job title copied',
  issued.approver_title === 'Business Development Manager', String(issued.approver_title));
check('approver phone copied',
  issued.approver_phone === '+234 803 555 0142', String(issued.approver_phone));
check('approver email copied',
  issued.approver_email === 'approver@alpha.example', String(issued.approver_email));

// Invariant 3, extended to the signature block: editing the approver's own
// user row must not change a document that has already gone out.
DB.db.prepare("UPDATE users SET full_name='Renamed Person', job_title='Something Else' WHERE email='approver@alpha.example'").run();
const afterRename = DB.db.prepare('SELECT * FROM invoices WHERE invoice_no = ?').get(routerInvoice);
check('renaming the approver does not alter an issued invoice',
  afterRename.approver_name === 'An Approver'
  && afterRename.approver_title === 'Business Development Manager',
  `${afterRename.approver_name} / ${afterRename.approver_title}`);

// Any vendor user may regenerate, and gets the original document back.
const byVictor = await call('victor', `/api/invoices/${encodeURIComponent(routerInvoice)}/pdf`);
const byAdmin = await call('admin', `/api/invoices/${encodeURIComponent(routerInvoice)}/pdf`);
check('a different vendor user may regenerate', byAdmin.status === 200, `status=${byAdmin.status}`);
check('the regenerated PDF is byte-identical regardless of who asks',
  byVictor.data.length === byAdmin.data.length
  && Buffer.compare(Buffer.from(byVictor.data), Buffer.from(byAdmin.data)) === 0,
  `${byVictor.data.length} vs ${byAdmin.data.length}`);

results.push('\nShared queue, scoped history');

const rivalList = await call('rival', '/api/requests');
check('a rival vendor sees the same pending queue',
  (rivalList.data?.requests || []).some((x) => x.status === 'pending'),
  JSON.stringify((rivalList.data?.requests || []).map((x) => x.status)));
check('a rival vendor sees none of another vendor\'s decided work',
  (rivalList.data?.requests || []).every((x) => x.status === 'pending'),
  JSON.stringify((rivalList.data?.requests || []).map((x) => `${x.request_ref}:${x.status}`)));

const bsList = await call('victor', '/api/requests');
check('the issuing vendor still sees its own approved work',
  (bsList.data?.requests || []).some((x) => x.status === 'approved'));

// Whoever approves first takes it out of everyone else's queue.
const openReq = DB.db.prepare("SELECT id FROM requests WHERE status='pending' LIMIT 1").get();
r = await call('rival', `/api/requests/${openReq.id}/approve`, { method: 'POST' });
check('a rival vendor can approve from the shared queue', r.status === 201, JSON.stringify(r.data));

const takenInvoice = DB.db.prepare('SELECT * FROM invoices WHERE request_id = ?').get(openReq.id);
check('the invoice is issued to the approving vendor', takenInvoice.vendor_id === 2, String(takenInvoice.vendor_id));
check("the approving vendor's own fee is billed, not the platform default",
  takenInvoice.fee_kobo === 25000, String(takenInvoice.fee_kobo));
check('the total is recomputed from that fee',
  takenInvoice.total_kobo === takenInvoice.amount_kobo + 25000,
  `${takenInvoice.total_kobo} vs ${takenInvoice.amount_kobo}+25000`);
check("the approving vendor's bank account is on the invoice",
  takenInvoice.bank_account_number === '1234567890', takenInvoice.bank_account_number);
check('the invoice number still comes from the client reference',
  /^(RFC|REX|RHMO)\//.test(takenInvoice.invoice_no), takenInvoice.invoice_no);

r = await call('victor', `/api/requests/${openReq.id}/approve`, { method: 'POST' });
check('a second vendor cannot approve what is already taken', r.status === 409, JSON.stringify(r.data));

const afterTake = await call('victor', '/api/requests');
check('the taken request has left the other vendor\'s queue',
  !(afterTake.data?.requests || []).some((x) => x.id === openReq.id),
  JSON.stringify((afterTake.data?.requests || []).map((x) => x.id)));

// A suspended vendor keeps its documents but loses the queue.
DB.db.prepare("UPDATE vendors SET status='disabled' WHERE id=2").run();
const stillPending = DB.db.prepare("SELECT id FROM requests WHERE status='pending' LIMIT 1").get();
if (stillPending) {
  r = await call('rival', `/api/requests/${stillPending.id}/approve`, { method: 'POST' });
  check('a suspended vendor cannot approve', r.status === 403, JSON.stringify(r.data));
}
r = await call('rival', `/api/invoices/${encodeURIComponent(takenInvoice.invoice_no)}/pdf`);
check('a suspended vendor can still regenerate what it issued', r.status === 200, `status=${r.status}`);
DB.db.prepare("UPDATE vendors SET status='active' WHERE id=2").run();

results.push('\nLocations are admin-editable');

r = await call('reladmin', '/api/reference');
check('client admin reads the full reference set', r.status === 200, JSON.stringify(r.data));
check('it includes the BU to site map', !!r.data?.buSites?.RFC?.length, JSON.stringify(r.data?.buSites));
r = await call('victor', '/api/reference');
check('a vendor cannot read the admin reference set', r.status === 403, `status=${r.status}`);

r = await call('reladmin', '/api/sites', { method: 'POST', body: { code: 'ikj', name: 'Ikeja Clinic', bu_code: 'RFC' } });
check('a new site is created, code upper-cased', r.status === 201 && r.data?.site?.code === 'IKJ',
  JSON.stringify(r.data));
check('and attached to the BU in the same call',
  DB.db.prepare("SELECT COUNT(*) c FROM bu_sites WHERE bu_code='RFC' AND site_code='IKJ'").get().c === 1);

r = await call('rel', '/api/requests', { method: 'POST', body: {
  bu_code: 'RFC', site_code: 'IKJ', type_code: 'ELEC', asset_key: '04577000111',
  period: '2026-09', amount_kobo: 1500000, description: 'Electricity Bill' } });
check('a request can be raised against the new site immediately', r.status === 201, JSON.stringify(r.data));
check('and it carries the new site label', r.data?.request?.site_label === 'Ikeja Clinic',
  String(r.data?.request?.site_label));

r = await call('reladmin', '/api/sites/IKJ', { method: 'PUT', body: { name: 'Ikeja Clinic GRA' } });
check('a site can be renamed', r.status === 200 && r.data?.site?.name === 'Ikeja Clinic GRA',
  JSON.stringify(r.data));

r = await call('reladmin', '/api/sites/IKJ', { method: 'PUT', body: { name: 'Ikeja Clinic GRA', status: 'disabled' } });
check('a site can be deactivated', r.status === 200, JSON.stringify(r.data));
r = await call('rel', '/api/requests', { method: 'POST', body: {
  bu_code: 'RFC', site_code: 'IKJ', type_code: 'ELEC', asset_key: '04577000111',
  period: '2026-10', amount_kobo: 1500000, description: 'Electricity Bill' } });
check('a deactivated site is refused on new requests', r.status === 422, JSON.stringify(r.data));

r = await call('rel', '/api/requests');
check('but requests already raised against it still resolve its name',
  (r.data?.requests || []).some((x) => x.site_code === 'IKJ' && x.site_label === 'Ikeja Clinic GRA'),
  JSON.stringify((r.data?.requests || []).filter((x) => x.site_code === 'IKJ').map((x) => x.site_label)));

r = await call('reladmin', '/api/sites', { method: 'POST', body: { code: 'LEK', name: 'Duplicate' } });
check('site codes are unique', r.status === 409, JSON.stringify(r.data));
r = await call('reladmin', '/api/sites', { method: 'POST', body: { code: 'X', name: 'Too short' } });
check('a one-character code is refused', r.status === 400, JSON.stringify(r.data));
// 'HQ' is two characters, so the guard must not assume three.
r = await call('reladmin', '/api/sites', { method: 'POST', body: { code: 'PH', name: 'Two Char Site' } });
check('a two-character code is accepted', r.status === 201, JSON.stringify(r.data));

r = await call('victor', '/api/sites', { method: 'POST', body: { code: 'ZZZ', name: 'Sneaky' } });
check('a vendor cannot add locations', r.status === 403, `status=${r.status}`);

r = await call('reladmin', '/api/business-units', { method: 'POST', body: {
  code: 'RLB', name: 'client Labs', numbering_site: 'NOPE' } });
check('a BU cannot point its numbering at a site that does not exist',
  r.status === 400, JSON.stringify(r.data));
r = await call('reladmin', '/api/business-units', { method: 'POST', body: {
  code: 'RLB', name: 'client Labs', numbering_site: 'LEK' } });
check('a business unit can be added', r.status === 201, JSON.stringify(r.data));

r = await call('reladmin', '/api/bu-sites', { method: 'POST', body: { bu_code: 'RLB', site_code: 'SUR' } });
check('a site can be attached to another unit', r.status === 200, JSON.stringify(r.data));
check('the attachment is many-to-many',
  DB.db.prepare("SELECT COUNT(*) c FROM bu_sites WHERE site_code='SUR'").get().c === 2);
r = await call('reladmin', '/api/bu-sites', { method: 'POST', body: { bu_code: 'RLB', site_code: 'SUR', attached: false } });
check('and can be detached again', r.status === 200
  && DB.db.prepare("SELECT COUNT(*) c FROM bu_sites WHERE bu_code='RLB' AND site_code='SUR'").get().c === 0);

r = await call('reladmin', '/api/platform-config', { method: 'PUT', body: { default_fee_kobo: 20000 } });
check('the client admin sets the indicative fee', r.status === 200, JSON.stringify(r.data));
r = await call('victor', '/api/platform-config', { method: 'PUT', body: { default_fee_kobo: 1 } });
check('a vendor cannot set the indicative fee', r.status === 403, `status=${r.status}`);
// Put it back: later assertions depend on the seeded indicative fee.
await call('reladmin', '/api/platform-config', { method: 'PUT', body: { default_fee_kobo: 10000 } });

results.push('\nTax is per-vendor configuration');

r = await call('reladmin', '/api/vendors', { method: 'POST', body: {
  code: 'taxed', name: 'Taxed Vendor Ltd', bank_account_name: 'Taxed Vendor Ltd',
  bank_account_number: '5555555555', bank_name: 'Access', fee_kobo: 10000,
  signatory_name: 'Tax Person', signatory_title: 'MD',
  tin: '12345678-0001', vat_rate_pct: 7.5, wht_rate_pct: 5,
} });
check('a vendor can be onboarded with tax details', r.status === 201, JSON.stringify(r.data));
const taxedId = r.data?.vendor?.id;
const taxedCfg = DB.db.prepare('SELECT * FROM vendor_config WHERE vendor_id = ?').get(taxedId);
check('percentages are stored as basis points, never floats',
  taxedCfg.vat_rate_bps === 750 && taxedCfg.wht_rate_bps === 500,
  `${taxedCfg.vat_rate_bps}/${taxedCfg.wht_rate_bps}`);
check('the TIN is stored', taxedCfg.tin === '12345678-0001', String(taxedCfg.tin));
check('vat_basis defaults to the whole invoice', taxedCfg.vat_basis === 'invoice', taxedCfg.vat_basis);

r = await call('reladmin', '/api/vendors', { method: 'POST', body: {
  code: 'badtax', name: 'Bad Tax', bank_account_name: 'X', bank_account_number: '1',
  bank_name: 'B', fee_kobo: 0, signatory_name: 'S', signatory_title: 'T',
  vat_rate_pct: 250 } });
check('an impossible VAT rate is refused', r.status === 400, JSON.stringify(r.data));

const pwTax = await hashPassword('taxed-long-password-1');
DB.db.prepare(
  `INSERT INTO users (email, full_name, org, vendor_id, role, job_title, phone,
                      pw_hash, pw_salt, pw_iterations)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
).run('t@taxed.com', 'Tax Person', 'vendor', taxedId, 'approver', 'MD', '+234 1',
      pwTax.hash, pwTax.salt, pwTax.iterations);
await sessionFor('taxed', 't@taxed.com');

r = await call('rel', '/api/requests', { method: 'POST', body: {
  bu_code: 'RFC', site_code: 'EJG', type_code: 'ELEC', asset_key: '04588000111',
  period: '2026-09', amount_kobo: 1000000, description: 'Electricity Bill' } });
const taxedReq = r.data?.request?.id;
check('a request is raised for the taxed vendor to take', r.status === 201, JSON.stringify(r.data));

r = await call('taxed', `/api/requests/${taxedReq}/approve`, { method: 'POST' });
check('the taxed vendor approves it', r.status === 201, JSON.stringify(r.data));

// base = 1,000,000 + 10,000 = 1,010,000 kobo. VAT 7.5% = 75,750. WHT 5% = 50,500.
const taxedInv = DB.db.prepare('SELECT * FROM invoices WHERE request_id = ?').get(taxedReq);
check('VAT is computed on the whole invoice', taxedInv.vat_kobo === 75750, String(taxedInv.vat_kobo));
check('VAT is ADDED to the total',
  taxedInv.total_kobo === 1000000 + 10000 + 75750, String(taxedInv.total_kobo));
check('WHT is computed but NOT added to the total', taxedInv.wht_kobo === 50500, String(taxedInv.wht_kobo));
check('the TIN is copied onto the invoice at issue',
  taxedInv.tin === '12345678-0001', String(taxedInv.tin));

// Invariant 3 again: editing config must not touch an issued document.
DB.db.prepare('UPDATE vendor_config SET vat_rate_bps = 2000, tin = ? WHERE vendor_id = ?')
  .run('CHANGED', taxedId);
const stillTaxed = DB.db.prepare('SELECT * FROM invoices WHERE request_id = ?').get(taxedReq);
check('editing tax config does not alter an issued invoice',
  stillTaxed.vat_kobo === 75750 && stillTaxed.tin === '12345678-0001',
  `${stillTaxed.vat_kobo} / ${stillTaxed.tin}`);

r = await call('taxed', `/api/invoices/${encodeURIComponent(taxedInv.invoice_no)}/pdf`);
check('the taxed invoice still renders', r.status === 200 && r.data?.length > 20000,
  `status=${r.status}`);

// A vendor with no tax configured produces the document it always did.
const plainInv = DB.db.prepare('SELECT * FROM invoices WHERE vendor_id = 1 LIMIT 1').get();
check('a vendor with no tax set has zero VAT and WHT',
  plainInv.vat_kobo === 0 && plainInv.wht_kobo === 0,
  `${plainInv.vat_kobo}/${plainInv.wht_kobo}`);
check('and its total is still amount + fee',
  plainInv.total_kobo === plainInv.amount_kobo + plainInv.fee_kobo, String(plainInv.total_kobo));

results.push('\nVendor onboarding');

r = await call('reladmin', '/api/vendors');
check('client admin may list vendors', r.status === 200, JSON.stringify(r.data));
r = await call('victor', '/api/vendors');
check('a vendor may not list vendors', r.status === 403, `status=${r.status}`);

r = await call('reladmin', '/api/vendors', { method: 'POST', body: {
  code: 'Acme', name: 'Acme', bank_account_name: 'A', bank_account_number: '1',
  bank_name: 'B', fee_kobo: 5000, signatory_name: 'S', signatory_title: 'T',
} });
check('a vendor code must be a lowercase slug', r.status === 400, JSON.stringify(r.data));

r = await call('reladmin', '/api/vendors', { method: 'POST', body: {
  code: 'acme', name: 'Acme Power', bank_account_name: 'Acme Power Ltd',
  bank_account_number: '9999999999', bank_name: 'Zenith', fee_kobo: 5000,
  signatory_name: 'Ada Nwosu', signatory_title: 'MD',
  contact_lines: ['Address: 1 Acme Way, Lagos'],
} });
check('client admin onboards a vendor', r.status === 201, JSON.stringify(r.data));
const acmeId = r.data?.vendor?.id;
check('onboarding creates the vendor config in the same step',
  DB.db.prepare('SELECT * FROM vendor_config WHERE vendor_id = ?').get(acmeId)?.fee_kobo === 5000);

r = await call('reladmin', '/api/vendors', { method: 'POST', body: {
  code: 'acme', name: 'Acme Again', bank_account_name: 'A', bank_account_number: '1',
  bank_name: 'B', fee_kobo: 1, signatory_name: 'S', signatory_title: 'T',
} });
check('vendor codes are unique', r.status === 409, JSON.stringify(r.data));

r = await call('reladmin', `/api/vendors/${acmeId}/status`, { method: 'POST', body: { status: 'disabled' } });
check('client admin suspends a vendor', r.status === 200, JSON.stringify(r.data));

results.push('\nVendor config is per vendor');

r = await call('admin', '/api/config', { method: 'PUT', body: {
  bank_account_name: 'Alpha Renamed', bank_account_number: '0123456789',
  bank_name: 'Example Bank', fee_kobo: 12000,
  signatory_name: 'An Approver', signatory_title: 'BDM',
} });
check('a vendor admin edits their own config', r.status === 200, JSON.stringify(r.data));
check('the edit did not touch the other vendor',
  DB.db.prepare('SELECT fee_kobo FROM vendor_config WHERE vendor_id = 2').get().fee_kobo === 25000);
r = await call('reladmin', '/api/config', { method: 'PUT', body: {
  bank_account_name: 'X', bank_account_number: '1', bank_name: 'B', fee_kobo: 1,
  signatory_name: 'S', signatory_title: 'T',
} });
check('the client admin cannot edit a vendor\'s bank details', r.status === 403, `status=${r.status}`);

results.push('\nVendor roster');

r = await call('reladmin', '/api/users');
check('client admin may list the vendor roster', r.status === 200, JSON.stringify(r.data));
check('the roster lists vendor accounts only',
  (r.data?.users || []).every((u) => u.org === 'vendor'), JSON.stringify(r.data));
r = await call('reladmin', '/api/users?vendor_id=2');
check('the roster can be filtered to one vendor',
  (r.data?.users || []).length > 0 && (r.data?.users || []).every((u) => u.vendor_id === 2),
  JSON.stringify(r.data));

r = await call('victor', '/api/users');
check('a vendor approver may not list the roster', r.status === 403, `status=${r.status}`);
r = await call('admin', '/api/users');
check('even a vendor admin may not list the roster', r.status === 403, `status=${r.status}`);
r = await call('rel', '/api/users');
check('a client requester may not list the roster', r.status === 403, `status=${r.status}`);

r = await call('reladmin', '/api/users', { method: 'POST', body: {
  email: 'new.person@alpha.example', full_name: 'New Person', role: 'approver', vendor_id: 1,
  job_title: 'Field Engineer', phone: '+234 807 000 1111', password: 'a-long-enough-password',
} });
check('client admin creates a vendor user', r.status === 201, JSON.stringify(r.data));
check('the created user carries job title and phone',
  r.data?.user?.job_title === 'Field Engineer' && r.data?.user?.phone === '+234 807 000 1111',
  JSON.stringify(r.data?.user));
const newUserId = r.data?.user?.id;

r = await call('reladmin', '/api/users', { method: 'POST', body: {
  email: 'nophone@alpha.example', full_name: 'No Phone', role: 'approver', vendor_id: 1,
  job_title: 'Engineer', password: 'a-long-enough-password',
} });
check('phone is required, because it is printed', r.status === 400, JSON.stringify(r.data));

r = await call('reladmin', '/api/users', { method: 'POST', body: {
  email: 'someone@client.example', full_name: 'Someone', role: 'requester',
  org: 'client', vendor_id: 1, job_title: 'X', phone: 'Y', password: 'a-long-enough-password',
} });
check('client accounts cannot be created here', r.status === 400, JSON.stringify(r.data));

r = await call('victor', '/api/users', { method: 'POST', body: {
  email: 'sneaky@alpha.example', full_name: 'Sneaky', role: 'admin', vendor_id: 1,
  job_title: 'X', phone: 'Y', password: 'a-long-enough-password',
} });
check('a vendor cannot add itself an account', r.status === 403, `status=${r.status}`);

r = await call('reladmin', '/api/users', { method: 'POST', body: {
  email: 'ghost@nowhere.com', full_name: 'Ghost', role: 'approver', vendor_id: 999,
  job_title: 'X', phone: 'Y', password: 'a-long-enough-password',
} });
check('a user cannot be attached to a vendor that does not exist',
  r.status === 400, JSON.stringify(r.data));

r = await call('reladmin', `/api/users/${newUserId}/status`, { method: 'POST', body: { status: 'disabled' } });
check('client admin removes a vendor user', r.status === 200, JSON.stringify(r.data));
check('removal is a disable, not a delete',
  DB.db.prepare('SELECT status FROM users WHERE id = ?').get(newUserId)?.status === 'disabled');

r = await call('anon', '/api/auth/login',
  { method: 'POST', body: { email: 'new.person@alpha.example', password: 'a-long-enough-password' } });
check('a removed user cannot sign in', r.status === 401, `status=${r.status}`);

const relAdminRow = DB.db.prepare("SELECT id FROM users WHERE email='roster.admin@client.example'").get();
r = await call('reladmin', `/api/users/${relAdminRow.id}/status`, { method: 'POST', body: { status: 'disabled' } });
check('client rows are not managed through the roster route', r.status === 403, `status=${r.status}`);

results.push('\nclient admin is view-only on requests');

r = await call('reladmin', '/api/requests');
check('client admin may read the request table', r.status === 200, `status=${r.status}`);
r = await call('reladmin', '/api/requests', { method: 'POST', body: {
  bu_code: 'RFC', site_code: 'AJA', type_code: 'ELEC', asset_key: '04521187733', period: '2026-11',
  amount_kobo: 100000, description: 'Should not be allowed',
} });
check('client admin cannot raise a request', r.status === 403, JSON.stringify(r.data));

results.push('\nSSO provisioning');

let sso = await resolveOrProvisionSsoUser(env, { email: 'Brand.New@client.example', name: 'Brand New' });
check('a first SSO sign-in provisions an account', !!sso.user, JSON.stringify(sso));
check('provisioned as client/requester',
  sso.user?.org === 'client' && sso.user?.role === 'requester', `${sso.user?.org}/${sso.user?.role}`);
check('the provisioned email is lowercased',
  sso.user?.email === 'brand.new@client.example', sso.user?.email);
check('the provisioned account has no password', sso.user?.pw_hash === null);
check('provenance is recorded', sso.user?.created_by === 'sso:auto', sso.user?.created_by);

const provisionedId = sso.user.id;
sso = await resolveOrProvisionSsoUser(env, { email: 'brand.new@client.example' });
check('a second sign-in reuses the same row', sso.user?.id === provisionedId);

// The token never decides org or role.
sso = await resolveOrProvisionSsoUser(env,
  { email: 'claims@client.example', org: 'vendor', role: 'approver' });
check('org and role in the token are ignored',
  sso.user?.org === 'client' && sso.user?.role === 'requester', `${sso.user?.org}/${sso.user?.role}`);

DB.db.prepare('UPDATE users SET status=? WHERE id=?').run('disabled', provisionedId);
sso = await resolveOrProvisionSsoUser(env, { email: 'brand.new@client.example' });
check('a disabled account is refused, not re-provisioned',
  !sso.user && sso.denied === 'disabled', JSON.stringify(sso));

sso = await resolveOrProvisionSsoUser({ ...env, SSO_ALLOWED_DOMAINS: 'client.example' },
  { email: 'outsider@example.com' });
check('the domain allowlist blocks an outside address', sso.denied === 'domain', JSON.stringify(sso));

sso = await resolveOrProvisionSsoUser(env, {});
check('a token with no email is refused', sso.denied === 'no_email', JSON.stringify(sso));

results.push('\nConfig');

r = await call('victor', '/api/config', {
  method: 'PUT',
  body: { bank_account_name: 'X', bank_account_number: '1', bank_name: 'Y', fee_kobo: 10000, signatory_name: 'A', signatory_title: 'B' },
});
check('approver cannot change bank details', r.status === 403, `got ${r.status}`);

const beforeInvoice = DB.db.prepare('SELECT bank_account_number FROM invoices WHERE invoice_no = ?').get(routerInvoice);

r = await call('admin', '/api/config', {
  method: 'PUT',
  body: {
    bank_account_name: 'Alpha Services Ltd', bank_account_number: '9999999999',
    bank_name: 'Example Bank', fee_kobo: 15000,
    signatory_name: 'An Approver', signatory_title: 'Business Development Manager',
  },
});
check('admin can change bank details', r.status === 200, JSON.stringify(r.data));
check('bank change is flagged', r.data?.bankChanged === true);

const afterInvoice = DB.db.prepare('SELECT bank_account_number FROM invoices WHERE invoice_no = ?').get(routerInvoice);
check('already-issued invoice keeps its original account number',
  afterInvoice.bank_account_number === beforeInvoice.bank_account_number &&
  afterInvoice.bank_account_number === '0123456789',
  `${beforeInvoice.bank_account_number} -> ${afterInvoice.bank_account_number}`);

r = await call('rel', '/api/requests', {
  method: 'POST',
  body: { bu_code: 'RHMO', type_code: 'STAFFDC', period: '2026-09', amount_kobo: 5000000, description: 'Staff Data & Credit For Health Services' },
});
// A vendor's fee no longer reaches the request: the requester does not know
// yet who will take it, so they are shown the indicative platform figure.
check('a new request carries the indicative platform fee, not a vendor\'s',
  r.data?.request?.fee_kobo === 10000, String(r.data?.request?.fee_kobo));
check('and its total uses that indicative fee',
  r.data?.request?.total_kobo === 5010000, String(r.data?.request?.total_kobo));

const rhmoId = r.data?.request?.id;
r = await call('victor', `/api/requests/${rhmoId}/approve`, { method: 'POST' });

const rhmoInvoice = DB.db.prepare('SELECT * FROM invoices WHERE request_id = ?').get(rhmoId);
check('the approving vendor\'s fee is what actually gets billed',
  rhmoInvoice.fee_kobo === 15000, String(rhmoInvoice.fee_kobo));
check('and the invoice total is recomputed from it',
  rhmoInvoice.total_kobo === 5015000, String(rhmoInvoice.total_kobo));
check('RHMO numbers under HQ', r.data?.invoice_no === 'RHMO/HQ/2026/SEP/001', r.data?.invoice_no);

results.push('\nVisibility');

r = await call('rel', '/api/requests');
const relRows = r.data.requests;
check('the client sees its own requests', relRows.length > 0);
r = await call('victor', '/api/requests');
const vendorRows = r.data.requests;
check('a vendor sees rows', vendorRows.length > 0);
check('a vendor sees only the open queue plus its own decided work',
  vendorRows.every((x) => x.status === 'pending'
    || x.decided_vendor_name === 'Alpha Services Ltd'),
  JSON.stringify(vendorRows.map((x) => `${x.request_ref}:${x.status}:${x.decided_vendor_name}`)));

results.push('\nSSO landing route');

// Access itself is not exercised — no offline signing key — but the failure
// modes matter, because they are what an operator sees during setup.
const raw = (path, headers = {}) =>
  worker.fetch(new Request(`https://app.test${path}`, { headers }), env, {});

r = await raw('/api/auth/sso');
let body = await r.json();
check('no Access header -> 503 access_not_configured',
  r.status === 503 && body.error === 'access_not_configured', `${r.status} ${body.error}`);
check('the error names the path that needs an Access policy',
  /api\/auth\/sso/.test(body.message), body.message);

r = await raw('/api/auth/sso', { 'Cf-Access-Jwt-Assertion': 'garbage' });
body = await r.json();
check('Access header present but ACCESS_* unset -> 503',
  r.status === 503 && body.error === 'access_not_configured', `${r.status} ${body.error}`);

env.ACCESS_TEAM_DOMAIN = 'team.cloudflareaccess.com';
env.ACCESS_AUD = 'aud-tag';

r = await raw('/api/auth/sso', { 'Cf-Access-Jwt-Assertion': 'not.a.jwt' });
body = await r.json();
check('malformed Access JWT -> 401', r.status === 401 && body.error === 'bad_access_token',
  `${r.status} ${body.error}`);

r = await raw('/api/auth/sso', { 'Cf-Access-Jwt-Assertion': 'a.b' });
check('two-segment token rejected', r.status === 401, String(r.status));

delete env.ACCESS_TEAM_DOMAIN;
delete env.ACCESS_AUD;

// ── Report ────────────────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
