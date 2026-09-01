-- Payment Request Platform — initial schema.
-- Business units, sites and request types are code constants in
-- shared/reference.js, not tables. Vendors ARE a table: they are onboarded by
-- the client admin at runtime, which is the whole point of the design.
--
--   npx wrangler d1 execute vendor-invoice-request --local  --file=migrations/0001_init.sql
--   npx wrangler d1 execute vendor-invoice-request --remote --file=migrations/0001_init.sql

-- ── vendors ────────────────────────────────────────────────────────────
-- Every vendor is a row here; none is a special case. Every vendor sees the same
-- pending queue; whoever approves first issues the invoice on their own
-- letterhead, and the request leaves the queue scoped to them.
--
-- `code` is the KV asset prefix for that vendor's letterhead artwork
-- (<code>/header.png and so on), so it must be a lowercase slug.
CREATE TABLE IF NOT EXISTS vendors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE CHECK (code = lower(code)),
  name          TEXT NOT NULL,
  -- JSON array of the letterhead contact lines, drawn as live text.
  contact_lines TEXT NOT NULL DEFAULT '[]',
  -- A digitised replica of this vendor's invoice layout: page size, artwork
  -- placement, colours, type sizes, column positions and vertical rhythm.
  -- NULL means the built-in default layout. See shared/template.js.
  template_json TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT NOT NULL DEFAULT 'seed'
);

-- ── business units, sites, and which sites each BU may bill against ────
--
-- These were code constants. They are tables now because the client admin
-- edits them at runtime. Request types are deliberately NOT here: they carry
-- behaviour (scope, extraField, and a dedupe key that maps to a partial unique
-- index below), so adding one from a UI would produce a request type with no
-- duplicate guard, silently. They stay in shared/reference.js.
--
-- Codes are the join key and are written onto requests and invoices as text,
-- so they are immutable once used. Names are editable; renaming a site must
-- never rewrite an issued invoice, which is why invoices copy what they need.
CREATE TABLE IF NOT EXISTS business_units (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- Ref segment for BU-scope types, whose requests store site_code NULL.
  numbering_site TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT NOT NULL DEFAULT 'seed'
);

-- Site codes are NOT fixed width: 'HQ' is two characters and every other code
-- is three. Do not add a length() check here or a [A-Z]{3} assumption anywhere
-- that parses an invoice ref -- split on '/'.
CREATE TABLE IF NOT EXISTS sites (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT 'seed'
);

-- Many-to-many on purpose: LEK is billed by both RFC and REX, so a site cannot
-- carry a single bu_code column.
CREATE TABLE IF NOT EXISTS bu_sites (
  bu_code   TEXT NOT NULL REFERENCES business_units(code),
  site_code TEXT NOT NULL REFERENCES sites(code),
  PRIMARY KEY (bu_code, site_code)
);

-- ── users ──────────────────────────────────────────────────────────────
-- client users arrive via Cloudflare Access (Entra or Zoho) and are matched
-- on email; their rows are created by SSO on first sign-in. Vendor users sign
-- in with email + password and are created by the client admin, who owns
-- every vendor roster.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,          -- lowercase; the join key for SSO
  full_name     TEXT NOT NULL,
  org           TEXT NOT NULL CHECK (org IN ('client','vendor')),
  vendor_id     INTEGER REFERENCES vendors(id),
  -- A SET of roles, comma separated, because one person legitimately holds
  -- more than one: an admin who also raises requests is ordinary, and forcing
  -- a choice would mean giving them two accounts.
  --
  --   client staff  member | admin
  --   vendor staff  approver | admin
  --
  -- Stored as text rather than a join table: there are four values, they never
  -- change, and every check is "does this set contain X".
  roles         TEXT NOT NULL DEFAULT 'member',
  -- Which of those roles the app opens in. A convenience only: the server
  -- authorises on `roles`, never on whichever context the client is showing,
  -- so switching context can neither grant nor remove anything.
  default_role  TEXT,
  -- Vendor accounts are created by hand and carry the details that appear in
  -- the signature block of any invoice this person approves. client rows are
  -- provisioned by SSO on first sign-in and leave these NULL.
  job_title     TEXT,
  phone         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  -- Vendor users only. PBKDF2-HMAC-SHA256, salt and iterations stored alongside.
  pw_hash       TEXT,
  pw_salt       TEXT,
  pw_iterations INTEGER,
  -- Set when an admin resets someone's password. The admin necessarily knows
  -- the temporary one they just typed, so it is not a secret until the owner
  -- has replaced it; the app makes them do that before anything else.
  --
  -- There is no email delivery yet, so resets are handed over in person or on
  -- a call. When email is wired up this flag is what a reset link would clear.
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT NOT NULL DEFAULT 'seed',

  -- A vendor user without a vendor, or a client user with one, would make
  -- every scoping query downstream quietly wrong.
  CHECK ((org = 'vendor') = (vendor_id IS NOT NULL))
);

-- One human may arrive via more than one provider (Entra and Zoho). They
-- resolve to a single users row because email is the join key.
CREATE TABLE IF NOT EXISTS user_identities (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,                  -- 'azureAD' | 'oidc' | 'access'
  subject     TEXT NOT NULL,                  -- IdP 'sub'
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject)
);

-- ── config ─────────────────────────────────────────────────────────────
-- Platform row (id = 1), set by the client admin. Holds only the INDICATIVE
-- processing fee shown on the request form. The fee that is actually billed
-- comes from the approving vendor and is copied onto the invoice at issue —
-- see vendor_config.fee_kobo.
CREATE TABLE IF NOT EXISTS config (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  -- The organisation running this deployment. Set on first run and shown in
  -- the UI; nothing about a particular company is compiled into the code.
  org_name          TEXT NOT NULL DEFAULT '',
  default_fee_kobo  INTEGER NOT NULL DEFAULT 10000,   -- minor units

  -- Single sign-on for CLIENT staff, set up in the app rather than at deploy
  -- time so a deployment can start with passwords and move to SSO later.
  -- Vendors always use email and password; they are not in the client's
  -- directory and never will be.
  sso_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (sso_enabled IN (0,1)),
  access_team_domain  TEXT,
  access_aud          TEXT,
  sso_allowed_domains TEXT,
  -- Set the first time a client user actually completes an SSO sign-in.
  --
  -- Password sign-in for client staff is disabled only once this is set, not
  -- when the switch is flipped. Turning SSO on with a wrong AUD tag would
  -- otherwise lock out the only admin who could turn it back off, and there is
  -- no way back into the app from there. Configure, prove it works, and the
  -- cutover happens on its own.
  sso_verified_at     TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by        TEXT NOT NULL DEFAULT 'seed'
);

-- ── vendor_config ──────────────────────────────────────────────────────
-- One row per vendor, editable by that vendor's own admin. Values are COPIED
-- onto each invoice at issue, so changing them here never rewrites history.
CREATE TABLE IF NOT EXISTS vendor_config (
  vendor_id           INTEGER PRIMARY KEY REFERENCES vendors(id),
  bank_account_name   TEXT NOT NULL,
  bank_account_number TEXT NOT NULL,
  bank_name           TEXT NOT NULL,
  fee_kobo            INTEGER NOT NULL DEFAULT 10000,
  signatory_name      TEXT NOT NULL,
  signatory_title     TEXT NOT NULL,

  -- Tax, entered at onboarding and applied only if set. Rates are BASIS
  -- POINTS (750 = 7.5%) so nothing here is ever a float.
  tin                 TEXT,
  vat_rate_bps        INTEGER NOT NULL DEFAULT 0,
  wht_rate_bps        INTEGER NOT NULL DEFAULT 0,
  -- What the rates apply to. 'invoice' — the whole invoice is this vendor's
  -- own supply, the normal case. 'fee' — the vendor passes a third-party bill
  -- through at cost and only their fee is a taxable supply, which is how the
  -- a pass-through utility-wallet arrangement works. Getting this wrong changes
  -- what AP transfers, so it is explicit per vendor rather than assumed.
  vat_basis           TEXT NOT NULL DEFAULT 'invoice'
                        CHECK (vat_basis IN ('invoice','fee')),

  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by          TEXT NOT NULL DEFAULT 'seed'
);

-- ── fonts ──────────────────────────────────────────────────────────────
-- Fonts an admin uploaded, on top of the catalogue bundled in shared/fonts.js.
-- The files live in KV under fonts/<key>-Regular.ttf and fonts/<key>-Bold.ttf,
-- shared across vendors; this table is only the metadata that makes them
-- selectable during onboarding.
--
-- Nothing gets in here without passing the glyph check in the upload route: a
-- font missing U+20A6 does not error at render, it silently drops every ₦.
CREATE TABLE IF NOT EXISTS fonts (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'sans' CHECK (kind IN ('sans','serif','mono')),
  metric_of  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL DEFAULT 'seed'
);

-- ── requests ───────────────────────────────────────────────────────────
-- Raised by the client. Single line item, so description/amount live here.
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_ref   TEXT NOT NULL UNIQUE,          -- REQ-000412; gaps are fine
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','withdrawn')),

  bu_code       TEXT NOT NULL,                 -- RFC | REX | RHMO
  site_code     TEXT,                          -- NULL for BU-scope types
  type_code     TEXT NOT NULL,                 -- ELEC | ROUTER | STAFFDC
  period        TEXT NOT NULL,                 -- '2026-09'; sortable
  asset_key     TEXT,                          -- router MSISDN, else NULL

  addressee     TEXT NOT NULL,                 -- 'Gbagada Clinic Branch'
  addressee_loc TEXT NOT NULL DEFAULT 'Lagos.',
  subject       TEXT NOT NULL,                 -- 'MTN Router'
  narrative     TEXT NOT NULL,
  description   TEXT NOT NULL,                 -- the single line item

  -- Indicative at submit time: the requester does not yet know which vendor
  -- will take it, and the fee is the vendor's. invoices.fee_kobo is the
  -- figure that was actually billed.
  fee_kobo      INTEGER NOT NULL,
  amount_kobo   INTEGER NOT NULL CHECK (amount_kobo > 0),
  total_kobo    INTEGER NOT NULL,

  -- Submit-time warnings the requester confirmed past, as a JSON array of
  -- keys ('["duplicate_period","amount_variance"]'). The queue badges each
  -- one. A JSON column rather than a boolean because there are already two
  -- warning types and a third is plausible; adding one must not need a
  -- migration. Written by the server only -- never taken from the payload.
  ack_flags     TEXT NOT NULL DEFAULT '[]',

  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by    INTEGER REFERENCES users(id),
  -- Which vendor took the decision. Set on approve AND on reject, because it
  -- is what scopes a decided request out of every other vendor's view.
  decided_vendor_id INTEGER REFERENCES vendors(id),
  decided_at    TEXT,
  reject_reason TEXT,

  CHECK (total_kobo = amount_kobo + fee_kobo)
);

CREATE INDEX IF NOT EXISTS ix_requests_status ON requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_requests_mine   ON requests(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_requests_vendor ON requests(decided_vendor_id, created_at DESC);

-- Duplicate guards. Partial, so a rejected or withdrawn request never blocks a
-- legitimate resubmission. Scoped to the client side of the request only --
-- which vendor ends up serving it is irrelevant to whether it is a duplicate.
--
-- amount_kobo is part of the key ON PURPOSE. These now block only an EXACT
-- re-submission -- the double-click, the refresh, the network retry, which is
-- never legitimate. Same period at a DIFFERENT amount is a judgement call (a
-- corrected bill, a re-read meter), so it is a soft warning in createRequest
-- that the requester confirms and that is recorded in ack_flags. Volume is not
-- gated: a hard block here would refuse legitimate work, and the end of that
-- road is somebody asking for the constraint to be dropped entirely.
--
-- This must stay a database constraint rather than a check on the approver's
-- screen. See the incentive note in CLAUDE.md: the vendors racing for this
-- queue are paid per transaction, so duplicate policing cannot sit with them.
--
-- COALESCE is defensive, not cosmetic. SQLite treats NULLs as DISTINCT in a
-- unique index, so a NULL in any key column silently disables the guard for
-- that row. Validation should never produce one here, but the failure mode is
-- invisible, so do not remove these.
--
-- The ELEC key deliberately omits asset_key even though ELEC now carries a
-- meter number: a typo in the meter would otherwise slip a duplicate through.
CREATE UNIQUE INDEX IF NOT EXISTS ux_dup_elec
  ON requests(COALESCE(site_code,'-'), period, amount_kobo)
  WHERE type_code = 'ELEC' AND status IN ('pending','approved');

CREATE UNIQUE INDEX IF NOT EXISTS ux_dup_router
  ON requests(COALESCE(site_code,'-'), period, COALESCE(asset_key,'-'), amount_kobo)
  WHERE type_code = 'ROUTER' AND status IN ('pending','approved');

CREATE UNIQUE INDEX IF NOT EXISTS ux_dup_staffdc
  ON requests(bu_code, period, amount_kobo)
  WHERE type_code = 'STAFFDC' AND status IN ('pending','approved');

-- ── invoices ───────────────────────────────────────────────────────────
-- Created only on approval, by a vendor user. No row here means no PDF: that
-- is what stops the client producing a document on someone else's letterhead.
--
-- The invoice NUMBER is deliberately global rather than per-vendor: it is built
-- from the client's own reference (BU / site / period / sequence), so a request
-- carries the same number whichever vendor happens to serve it.
CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no  TEXT NOT NULL UNIQUE,            -- RFC/GBG/2026/SEP/001
  request_id  INTEGER NOT NULL UNIQUE REFERENCES requests(id),
  vendor_id   INTEGER NOT NULL REFERENCES vendors(id),

  bu_code     TEXT NOT NULL,
  site_code   TEXT NOT NULL,                   -- resolved numbering site
  period      TEXT NOT NULL,
  seq         INTEGER NOT NULL,

  -- Copied from vendor_config at issue. Never a foreign key, so editing that
  -- config cannot change a document that has already been issued.
  bank_account_name   TEXT NOT NULL,
  bank_account_number TEXT NOT NULL,
  bank_name           TEXT NOT NULL,
  signatory_name      TEXT NOT NULL,
  signatory_title     TEXT NOT NULL,

  -- The money as billed. The request's own figures were indicative: the fee
  -- belongs to whichever vendor took the request.
  amount_kobo INTEGER NOT NULL,
  fee_kobo    INTEGER NOT NULL,
  -- VAT is ADDED to what the payer transfers. WHT is WITHHELD by the payer and
  -- remitted separately, so it reduces what the vendor receives but not the
  -- invoice total — it prints as its own line and a net-payable figure.
  vat_kobo    INTEGER NOT NULL DEFAULT 0,
  wht_kobo    INTEGER NOT NULL DEFAULT 0,
  tin         TEXT,
  total_kobo  INTEGER NOT NULL,

  -- Copied from the approving user at issue, for the same reason: the document
  -- must keep naming whoever actually approved it even if that person is later
  -- renamed, given a new title, or removed from the roster.
  approver_name       TEXT,
  approver_title      TEXT,
  approver_phone      TEXT,
  approver_email      TEXT,
  -- The client organisation as named when this document went out.
  client_name         TEXT,

  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  issued_by   INTEGER NOT NULL REFERENCES users(id),

  UNIQUE (bu_code, site_code, period, seq),
  CHECK (total_kobo = amount_kobo + fee_kobo + vat_kobo)
);
