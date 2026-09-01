# CLAUDE.md — Vendor Invoice Request Platform

Guidance for working on this repo. Read this first. `DESIGN.md` covers why it is
shaped this way.

## What this is

**Why this exists.** Every payment has to be defensible to a tax authority.
An invoice on the vendor's letterhead, naming a person who stood behind it, is
what backs the deduction; a bank statement shows money leaving, not what it
bought. And the money goes into a **virtual collection account carrying the
client's own name**, so on a statement it reads as a transfer to themselves —
without a vendor invoice against each one, an auditor sees a large flow to an
account bearing the payer's name with no evidence of a supply in return.

That is why an invoice must exist for every payment, without exception. It is
the audit defence, not paperwork.

The difficulty is that the vendor's product is a prepaid wallet, and a wallet
does not emit invoices — so every top-up used to require someone at the vendor
to hand-make a document. That
depends on goodwill: an account manager whose targets your business serves, or
being a large enough customer to be worth the effort. The account manager
resigns, or the volume stops being material, and the favour ends — and then you
cannot pay for a service you are willing to pay for. A manual courtesy is not a
process.

This replaces that step with a button. Client staff raise a request; every
onboarded vendor sees one shared pending queue; whichever approves first takes
it out of everyone else's queue, and approval reserves an invoice number and
renders a PDF **on that vendor's own letterhead, in their own layout** (see
Vendor layout templates), naming the member of their staff who approved it.
Their cost per invoice goes from data entry to one click, which is what turns
issuing it from a favour into the cheapest way for them to get paid.

**Hold this constraint.** Anything that adds work to the vendor side re-creates
the original problem. A change that makes a vendor open a spreadsheet, retype a
figure or chase an attachment is the wrong change, however much it tidies up
elsewhere. Supporting several vendors is the same argument one level up: if a
single vendor's cooperation is load-bearing, you are still depending on
goodwill.

The vendor shares the PDF and it becomes the paper trail for the approvals
system.

**Tax is per-vendor configuration, not a platform assumption.** Earlier
versions of this file argued the document was a wallet funding request rather
than a tax invoice and that VAT/WHT/TIN were therefore out of scope. That was
reasoning about one specific arrangement and it does not generalise: the client
requests invoices from vendors, holds their TINs on file, and different vendors
have different tax positions. `vendor_config` carries `tin`, `vat_rate_bps`,
`wht_rate_bps` and `vat_basis`, all optional, and a vendor with none set
produces exactly the document the system produced before tax existed.

Two things that are still true and still easy to "fix" by mistake:

- One vendor's bank account is named *the vendor's own name* because it is a
  virtual collection account that vendor issued to the client on their platform.
  It is also precisely why the invoice matters: without one, that payment looks
  like the company paying itself.
  Payer and beneficiary names matching is correct there. Do not normalise it.
- That same arrangement is a pass-through: the vendor funds a utility wallet at
  cost and charges a fee, so only the fee is their supply. That is what
  `vat_basis = 'fee'` is for. A vendor billing for their own services uses the
  default, `'invoice'`.

```
React 18 + Vite (Cloudflare Pages)
        │  fetch /api/*
        ▼
Worker (worker/worker.js)
        ├── auth.js          Access JWT (client SSO) | PBKDF2 password (vendors)
        ├── D1               vendors, vendor_config, users, config,
        │                    requests, invoices, user_identities
        ├── KV (ASSETS_KV)   letterhead PNGs + Arimo fonts
        └── renderInvoice.js pdf-lib -> A4 PDF, ~210 KB
```

## Three invariants — do not break these

**1. Only the issuing vendor can render its letterhead.** An `invoices` row is
created only by `/api/requests/:id/approve`, which requires `org = 'vendor'`.
The PDF route requires `org = 'vendor'` **and** that the invoice's `vendor_id`
matches the caller's, and resolves an issued invoice by number and nothing else
— it accepts no request id and no ad-hoc field values. The client sees the invoice
number in its history so it can quote it, but cannot pull the document; another
vendor gets a 404 rather than a 403, so it does not learn the invoice exists.

The requester's on-screen preview is deliberately plain text with no artwork.
**Adding a "preview as it will look" feature with the letterhead silently
destroys this**, which is the whole basis for the document being the vendor's
own issuance rather than the client self-issuing on someone else's branding.

**2. The invoice number is assigned at approval, never at request time.**
Otherwise a rejected request burns a number and leaves a gap in an issued
sequence, which is exactly the thing an auditor asks about.

**3. Bank, signatory, approver details AND the money are copied onto the invoice
row at issue.** They are not foreign keys. Editing `vendor_config`, or renaming
the approver in `users`, must never change a document that has already gone out.
There are tests for both.

The money is copied for a second reason: the fee belongs to the vendor, and
which vendor will take a request is unknown when it is raised. `requests`
carries an **indicative** platform fee; `invoices.fee_kobo` / `total_kobo` are
what was actually billed.

This is also what makes regeneration safe: any user of the ISSUING vendor may
re-download an issued invoice, and gets a byte-identical document naming the
person who actually approved it, not themselves. `approver_name`, `approver_title`,
`approver_phone` and `approver_email` on `invoices` are that copy.

## Numbering

```
BU / SITE / YYYY / MON / NNN        RFC/GBG/2026/SEP/001
```

- Counter scope is **(bu_code, resolved site, period)**. All three request types
  share one counter within that scope and interleave.
- The number is **global, not per-vendor**: it is built from the client's own
  reference, so a request carries the same number whichever vendor serves it.
  Do not add `vendor_id` to the counter scope.
- For BU-scope types (`STAFFDC`) `requests.site_code` is **NULL** and the BU's
  `numberingSite` supplies the ref segment. Storing the fallback site as if it
  were real would put all of RFC's staff-data spend on Lekki in any per-site
  report.
- The ref is a **derived display string**. `period` is its own sortable column;
  never sort or range-query on the ref text.
- Year before month so a plain text sort in Excel comes out chronological.
- `downloadName()` flattens the slashes — they are path separators.
- `request_ref` (`REQ-000412`) is a separate, gap-tolerant sequence.

## Duplicate guards — the highest-value control

Partial unique indexes on `requests`, scoped to `status IN ('pending','approved')`
so a rejected or withdrawn request never blocks a legitimate resubmission.
**`amount_kobo` is part of every key on purpose** — see the next section: these
block only an exact re-submission, and the ambiguous cases warn instead.

| Type | Unique on |
|---|---|
| `ELEC` | `(site_code, period, amount_kobo)` |
| `ROUTER` | `(site_code, period, asset_key, amount_kobo)` — several routers per site is normal |
| `STAFFDC` | `(bu_code, period, amount_kobo)` |

`ELEC` carries a meter number in `asset_key` and it is **deliberately absent
from the key**: a typo in the meter would otherwise let an identical bill
through. A site has one electricity account, unlike its several routers.

`COALESCE(...,'-')` wraps the nullable columns. SQLite treats NULLs as DISTINCT
in a unique index, so one NULL silently disables the guard for that row. The
failure mode is invisible — do not remove them.

`asset_key` (the router MSISDN) **must be declared in the `requests` table
itself**, never added by a later `ALTER`. An index created before its column
exists fails at migration time and the guard then silently never applies.

The API turns the constraint violation into `409 duplicate_period` naming the
existing request. Do not let a raw constraint error reach the UI.

## Submit-time warnings — where judgement sits

Duplicate detection is a **database constraint**, never a checkbox on the
approver's screen. The reason is incentive, and it is the single most important
thing in this file to preserve: vendors are paid per transaction and now race
each other for a shared queue, so approving fast is rewarded and scrutiny costs
them the request. Duplicate policing cannot sit with the party that profits from
volume. Move it to the approver and the control is gone.

Correctness *can* sit with the approver — they hold the real bill and approving
is an attestation — which is why reject-with-comment exists and stays.

| Situation | Behaviour |
|---|---|
| Same identity **and same amount**, still active | **Hard block.** A double-click or retry. Never legitimate. |
| Same identity, **different amount** | **Soft warning.** Requester confirms; the override is recorded. |
| Amount far off the last approved comparable | **Soft warning**, same pattern. |
| Existing request withdrawn or rejected | Nothing. The period is free. |

`ack_flags` on `requests` is a JSON array of the warnings a requester confirmed
past, **computed server-side** — a client cannot post its own. The queue badges
each one. This is attribution, not a decision prompt: duplicates never reach the
queue at all.

`VARIANCE_FACTOR` is deliberately loose (3×). Nigerian utility bills are
volatile, and a threshold that fires on ordinary variation trains people to
click through warnings — which would also destroy the duplicate warning sitting
next to it.

## Money

Integer **kobo** everywhere. Never floats — tax rates are stored as **basis
points** (750 = 7.5%) for exactly this reason.

- `requests`: `total_kobo = amount_kobo + fee_kobo`, and the fee there is
  *indicative* — which vendor will take it is not known yet.
- `invoices`: `total_kobo = amount_kobo + fee_kobo + vat_kobo`. Both are CHECK
  constraints.

**VAT is added; WHT is not.** VAT increases what the payer transfers. WHT is
withheld by the payer and remitted separately, so it never changes the invoice
total — it prints as its own deduction line with a net-payable figure below it.
Folding WHT into the total would understate the invoice.

The document prints bill amount, processing fee, VAT, total, and where
applicable the WHT deduction and net, as separate lines — the old template said
"credit ₦75,000 … [₦100 for processing fee]" and AP transferred ₦75,000 every
time. Every figure gets its own line for that reason.

## Fonts — a real trap

**A font without the Naira glyph U+20A6 does not error.** pdf-lib embeds it
happily and every ₦ silently disappears from the document. Nobody notices until
an approved invoice is already in a WhatsApp group. Liberation Sans is the
classic trap: metrically Arial-compatible, widely recommended, missing the
glyph — and when the bundled catalogue was first fetched, Caladea, PT Sans and
PT Serif all failed the same check.

Every path that introduces a font therefore verifies it:

| Path | Guard |
|---|---|
| `scripts/fetch-fonts.mjs` | Checks on download; deletes a family that fails rather than leaving it on disk |
| `scripts/check-fonts.mjs` | Re-checks everything in `assets/fonts/`; run by `upload-assets.sh` and CI |
| `POST /api/fonts` | Checks both faces in the Worker before storing anything |

Do not add a font by any route that skips these.

### The catalogue

`shared/fonts.js` lists what ships. Fonts are **self-hosted** — fetched once,
pushed to KV, served from there — so no third-party font service is in the path
when an invoice is rendered.

| Key | Font | Stands in for |
|---|---|---|
| `arimo` | Arimo | Arial, Helvetica |
| `tinos` | Tinos | Times New Roman |
| `cousine` | Cousine | Courier New |
| `carlito` | Carlito | Calibri |
| `lato`, `firasans`, `spectral` | — | house faces, no metric equivalent |

Metric compatibility is what buys fidelity: the same character widths as the
proprietary face a vendor's stationery was set in, so line breaks and page
rhythm land where their own document puts them even though the letterforms
differ.

An admin can upload anything the catalogue misses, through Settings or
`POST /api/fonts`. Uploaded fonts live in the `fonts` table plus KV under
`fonts/<key>-Regular.ttf`; bundled keys cannot be overwritten or deleted, and a
font a vendor is still using cannot be deleted either.

`arimo` is `FALLBACK_FONT`: a template naming a family whose files are absent
falls back to it rather than failing the download, because the wrong face is
recoverable and a missing invoice is not.

```bash
node scripts/fetch-fonts.mjs      # download and verify the catalogue
./scripts/upload-assets.sh acme   # artwork for one vendor + all shared fonts
```

## Layout geometry

The source template was **1109×1583 pt** — roughly 1.87× A4 and not a standard
size. `renderInvoice.js` renders true A4 (595.28×841.89) and scales the source
geometry by `K = 595.28 / 1109`.

Two coordinate helpers, and mixing them up is the bug to watch for:

- `T(top)` — top offset already in A4 points. Body text.
- `ART(topSrc)` — top offset in *source template* points; scales it. Artwork.

Scaling only x and the dimensions while leaving `top` in A4 space drops the
footer off the page and slides the taglines into the body text. Both axes.

The contact block is drawn as **live text**, not the source raster: in the
original that image runs from x=858 to x=1232 on a 1109pt page, 123pt off the
edge, so the address was clipped. Full address recovered from the raster:
*1 Example Street, Lagos*.

## Locations are data; request types are code

`business_units`, `sites` and `bu_sites` are D1 tables, edited by the client
admin from Settings. `loadReference()` reads them **uncached** — at this volume
three small reads per request cost nothing, and an isolate serving a site the
admin just disabled is the worse failure.

- **`bu_sites` is many-to-many.** Lekki is billed by both RFC and Retail, so a
  `sites.bu_code` column would have been wrong from the first row.
- **Codes are immutable, names are not.** Codes are written as plain text onto
  every request and invoice; renaming one would orphan history. Deactivating
  hides a location from the form and leaves existing rows resolvable.
- **`CODE_RE` allows 2–8 characters.** `HQ` is two. Do not tighten it, and do
  not let a ref parser assume `[A-Z]{3}` — split on `/`.
- A BU's `numbering_site` is validated against real sites: BU-scope requests
  store `site_code` NULL and borrow it for the ref.

**Request types stay in `shared/reference.js`** and must not follow. They carry
behaviour, not labels: `scope` drives validation, `extraField` drives the form
and what is printed, and `dedupe` maps to a partial unique index in the
migration. A request type added from a UI would silently have no duplicate
guard at all.

`SEED_BUSINESS_UNITS` / `SEED_SITES` / `SEED_BU_SITES` in that file are the seed
for a fresh database only. Nothing at runtime reads them.

## HQ is two characters

`HQ` is two characters while every other site code is three. Do not add a
`length()` check anywhere, and do not let a ref parser assume `[A-Z]{3}` — split
on `/`.

## Passwords and provisioning

**Provisioning is manual until SSO goes live.** A client admin creates every
account, client and vendor alike, with a password. SSO auto-provisioning only
starts once single sign-on is configured and proven — see the cutover in Auth.

**Policy lives in `shared/password.js`** so the form and the server cannot
disagree. Length is the rule: 12 characters minimum, and deliberately **no
composition requirements**. Demanding an uppercase and a symbol pushes people
to `Password1!` — short, predictable, in every wordlist — and away from a long
passphrase. NIST 800-63B dropped composition rules for this reason.

What is rejected instead: too short, barely any variety, keyboard runs, and a
small blocklist of what people actually type. Two subtleties worth keeping:

- The blocklist matches the **whole** password after stripping decoration, not
  a substring. `a-long-enough-password` is a fine passphrase; `Password1!` and
  `P@ssw0rd` are not. Substring matching rejected the first, which is wrong.
- The identity check asks whether the email or name is doing the **work** —
  remove it and see whether enough is left. `samantha@client.example` as a
  password fails; `a brand new passphrase here` for someone at `phrase@…` does
  not, and rejecting it would be baffling.

### Resets are manual

There is no email delivery, so an admin sets a temporary password and hands it
over in person. Because the admin then knows it, the account is flagged
`must_change_password` and **everything is closed** until the owner replaces
it, bar the routes needed to do so (`/api/bootstrap`, `/api/me`,
`/api/auth/password`, `/api/auth/logout`).

That gate sits **directly after authentication**, not at the bottom of the
router. It was first written below the business routes, where it caught only
unmatched paths and protected nothing. A guard placed after the routes it
guards is not a guard.

An admin cannot reset their own password through that route — changing your own
requires the current one, so an unattended session cannot be used to take an
account over.

## Auth

- **client admins** see two pages only: the request table, read-only, and the
  vendors-and-users page. They cannot raise or withdraw requests — `createRequest`
  and `withdrawRequest` require `role = 'requester'`.
- **the client** → Cloudflare Access, with two IdPs: Microsoft Entra ID (native)
  and Zoho Directory (Generic SAML 2.0 — Zoho routes custom apps through SAML,
  not OIDC). Lock the Entra IdP to the client's tenant ID *and* add an Access
  policy on the email domain; accepting the multi-tenant `common` endpoint
  without validating `tid` lets any Microsoft account sign in.
- **PBKDF2 is capped at 100,000 iterations by the runtime**, not by choice:

      NotSupportedError: Pbkdf2 failed: iteration counts above 100000
      are not supported (requested 210000)

  That is below current OWASP guidance, so do not read 100,000 as a
  recommendation — it is the ceiling Workers allows, and bcrypt/argon2 need
  WASM. **miniflare does not enforce it**, so a higher number passes every test
  locally and then 500s on the first production sign-in. It did exactly that.
  There is now an assertion pinning it; if you change it, deploy and sign in
  before believing it works.

  A hash stored above the ceiling can never be verified — the runtime refuses
  the derivation rather than returning a wrong answer — so `verifyPassword`
  detects that case, logs `PASSWORD_HASH_UNVERIFIABLE`, and returns false
  instead of throwing. Any such account needs an admin reset.

- **Vendors** → email + password, permanently. They are not in the client's
  directory and never will be, so single sign-on does not apply to them and the
  cutover leaves them untouched. A password reset by an admin is their only
  recovery path. MFA is a possible later addition; there is none today. PBKDF2-HMAC-SHA256 via SubtleCrypto
  (bcrypt/argon2 need WASM in Workers). `PBKDF2_ITERATIONS` cannot rise past the runtime ceiling above.
- **Roles live in D1, never in IdP group claims.** Vendor staff are not in
  the client's directory, and group mapping would let the client's IT grant themselves
  approver rights.
- **client provisioning is open; a vendor's is not.** A client identity
  that Access has authenticated gets a `users` row on first sign-in, always
  `client` / `requester` — the org and role are never read from the token.
  The Access policy is therefore the real gate on who can raise a request; set
  `SSO_ALLOWED_DOMAINS` as defence in depth if that policy is ever widened. A
  disabled account is refused, not resurrected.
- **The client admin owns the vendor list and every vendor roster.**
  `/api/vendors*` and `/api/users*` require `org = 'client'` **and**
  `role = 'admin'`; a vendor cannot add its own accounts. A vendor admin can
  still edit their **own** `vendor_config` — whose bank account gets paid stays
  a decision of the party being paid, and the client admin is refused there. Removal is a disable, never a `DELETE` — `users.id` is the target of
  `requests.created_by`, `requests.decided_by` and `invoices.issued_by`, so
  deleting a row would orphan the record of who approved an issued invoice.
  Note the consequence: the client admin can create a vendor approver and sign
  in as it. The self-approval check compares user ids, so that path is not
  caught. This is a deliberate ownership decision, not an oversight.
**Today: passwords only, accounts created by hand.** SSO is off out of the box
and there is no plan to turn it on. Every account — client staff and vendor
staff alike — is created by a client admin with one email address and a
password. `users.email` is UNIQUE, so one person is one account, and the
duplicate-identity problem below cannot arise while provisioning stays manual.

The SSO path exists, is tested, and costs nothing while unused. Everything
after this point applies only if someone later switches it on.

- **Several email domains are normal.** `sso_allowed_domains` is a comma
  separated list and an organisation may well have three. Matching is exact and
  case-insensitive: a suffix match would admit `evil-yourcompany.com`, and
  subdomains are not implied, so list `mail.yourcompany.com` separately if you
  use it.
- `users.email` is the join key, so one person arriving via Entra and via Zoho
  resolves to one record **only if both assert the same address**. With several
  domains in play this is a live risk rather than a theoretical one: someone
  who signs in once as `a@domain-one` and later as `a@domain-two` becomes two
  accounts with separate roles and separate history. There is no merge. If the Zoho
  population is on a different domain, one human becomes two users and the
  self-approval check stops working.

## Structure

```
shared/reference.js     BUs, sites, types, ref/money formatting (both sides)
migrations/0001_init.sql
worker/
  worker.js             routes, validation, approval, PDF route
  auth.js               Access JWT verify, PBKDF2, session cookie
  renderInvoice.js      pdf-lib renderer, pure (invoice, assets) -> bytes
src/
  App.jsx               boot, tabs, vendor login
  api.js theme.js
  components/
    RequestForm.jsx     BU->site cascade, type-driven fields, unbranded preview
    Queue.jsx           shared pending queue, approve/reject
    History.jsx         decided requests, PDF links, withdraw
    Config.jsx          bank, signatory + tax, own vendor (vendor admin only)
    Vendors.jsx         vendors + their staff (client admin only)
    Locations.jsx       sites, BUs, BU->site map, platform fee (client admin)
  shareInvoice.js       Web Share API handoff of the PDF to WhatsApp
    Shell.jsx           Card, Field, Table, Modal, Status, Banner
scripts/
  test-e2e.mjs          205 assertions against real SQLite via d1-shim
  d1-shim.mjs           D1 API over node:sqlite (test only)
  extract-assets.py     pull letterhead art out of a source PDF
  upload-assets.sh      push art + fonts to KV
  add-user.mjs          emits INSERT with a PBKDF2 hash
  seed.sql
```

## Setup

```bash
npm install
npx wrangler d1 create vendor-invoice-request          # put the id in wrangler.toml
npx wrangler kv namespace create ASSETS_KV         # put the id in wrangler.toml
npx wrangler secret put SESSION_SECRET             # long random string

npm run db:local
npx wrangler d1 execute vendor-invoice-request --local --file=scripts/seed.sql

# Artwork is per vendor and namespaced by vendors.code in KV.
python scripts/extract-assets.py path/to/sample.pdf --out assets/<vendor-code>
# drop Arimo-Regular.ttf and Arimo-Bold.ttf into assets/ (shared, not per vendor)
./scripts/upload-assets.sh <vendor-code> --local

# Job title and phone are required for vendor accounts: they are printed in the
# signature block of every invoice this person approves.
node scripts/add-user.mjs vendor <vendor-code> approver@example.com "Their Name" \
     approver "Business Development Manager" "+234 803 555 0142" 'a-long-password' > u.sql
npx wrangler d1 execute vendor-invoice-request --local --file=u.sql

npm test          # 205 assertions, no wrangler needed
npm run preview   # build + wrangler dev
```

Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.toml` vars before the client
SSO will work. Without them the Worker skips the Access path entirely and only
the password login functions — useful locally, wrong in production.

## Testing

`npm test` runs the real Worker handler against a real SQLite database through a
D1 shim — routes, roles, validation, duplicate guards, numbering, PDF bytes. It
needs no Cloudflare account and no network. Add a case there for any change to
numbering, the duplicate indexes, the approval path, the vendor scoping, or the
roster routes.

It does need the letterhead artwork and a font carrying **U+20A6**. Both are
overridable, which is what makes the suite runnable off Linux:

```bash
ASSET_DIR=/path/to/pngs \
FONT_REGULAR=C:/Windows/Fonts/arial.ttf \
FONT_BOLD=C:/Windows/Fonts/arialbd.ttf npm test
```

Arial is a valid stand-in locally — Arimo is metrically compatible with it and
Arial carries the Naira glyph. Do not ship Arial; it is not licensed for
redistribution.

It does **not** cover: Cloudflare Access JWT verification (no signing key
available offline), the React components (no DOM tests), or D1's real
concurrency behaviour under a genuine race.

## Conventions

- Inline styles with the `T` palette, as in the CFM shell. No CSS framework.
- Money formatting only via `naira()` from `shared/reference.js`.
- Every mutating route re-checks `org` and `role` server-side. A check in React
  is not a control.
- `console.warn('BANK_DETAILS_CHANGED', …)` on any bank change so it lands in
  `wrangler tail`. Wire it to a real notification before go-live.

## Known gaps

- No email delivery. The approving vendor shares the PDF manually — there is a
  **Share to WhatsApp** button (`shareInvoice.js`, Web Share API) that hands the
  file to the OS share sheet, but on desktop that needs the installed WhatsApp
  app; a browser tab is not a share target, so it falls back to a download. ApprovalMax
  Capture accepts a forwarded PDF at a per-organisation address, so emailing
  approved PDFs straight there is the obvious next step — one PDF per email,
  since ApprovalMax creates a draft for every attachment.
- No `render_hash`, no template versioning. Regenerating an old invoice after a
  template change will produce a visually different document. Acceptable while
  there is one template; revisit if a document is ever disputed.
- Corrections are reject-then-resubmit. No supersede/revision chain.
- The first vendor's letterhead contact block was transcribed from a raster and
  is unverified. Check every vendor's contact lines against their own artwork.
- **The WHT treatment is an assumption worth confirming.** VAT is added to the
  total and WHT is shown as a deduction with a net-payable figure, which is the
  standard Nigerian treatment. Nobody has confirmed it against how the client AP
  actually pays. Getting it wrong changes what is transferred.
- **One template, many vendors.** `renderInvoice.js` still has the first vendor's
  geometry baked in (`K = 595.28 / 1109`, the `ART()` offsets). Onboarding a
  vendor swaps the artwork and the contact lines but not the layout, so a vendor
  whose invoice is laid out differently will come out looking like the first
  vendor's
  with their logo on it. Making the geometry a stored per-vendor template spec,
  drafted from a sample PDF, is the next piece of work.
- A rejection is terminal for **all** vendors, not just the one that rejected.
  If vendor A declines a request, vendor B never sees it again. That may not be
  what you want once there is real competition for the queue.
- Every vendor sees every pending request, including amount, site and
  description. That is deliberate — it is what makes the queue a marketplace —
  but it does mean vendors can see each other's potential work.
