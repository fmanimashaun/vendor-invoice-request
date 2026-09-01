# DESIGN.md — Vendor Invoice Request Platform

Architecture and data model. Companion to `CLAUDE.md` (how the code works) and
`worker/README.md` (gate and deploy).

Status: **draft**. Auth model resolved (§14). Remaining open items in §16 are non-blocking.

---

## 1. What this is

> **Superseded in part.** This section described the original two-party
> arrangement. The system is now multi-vendor: the client requests invoices,
> every onboarded vendor sees one shared queue, and whoever approves first
> issues on their own letterhead. Tax is per-vendor configuration rather than
> out of scope. `CLAUDE.md` is authoritative where the two disagree; the
> reasoning below is kept because it explains the first vendor's arrangement,
> which
> is still one of the vendors.

A workflow that produces payment documents on the issuing vendor's
letterhead — originally two-party, with a single vendor:

> The client raises a request → the vendor reviews a pending queue → the vendor approves →
> an invoice number is reserved and a PDF is generated for download.

It replaces a manual Google Docs process. The three sample documents that defined the
template were all exported from **one** Google Doc — all three still carry the document
title `Lekki Clinic lab- Data(July)` in their PDF metadata, and each is 14–26 MB. The existing
process has no numbering discipline, no duplicate detection, and no audit trail.

### Why it exists — and what "approval" means here

Two stated purposes, and they set the whole risk model:

1. **Reduce the vendor's manual document-creation workload.** They currently duplicate a
   Google Doc and hand-edit four fields per request.
2. **Attribute each document to a named person at the vendor**, producing a paper trail for
   **ApprovalMax** submission.

So the approve action is **attribution, not authorisation**. It does not gate money — funds
land in a wallet account under sole control of the client owner. That correctly lowers the
bar on authentication (§14): the approver login is not a payments endpoint.

It does **not** lower the bar on record integrity, and this is the part worth being precise
about. The risk is not theft from the wallet. It is that **these PDFs are evidence entering
ApprovalMax, and ApprovalMax feeds the accounting record.**

| Not the risk | The actual risk |
|---|---|
| Wallet drained | Wrong amount, period or site enters ApprovalMax and is approved |
| Funds to a stranger | Same September bill submitted twice, recognised twice |
| Credential theft moving funds | A named approver attached to a figure they never checked |

Controlling the destination account protects the cash and does nothing for the accounting
record. the client's own AP process can still approve a duplicate or a misstated expense.

Because attribution *is* the product, three things that would otherwise read as security
overhead are load-bearing features: immutable approval events (§4), `render_hash` plus
pinned bank/signatory (§11), and supersede-instead-of-edit (§8). "X approved this exact
document" is worthless if the record is mutable or the document regenerates differently
later. And the duplicate-period constraints (§7) become *more* valuable, not less —
ApprovalMax's OCR cannot tell that two differently-numbered invoices are the same
underlying electricity bill.

### Letterhead invariant — do not break this

The client must not be able to produce a document bearing a vendor's letterhead. the client
raises a *request*; the vendor reviews it, approves, and the approved document is
that vendor's own issuance. That is what makes the paper trail legitimate rather than
the client self-issuing on someone else's branding.

Three rules enforce it. All three are load-bearing:

1. **No `invoices` row exists before approval** (D7). The render route resolves an issued
   invoice, so there is no path to the artwork without a completed vendor approval.
2. **`/api/invoices/:no/pdf` requires an existing `invoices` row.** It never accepts a
   request id or ad-hoc field values.
3. **Requester-side preview must be unbranded.** A requester previewing their own draft
   sees a plain data summary — figures, site, period, line items — with **no header
   artwork, no footer artwork, no logo**. This is the rule most likely to be broken later
   by someone adding a helpful "preview as it will look" feature. Adding letterhead to the
   requester preview silently destroys the invariant.

The artwork assets should be served only by the render path, never referenced from the
requester-facing bundle.

### Governance note

The app is operated on the client infrastructure (Cloudflare account, repo, Worker) while
issuing documents on vendor letterhead. The audit trail records that a named vendor
user approved each document, and rule 1–3 above prevent the client from issuing unilaterally
— but the machinery is the client-hosted.

Alternative if cleaner separation is ever wanted: the vendor owns the Cloudflare account
and the client is purely a tenant. Better attribution, worse operational control, and more
setup friction. the client-hosted with documented consent is the pragmatic choice.

### Delivery

v1: the approver downloads the PDF and posts it to a shared WhatsApp group manually. No
delivery automation.

v1.1 (recommended, additive): [Verified] ApprovalMax Capture issues each organisation a
unique email address; a PDF forwarded there is OCR'd into a draft request. Supported for
Xero, QuickBooks Online and NetSuite. The Worker can email the approved PDF straight to
that address, leaving WhatsApp as human notification rather than the delivery mechanism —
which removes the "did anyone actually forward it" gap. **Send one PDF per email with no
other attachments**: ApprovalMax creates a separate draft for every valid attachment,
invoice or not.

### What the document is (and is not)

The collection account named *the vendor's own name* is a **virtual NUBAN collection/wallet
account** that the vendor issued to the client on the vendor's platform. The client transfers
in; the vendor's platform credits the client wallet; the wallet then funds electricity,
router and airtime/data purchases.

Consequences that shape this build:

- The beneficiary name matching the payer is **correct**. Do not "fix" it.
- For that vendor specifically this is a pass-through: they fund a utility wallet at cost
  and charge a fee, so only the fee is their supply. That is now expressed as
  `vendor_config.vat_basis = 'fee'` rather than as a claim that tax is out of scope.
  Vendors billing for their own services use the default, `'invoice'`.
- The ₦100 is the collection/transfer fee, not a service charge.
- Duplicate funding is the real financial risk: funding the wallet twice for the same
  September electricity bill is money out the door. **The duplicate-period constraints
  (§7) are the highest-value control in the system**, ahead of the numbering scheme.

---

## 2. Parties and roles

| Role | Org | Can |
|---|---|---|
| `requester` | the client | Create, edit and withdraw own draft/pending requests. Read own. |
| `approver` | Vendor | Read the shared queue. Approve or reject. Cannot create requests. |
| `admin` | Vendor | Everything an approver can, plus their own vendor config (§12). |

Enforced **server-side in the Worker on every mutation**. A role check in React is not a
control — it is bypassed from dev tools in seconds. See §14 for what is still open.

---

## 3. Decisions log

Agreed during design. Recorded so they are not silently relitigated.

| # | Decision | Rationale |
|---|---|---|
| D1 | Cloudflare Worker + **D1**, not client-only | A shared queue, role separation and a non-colliding sequence are all impossible client-side |
| D2 | **D1** for queue/register; KV only for artwork | KV is eventually consistent with last-write-wins — wrong for rows two people act on |
| D3 | No Durable Object | A `UNIQUE` constraint gives the same guarantee for less machinery |
| D4 | PDFs are **not stored** | Regenerate from metadata; §11 makes that truthful |
| D5 | Render **in the Worker**, not the browser | The client must not choose the numbers printed on the letterhead |
| D6 | `pdf-lib` | Real embedded text over the artwork. `html2canvas` rasterises and recreates the current 14–26 MB defect |
| D7 | Invoice number assigned **at approval** | Assigning at request means rejected requests burn numbers, leaving gaps in an issued sequence |
| D8 | Ref format `BU/SITE/YYYY/MON/NNN` | Human-legible; year before month so a plain text sort in Excel comes out chronological |
| D9 | Ref is a **derived display string** | `period` is its own column; sorting and range queries use the column, never the ref text |
| D10 | 3-digit sequence, scoped per (BU, site, period) | Widening later is a visible format change |
| D11 | BU/site codes identify the **billed party** | Matches the samples: "To: Surulere Clinic" |
| D12 | Variable-length site codes (`HQ` is 2 chars) | No `length()` check; ref parsing splits on `/` |
| D13 | `site_code` NULL for BU-scope types | Prevents all of RFC's staff data cost landing on Lekki in reports |
| D14 | Template supports 1..n line rows | Costs nothing now; retrofitting after live invoices exist is painful |
| D15 | Bank profile versioned and pinned per invoice | Otherwise changing the account rewrites every regenerated historical PDF |
| D16 | Money stored as integer **kobo** | Never floats |
| D17 | Approval is **attribution**, not authorisation | Funds land in a wallet under sole owner control. Lowers the auth bar (§14), not the record-integrity bar (§1) |
| D18 | Vendors on email + password; no mandatory TOTP; no two-person approval | Follows from D17 |
| D19 | Manual WhatsApp delivery in v1 | ApprovalMax Capture email is additive, v1.1 |

---

## 4. Data model (D1 / SQLite)

```sql
-- ─── Reference data ────────────────────────────────────────────────────────

CREATE TABLE business_units (
  code            TEXT PRIMARY KEY,           -- RFC | REX | RHMO
  name            TEXT NOT NULL,
  numbering_site  TEXT NOT NULL REFERENCES sites(code),
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE sites (
  code    TEXT PRIMARY KEY,                   -- LEK | IKD | ... | HQ   (2–3 chars)
  name    TEXT NOT NULL,
  active  INTEGER NOT NULL DEFAULT 1
);

-- Which sites each BU may raise against. Data, not code:
-- Retail expanding beyond Lekki is one INSERT.
CREATE TABLE business_unit_sites (
  bu_code     TEXT NOT NULL REFERENCES business_units(code),
  site_code   TEXT NOT NULL REFERENCES sites(code),
  is_default  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bu_code, site_code)
);

CREATE TABLE request_types (
  code         TEXT PRIMARY KEY,              -- ELEC | ROUTER | STAFFDC
  label        TEXT NOT NULL,                 -- printed in the subject line
  scope        TEXT NOT NULL CHECK (scope IN ('SITE','BU')),
  fields_json  TEXT,                          -- extra form/template fields
  active       INTEGER NOT NULL DEFAULT 1
);

-- ─── Config (§12) ──────────────────────────────────────────────────────────

CREATE TABLE bank_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name    TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  fee_kobo        INTEGER NOT NULL DEFAULT 10000,   -- ₦100
  is_current      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_bank_current ON bank_profiles(is_current) WHERE is_current = 1;

CREATE TABLE signatories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,                  -- Victor Uche
  title       TEXT NOT NULL,                  -- Business Development Manager
  is_current  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_sig_current ON signatories(is_current) WHERE is_current = 1;

-- ─── Requests ──────────────────────────────────────────────────────────────

CREATE TABLE requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_ref   TEXT NOT NULL UNIQUE,         -- REQ-000412 (gaps allowed)
  status        TEXT NOT NULL CHECK (status IN
                  ('draft','pending','approved','rejected','withdrawn','superseded')),

  bu_code       TEXT NOT NULL REFERENCES business_units(code),
  site_code     TEXT     REFERENCES sites(code),  -- NULL when type.scope='BU'  (D13)
  type_code     TEXT NOT NULL REFERENCES request_types(code),
  period        TEXT NOT NULL,                -- '2026-09' sortable, see D9
  asset_key     TEXT,                         -- MSISDN for ROUTER, NULL otherwise (§7)

  addressee     TEXT NOT NULL,                -- 'Gbagada Clinic Branch'
  addressee_loc TEXT NOT NULL,                -- 'Lagos.'
  subject       TEXT NOT NULL,                -- 'MTN Router'
  narrative     TEXT NOT NULL,                -- '...billing details for MTN Router For August...'
  description   TEXT NOT NULL,                -- 'MTN Router For Gbagada Clinic' (the single line item)

  fee_kobo      INTEGER NOT NULL,             -- snapshot from config at submit
  amount_kobo   INTEGER NOT NULL CHECK (amount_kobo > 0),
  total_kobo    INTEGER NOT NULL,             -- amount + fee  (resolves the ₦100 ambiguity)

  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  submitted_at  TEXT,
  decided_by    TEXT,
  decided_at    TEXT,
  reject_reason TEXT,

  revision      INTEGER NOT NULL DEFAULT 1,
  supersedes_id INTEGER REFERENCES requests(id),

  CHECK (total_kobo = amount_kobo + fee_kobo)
);

-- No request_lines table. All three types are single-line (electricity, router,
-- staff data & credit), so description and amount live on the request row.
-- Add a child table only if a genuinely multi-line type appears.

-- ─── Issued invoices ───────────────────────────────────────────────────────

CREATE TABLE invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no      TEXT NOT NULL UNIQUE,       -- RFC/LEK/2026/SEP/001
  request_id      INTEGER NOT NULL UNIQUE REFERENCES requests(id),

  bu_code         TEXT NOT NULL,
  site_code       TEXT NOT NULL,              -- resolved: COALESCE(req.site_code, bu.numbering_site)
  period          TEXT NOT NULL,
  seq             INTEGER NOT NULL,

  bank_profile_id INTEGER NOT NULL REFERENCES bank_profiles(id),   -- pinned (D15)
  signatory_id    INTEGER NOT NULL REFERENCES signatories(id),     -- pinned
  template_version TEXT NOT NULL,             -- 'v1'
  render_hash     TEXT,                       -- sha256 of first render (§11)

  issued_at       TEXT NOT NULL,
  issued_by       TEXT NOT NULL,
  legacy_ref      TEXT,                       -- old 'RELHMO-2026-08-12 4' refs

  UNIQUE (bu_code, site_code, period, seq)
);

-- ─── Immutable audit ───────────────────────────────────────────────────────

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,                  -- 'request' | 'invoice' | 'config'
  entity_id   INTEGER NOT NULL,
  action      TEXT NOT NULL,                  -- 'submitted' | 'approved' | 'bank_changed' | ...
  actor       TEXT NOT NULL,
  at          TEXT NOT NULL,
  payload     TEXT                            -- JSON snapshot of what the actor saw
);
CREATE INDEX ix_events_entity ON events(entity, entity_id, at);
```

**No UPDATE on `events` or `invoices`, ever.** Corrections go through supersede (§8). With
PDFs unstored, the approval event *is* the audit artifact — it must record the exact field
values the approver saw.

---

## 5. Seed data

```sql
INSERT INTO sites (code, name) VALUES
  ('LEK','Lekki Clinic'),        ('IKD','Ikorodu Clinic'),   ('ABJ','Abuja Clinic'),
  ('OGB','Ogba Clinic'),         ('AJA','Ajah Clinic'),      ('EJG','Ejigbo Clinic'),
  ('SUR','Surulere Clinic'),     ('AKO','Akowonjo Clinic'),  ('PHC','Port Harcourt Clinic'),
  ('GBG','Gbagada Clinic'),      ('HQ','the Head Office');

INSERT INTO business_units (code, name, numbering_site) VALUES
  ('RFC','a business unit','LEK'),
  ('REX','Retail','LEK'),
  ('RHMO','the Health Services','HQ');

-- RFC: all 10 clinic sites.  REX and RHMO: one site each, rendered locked.
INSERT INTO business_unit_sites (bu_code, site_code, is_default) VALUES
  ('RFC','LEK',1),('RFC','IKD',0),('RFC','ABJ',0),('RFC','OGB',0),('RFC','AJA',0),
  ('RFC','EJG',0),('RFC','SUR',0),('RFC','AKO',0),('RFC','PHC',0),('RFC','GBG',0),
  ('REX','LEK',1),
  ('RHMO','HQ',1);

INSERT INTO request_types (code, label, scope, fields_json) VALUES
  ('ELEC',   'Electricity Bill',      'SITE', NULL),
  ('ROUTER', 'Router Internet',       'SITE',
     '[{"key":"msisdn","label":"Router N0.","type":"tel","required":true,"column":true}]'),
  ('STAFFDC','Staff Data & Credit',   'BU',   NULL);

INSERT INTO bank_profiles (account_name, account_number, bank_name, fee_kobo, is_current, created_at, created_by)
  VALUES ('Alpha Services Ltd','0123456789','Example Bank',10000,1,datetime('now'),'seed');

INSERT INTO signatories (full_name, title, is_current, created_at, created_by)
  VALUES ('Victor Uche','Business Development Manager',1,datetime('now'),'seed');
```

The form cascade falls out of `business_unit_sites` with no per-BU special-casing: read the
permitted sites for the chosen BU; if exactly one, render it locked; if the type is
BU-scope, hide the picker entirely.

---

## 6. Numbering

```
BU / SITE / YYYY / MON / NNN

RFC/LEK/2026/SEP/001     electricity or router at Lekki Clinic
RFC/LEK/2026/SEP/002     staff data & credit for RFC  (LEK = numbering site, D13)
REX/LEK/2026/SEP/001
RHMO/HQ/2026/SEP/001
```

- `MON` is the uppercase 3-letter English month, derived from `period`, never stored.
- Counter scope is **(bu_code, resolved site_code, period)**. All three request types share
  one counter within that scope, so they interleave. `type_code` is a column, so filtering
  and reporting do not need it in the ref.
- Download filename replaces `/` with `-`: `RFC-LEK-2026-SEP-001.pdf`. Unhandled slashes
  become path separators and break the download.

**Reservation — at approval only (D7), inside the transaction:**

```sql
BEGIN IMMEDIATE;
  SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM invoices
   WHERE bu_code = ?1 AND site_code = ?2 AND period = ?3;

  INSERT INTO invoices (invoice_no, request_id, bu_code, site_code, period, seq,
                        bank_profile_id, signatory_id, template_version,
                        issued_at, issued_by)
  VALUES (?4, ?5, ?1, ?2, ?3, ?6, ?7, ?8, 'v1', datetime('now'), ?9);

  UPDATE requests SET status='approved', decided_by=?9, decided_at=datetime('now')
   WHERE id = ?5 AND status = 'pending';
COMMIT;
```

`invoices.invoice_no UNIQUE` and `UNIQUE (bu_code, site_code, period, seq)` are the real
guarantee. On constraint violation: retry once, then **fail loudly and refuse to issue**.
Never fall back to a guessed number.

`request_ref` is a separate, gap-tolerant sequence (`REQ-000412`) assigned at creation.

---

## 7. Duplicate prevention

The highest-value control. Partial unique indexes, so rejected and withdrawn requests do
not block a legitimate resubmission.

```sql
-- Electricity: one per site per month
CREATE UNIQUE INDEX ux_dup_elec ON requests(site_code, period)
  WHERE type_code = 'ELEC' AND status NOT IN ('rejected','withdrawn','superseded');

-- Staff data & credit: one per BU per month
CREATE UNIQUE INDEX ux_dup_staffdc ON requests(bu_code, period)
  WHERE type_code = 'STAFFDC' AND status NOT IN ('rejected','withdrawn','superseded');

-- Router: identity includes the router number (multiple routers per site are possible).
-- Uses the denormalised requests.asset_key — see note below.
CREATE UNIQUE INDEX ux_dup_router ON requests(site_code, period, asset_key)
  WHERE type_code = 'ROUTER' AND status NOT IN ('rejected','withdrawn','superseded');
```

`asset_key` holds the router MSISDN directly on the request row. It must be declared in the
`requests` table itself, never added by a later `ALTER` — [Verified] an index created before
its column exists fails at migration time and the duplicate guard then silently never
applies.

The API must return a **usable** error, not a constraint dump:

```json
{ "error": "duplicate_period",
  "message": "September 2026 electricity for Lekki Clinic already exists.",
  "existing": { "request_ref": "REQ-000388", "invoice_no": "RFC/LEK/2026/SEP/003",
                "status": "approved" } }
```

### Validation on submit and on approve

| Check | Rule |
|---|---|
| Addressee ↔ site | Reject if any line description names a site other than `site_code`. Catches the live defect where a request addressed to *Gbagada Clinic Branch* carried the line "MTN Router For RFC **Surulere**". |
| Scope ↔ site | `scope='SITE'` requires `site_code`; `scope='BU'` requires it NULL |
| Site permitted | `(bu_code, site_code)` must exist in `business_unit_sites` |
| Period | Not more than one month in the future |
| Totals | `amount_kobo = SUM(lines)` and `total_kobo = amount_kobo + fee_kobo` |
| Required type fields | Every `fields_json` entry with `required:true` present |

---

## 8. State machine

```
                ┌──────────┐
   create ─────►│  draft   │
                └────┬─────┘
                     │ submit (requester)
                     ▼
                ┌──────────┐  withdraw (requester)   ┌───────────┐
                │ pending  │────────────────────────►│ withdrawn │
                └────┬─────┘                         └───────────┘
           approve   │   reject (approver, reason required)
        (approver)   │
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌────────────┐        ┌───────────┐
   │  approved  │        │ rejected  │──► requester may create a new request
   │ + invoice  │        └───────────┘
   └─────┬──────┘
         │ correction needed
         ▼
   ┌────────────┐
   │ superseded │  original stays visible and marked superseded;
   └────────────┘  a new request r2 is created with supersedes_id set
```

Terminal: `withdrawn`, `rejected`, `superseded`. `approved` is terminal except via supersede.

**Correction never mutates an approved request.** Editing in place would destroy the record
of what the erroneous document said — and the client may already have transferred against it.
Supersede creates `revision = n+1` with a fresh invoice number; the original keeps its
number and is flagged. This is what makes "edit the metadata and regenerate" safe.

---

## 9. Worker API

All routes require a verified session. `role` is read from the token claim server-side —
never from the request body.

| Method | Route | Role | Notes |
|---|---|---|---|
| `GET` | `/api/bootstrap` | any | BUs, sites, BU-site map, types, current bank profile + signatory |
| `GET` | `/api/requests?status=&bu=&period=` | any | Requesters see own; approvers see all |
| `POST` | `/api/requests` | requester | Create draft |
| `PATCH` | `/api/requests/:id` | requester | Draft/pending only, own only |
| `POST` | `/api/requests/:id/submit` | requester | Runs §7 validation |
| `POST` | `/api/requests/:id/withdraw` | requester | Own, pending only |
| `POST` | `/api/requests/:id/approve` | **approver** | Reserves number, issues invoice. **See §14** |
| `POST` | `/api/requests/:id/reject` | **approver** | Reason required |
| `POST` | `/api/requests/:id/supersede` | approver | Creates revision |
| `GET` | `/api/invoices/:invoice_no/pdf` | any (party-scoped) | Renders on demand (D4, D5) |
| `GET` | `/api/config` | admin | Bank profile + signatory + history |
| `PUT` | `/api/config/bank` | **admin** | New version, never an update (§12) |
| `PUT` | `/api/config/signatory` | **admin** | New version |
| `GET` | `/api/events?entity=&id=` | any (party-scoped) | Audit trail |

Every mutation writes an `events` row in the same transaction.

---

## 10. PDF template contract

### Artwork (extracted, in `assets/`)

| Asset | Native | Placement (A4 pt) | Notes |
|---|---|---|---|
| `header.png` | 1121×610 | x 0, y 0, w 595, h 243 | Background geometry, alpha preserved |
| `footer.png` | 1122×648 | x 113, y 583, w 482, h 259 | Alpha preserved |
| `logo.png` | 768×255 | centred, top band | |
| `tagline_services.png` | 1834×49 | centred | *Bills Payment \| E-Payments \| …* |
| `tagline_slogan.png` | 843×60 | centred | *Providing Innovative solutions* |

Total artwork ~230 KB. Cache in KV; the rendered PDF should land well under 300 KB against
the current 14–26 MB.

### Defects the template fixes

1. **Page size.** Source PDFs are 1109×1583 pt — roughly 1.87× A4 and not a standard size.
   Render at true **A4, 595×842 pt**.
2. **Truncated address.** [Verified] `contact_address.png` is placed from x=858 to x=1232 on
   a 1109-wide page — it runs **123 pt off the edge**. Rebuild the whole contact block as
   **live text**, right-aligned inside the margin, with the icons as small images:
   ```
   Address: 1 Example Street, Lagos
   Phone:   +234 800 000 0000
   Email:   info@example.com
   Website: www.example.com
   ```
   Wrap the address onto two lines. Verify the phone number against the source — it is
   partly obscured in the sample render.
3. **Stale metadata.** Set `Title` to the invoice number, `Author` to the issuing vendor,
   `Producer`/`Creator` to this app. Never inherit a source document title.
4. **Ambiguous total.** Print all three figures explicitly:
   ```
   Bill amount:            ₦75,000.00
   Processing fee:            ₦100.00
   Total to transfer:      ₦75,100.00
   ```
   The current wording — "credit ₦75,000 … [₦100 for processing fee]" — leaves AP to guess,
   and they will transfer ₦75,000.
5. **Typo.** "We apprecate" → "We appreciate".
6. **Missing dates.** Add issue date and, if the vendor wants one, a due date.

### Body layout (between the bands)

```
  ┌ To: {addressee}                        Ref: {invoice_no} ┐
  │ {addressee_loc}                     Date: {issued_at}    │
  │                                                          │
  │            Request for Payment – {subject}               │
  │                                                          │
  │ Dear the client,                                           │
  │ We appreciate your continued partnership and support.     │
  │ {narrative}                                              │
  │                                                          │
  │ Description of Item │ {extra cols} │           Amount    │  ← row loop, 1..n (D14)
  │ …                   │              │                     │
  │                     │              │ Bill amount   ₦…    │
  │                     │              │ Processing fee ₦…   │
  │                     │              │ TOTAL         ₦…    │
  │                                                          │
  │ Payment Instructions:                                    │
  │ Kindly credit ₦{total} to the account below:              │
  │ Account Name:   {bank.account_name}                       │  ← from pinned profile
  │ Account Number: {bank.account_number}                     │
  │ Bank Name:      {bank.bank_name}                          │
  │                                                          │
  │ Thank you once again for your business.                   │
  │ Warm Regards,                                            │
  │ {signatory.full_name}                                     │  ← from pinned signatory
  └ {signatory.title}                                        ┘
```

Extra columns come from `request_types.fields_json` where `column:true` — so `ROUTER`
renders `Description | Router N0. | Amount` and the others render two columns, matching the
samples. Fonts: Arimo/Arial for body, Times for the italic taglines if they are ever
converted from images.

---

## 11. Provenance and regeneration

PDFs are not stored (D4). That is only defensible with these three fields:

- `template_version` — pinned per invoice. Keep every version in the bundle so a `v1`
  invoice always renders as `v1`, even after `v2` ships.
- `bank_profile_id` / `signatory_id` — pinned (D15). Without these, changing the bank
  account or the signatory silently rewrites every historical document.
- `render_hash` — `sha256` of the first render, stored on issue. Regeneration either
  reproduces the hash (proof the document is byte-identical to what was issued) or does not
  (and you know something drifted).

For the hash to be stable, the render must be **deterministic**: no embedded creation
timestamp, no random object IDs, fixed font subset ordering. `pdf-lib` needs
`useObjectStreams: false` and an explicit fixed `CreationDate`/`ModDate` set from
`issued_at` rather than now.

---

## 12. Config page

The vendor's own admin only. Bank details are the highest-risk mutable field in the system —
changing them redirects every subsequent transfer, which is the standard invoice-fraud
vector.

- **Append-only versioning.** `PUT /api/config/bank` inserts a new `bank_profiles` row and
  flips `is_current`. It never UPDATEs an existing row.
- **Pinned per invoice** (§11), so history is immutable.
- **Change log** — every change writes an `events` row with `action='bank_changed'` and
  before/after in `payload`.
- **Notify both teams** on any bank-detail change. Cheap, and the single best defence
  against a quiet redirection.
- Also editable here: signatory name/title, request types, site activation.

Consider requiring a second admin to confirm a bank change before it takes effect. Given
what the field controls, I would.

---

## 13. Frontend

React 18 + Vite on the `cfm-prep-app` shell — theme `T`, inline styles, `Card`, `Modal`,
`UserPrompt`. Cloudflare Pages, git-connected, auto-deploy on push to `main`.

| View | Role | Notes |
|---|---|---|
| `RequestForm` | requester | BU → site cascade from `business_unit_sites`; type-driven extra fields; live total incl. fee; duplicate check on blur. **Unbranded preview only** — see the letterhead invariant in §1 |
| `MyRequests` | requester | Own requests, status chips, withdraw |
| `Queue` | approver | **The main screen.** Pending table, filters, row detail, Approve / Reject |
| `Issued` | any | Issued invoices, party-scoped, download PDF |
| `Config` | admin | §12, with change history |
| `Audit` | any | `events` timeline for one entity |

Drop from the CFM shell: `AccessGate` (replaced, §14), `sync.js` and gist sync (the server
is the source of truth now), `storage.js` progress model. Keep localStorage only for
in-progress form drafts.

---

## 14. Authentication and authorisation

The CFM gate model — a gist-scoped GitHub PAT as a shared secret in a KV allowlist — does
not transfer and is retired. Two organisations, role separation, and a decision that moves
money.

### Identity: three login paths, one code path

All three go through **Cloudflare Access** in front of the Worker. Access handles the
protocol dance and hands the Worker a signed JWT in `Cf-Access-Jwt-Assertion`, which the
Worker verifies against the Access public keys (`/cdn-cgi/access/certs`). One verification
routine, three providers.

| Party | Method | Access IdP type |
|---|---|---|
| the client (Entra population) | SSO | **Microsoft Entra ID** — native integration |
| the client (Zoho population) | SSO | **Generic SAML 2.0** → Zoho Directory custom app |
| Vendors | see below | Not via Access — email + password against the app |

Access supports multiple IdPs simultaneously and lets the user pick at the login screen.
IdP-enforced MFA is available on Entra ID, Generic OIDC and Generic SAML 2.0. Zoho
Directory acts as a SAML IdP for custom applications, so it goes in as Generic SAML 2.0 —
Zoho's own docs route custom apps through SAML rather than OIDC.

**Lock the Entra IdP to the client's tenant.** Configure the specific directory/tenant ID,
*and* add an Access policy restricting to the `yourcompany.com` email domain. The
standard failure here is accepting the multi-tenant `common` endpoint without validating
`tid`, which lets any Microsoft account on the internet sign in.

### Vendors: email + password

Accepted. Because approval is attribution rather than authorisation (§1), this login is not
a payments endpoint, and the earlier objection — that a static password protected the
control which moves money — does not apply. One-time PIN remains marginally simpler (no
password storage, single Access JWT path) and is worth taking if Access is being configured
anyway, but it is a preference, not a requirement.

Standard hygiene, still required:

- PBKDF2-HMAC-SHA256 with a per-user salt at current OWASP iteration guidance — check the
  number at build time, it rises. SubtleCrypto has PBKDF2 natively; bcrypt/scrypt/argon2
  need WASM in Workers.
- No self-signup. Admin invite only.
- Rate limiting and lockout on the login route.
- HttpOnly + Secure + SameSite=Strict session cookie, short TTL, server-side revocation.

TOTP is optional here, not mandatory. Revisit if the approval ever becomes an authorisation
gate — for example if a vendor starts drawing on the wallet directly.

### Authorisation: Access proves *who*, D1 decides *what*

```sql
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,      -- normalised lowercase; the join key
  full_name   TEXT NOT NULL,
  org         TEXT NOT NULL CHECK (org IN ('client','vendor')),
  vendor_id   INTEGER REFERENCES vendors(id),
  role        TEXT NOT NULL CHECK (role IN ('requester','approver','admin')),
  status      TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

-- One human, possibly several providers (Entra and Zoho for the same person).
CREATE TABLE user_identities (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,             -- 'entra' | 'zoho' | 'otp'
  subject     TEXT NOT NULL,             -- IdP 'sub'
  first_seen  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
```

**Never map roles from IdP group claims.** Vendor staff are not in the client's
directory, so group mapping cannot express the model — and worse, it would let the client's IT
grant themselves approver rights, destroying the separation the approval step exists to
provide. Roles live in D1, seeded by an admin.

**Provisioning is closed.** A successful SSO login is not an account. An authenticated user
with no `users` row gets a "no access" screen, never an auto-provisioned requester —
otherwise every employee of the client can raise funding requests. Requesters should be finance
and operations staff only.

**Identity linking.** `users.email` is the join key, so the same person arriving via Entra
and via Zoho resolves to one record *provided both providers assert the same address*. If
the Zoho population uses a different domain, that assumption breaks and one human becomes
two users — which also breaks the self-approval check below. See O7.

### Self-approval

Enforced in the Worker on `/approve`, unconditionally:

```
reject if request.created_by_user_id == session.user_id
reject if session.role not in ('approver','admin')
reject if session.org != 'vendor'
```

The `org` check is the one that matters most: it makes "the client approves its own funding
request" structurally impossible rather than merely against policy.

Two-person approval is **not** required — approval is attribution, and a second approver
adds friction without protecting anything the wallet gating does not already cover.

The `org` check earns its keep for a different reason than fraud prevention: it guarantees
the paper trail says *the vendor approved this*, which is the only thing that makes the
document useful as ApprovalMax evidence. A client-approved vendor invoice would be
worthless for that purpose.

---

## 15. Out of scope (v1)

| Not building | Why / when |
|---|---|
| ~~VAT, WHT, TIN~~ | **Built.** Per-vendor configuration on `vendor_config` (`tin`, `vat_rate_bps`, `wht_rate_bps`, `vat_basis`), copied onto the invoice at issue. |
| ~~Multiple vendors / letterheads~~ | **Built.** `vendors` is a table; artwork is namespaced by vendor code in KV. Per-vendor *geometry* is still outstanding. |
| FIRS e-invoicing | No integration. Rates and TIN are captured and printed only. |
| Payment reconciliation | No bank feed. Status stops at *issued*. |
| Email delivery | Download only. |
| Storing rendered PDFs | D4. |
| Multi-page overflow | Single page. Add a page break in the row loop when line count grows. |

---

## 16. Open items

| # | Item | Blocks |
|---|---|---|
| ~~O1~~ | ~~Requester and approver separate?~~ | Resolved structurally — the `org` check in §14 makes cross-org approval mandatory |
| O2 | Does "Staff Data & Credit" print one row or two? | Template built for 1..n either way (D14) — cosmetic only |
| O3 | Verify each vendor's contact block against their source artwork | §10 |
| O4 | Legacy cutover date, and whether old refs get backfilled | `invoices.legacy_ref` |
| O5 | Due date / payment terms wanted on the document? | §10 |
| O6 | Second-admin confirmation on bank changes? | §12 |
| O7 | Do Entra and Zoho populations share one email domain? | Identity linking, §14. If not, one human can become two users and the self-approval check fails |
| ~~O8~~ | ~~Two-person approval?~~ | Closed — not needed. Approval is attribution, not authorisation |
| O9 | Confirm Zoho Directory tier supports custom SAML apps | §14. Zoho routes custom apps through SAML, not OIDC |
| O10 | ApprovalMax Capture email address, and Xero vs QuickBooks Online | v1.1 delivery (§1) |
| O11 | Does ApprovalMax dedupe on invoice number? | If yes, the ref format already satisfies it. If no, §7 is the only duplicate defence |
