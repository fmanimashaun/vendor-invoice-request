# Vendor Invoice Request Platform

The client raises a payment request. Every onboarded vendor sees one shared
queue; whichever approves first issues a numbered PDF on their own
letterhead. Replaces a manual Google Docs process where one document was
duplicated and hand-edited for every request.

```
Client (SSO: Entra / Zoho)          Vendors (email + password)
        │                                       │
        │  raise request                        │  review pending queue
        ▼                                       ▼
   ┌──────────────────────────────────────────────────┐
   │  Cloudflare Worker + D1                          │
   │  · duplicate-period guards                       │
   │  · invoice number reserved AT APPROVAL            │
   │  · pdf-lib renders A4 on the vendor's letterhead │
   └──────────────────────────────────────────────────┘
                          │
                    download PDF → WhatsApp → ApprovalMax
```

React 18 + Vite on Cloudflare Pages · Worker · D1 · KV. No server to run.

---

## Contents

- [Quick start (local)](#quick-start-local)
- [Deploy to production](#deploy-to-production)
- [Single sign-on setup](#single-sign-on-setup)
- [Managing users](#managing-users)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Before go-live](#before-go-live)

---

## Quick start (local)

Requires Node 20+ and a Cloudflare account.

### 1. Install

```bash
git clone <your-repo-url> vendor-invoice-request
cd vendor-invoice-request
npm install
```

### 2. Letterhead artwork

Ask each vendor for **two documents**: a blank letterhead and one old invoice.
The blank supplies the stationery safely; the invoice supplies the layout.

```bash
pip install pdfplumber pillow
python scripts/extract-template.py blank.pdf --code acme --blank --layout old-invoice.pdf
./scripts/upload-assets.sh acme --local
```

The renderer needs each vendor's letterhead as PNGs plus a font. Extract the
artwork from any of the existing sample PDFs:

```bash
pip install pdfplumber pillow
python scripts/extract-assets.py path/to/an-existing-invoice.pdf
```

That writes `assets/header.png`, `footer.png`, `logo.png`,
`tagline_services.png`, `tagline_slogan.png`.

**Then add Arimo.** Download from
[Google Fonts](https://fonts.google.com/specimen/Arimo) (Apache-2.0) and put
`Arimo-Regular.ttf` and `Arimo-Bold.ttf` in `assets/`.

> **Why Arimo specifically.** The document needs the Naira sign ₦ (U+20A6).
> Arimo has it and is metrically compatible with Arial, which the original
> template used. **Liberation Sans does not have the glyph** and silently drops
> every ₦ from the PDF — no error, just missing currency symbols.

### 3. Create the Cloudflare resources

```bash
npx wrangler login
npx wrangler d1 create vendor-invoice-request
npx wrangler kv namespace create ASSETS_KV
```

Copy the two IDs printed into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "vendor-invoice-request"
database_id = "paste-the-d1-id-here"

[[kv_namespaces]]
binding = "ASSETS_KV"
id = "paste-the-kv-id-here"
```

### 4. Migrate, seed, upload assets

```bash
npm run db:local
npx wrangler d1 execute vendor-invoice-request --local --file=scripts/seed.sql
./scripts/upload-assets.sh --local
```

### 5. Create a vendor user

Passwords are hashed with PBKDF2, so use the helper rather than writing SQL:

```bash
node scripts/add-user.mjs vendor <vendor-code> approver@example.com "Their Name" \
  approver "Their Job Title" "+234 800 000 0000" 'choose-a-long-password' > u.sql
npx wrangler d1 execute vendor-invoice-request --local --file=/tmp/u.sql
```

### 6. Session secret and run

```bash
echo 'SESSION_SECRET=any-long-random-string-for-local-dev' > .dev.vars
npm run dev            # Vite on :5173, Worker via the Cloudflare plugin
```

Open http://localhost:5173 and sign in with the vendor user you created.

> **SSO does not work locally.** Cloudflare Access only injects its JWT for
> traffic that passes through Cloudflare, so the "Sign in with single sign-on"
> button returns `access_not_configured` on localhost. To exercise the client
> side locally, create a client user and give them a password temporarily —
> or test SSO on a deployed preview.

---

## Deploy to production

### 1. Remote database, KV and secret

```bash
npm run db:remote
npx wrangler d1 execute vendor-invoice-request --remote --file=scripts/seed.sql
./scripts/upload-assets.sh              # remote
npx wrangler secret put SESSION_SECRET  # paste a long random string
```

Generate a secret with `openssl rand -base64 48`.

### 2. Deploy

```bash
npm run deploy
```

Or connect the repo to Cloudflare Pages for push-to-deploy on `main`
(build command `npm run build`, output directory `dist`).

### 3. Custom domain

Add it under **Workers & Pages → your project → Settings → Domains**. The rest
of this guide assumes `invoices.example.com`.

### 4. Create the vendor users on production

Same as step 5 above but with `--remote`.

### Rollback

`npm run deploy` creates a new version. To revert, redeploy the previous git
commit — the schema is additive so far, so no data migration is involved. If you
ever add a destructive migration, write the down-migration first.

**Blast radius note:** `scripts/seed.sql` uses `INSERT OR REPLACE` on the config
row. Running it against production a second time resets bank details and the
processing fee to the seeded values. Run it once, then manage config through the
app.

---

## Single sign-on setup

client staff sign in through Cloudflare Access. Vendor staff use email and
password inside the app. Both end up with the same session cookie.

### The important part: protect ONE path, not the whole site

```
Access application path:   /api/auth/sso     ← protect this
Everything else:           no Access policy
```

`/api/auth/sso` is where Access authenticates the user and hands the Worker a
signed JWT. The Worker verifies it, matches the email to a `users` row, sets its
own session cookie, and redirects to `/`.

**If you protect the whole hostname instead, vendors are locked out** — they
have no Entra or Zoho identity, so Access will never let them reach the password
form. This is the single most common way to get this wrong.

### 1. Find your team name

Cloudflare dashboard → **Zero Trust** → **Settings** → **Team name and domain**.
Everything below uses `<team>` for this value, e.g. `acme`, giving
`acme.cloudflareaccess.com`.

The callback URL every IdP needs is:

```
https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
```

### 2. Microsoft Entra ID

**In the [Entra admin center](https://entra.microsoft.com/):**

1. **Applications → Enterprise applications → New application → Create your own
   application.**
2. Name it, then choose **Register an application to integrate with Microsoft
   Entra ID**. Do not pick a gallery app. **Create**.
3. Under **Redirect URI**, platform **Web**, enter the callback URL above.
   **Register**.
4. Go to **Applications → App registrations → All applications**, open the app,
   and copy the **Application (client) ID** and **Directory (tenant) ID**.
5. **Client credentials → Add a certificate or secret → New client secret.**
   Copy the **Value** immediately — it is only shown once. Note the expiry date;
   **when this secret expires, all the client logins stop working.**
6. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions**, and enable all seven:

   `email` · `offline_access` · `openid` · `profile` · `User.Read` ·
   `Directory.Read.All` · `GroupMember.Read.All`

7. **Add permissions**, then **Grant admin consent**.

**In Cloudflare:** **Zero Trust → Integrations → Identity providers → Add new
identity provider → Azure AD.** Enter the client ID, client secret and directory
(tenant) ID. **Save**, then **Test**.

> If your UPNs differ from users' email addresses (e.g. UPN `u908080@domain.com`
> but email `user@domain.com`), add an email claim in Entra under **Token
> configuration**, and set **Email claim** in the Cloudflare IdP config. This app
> keys users on **email**, so getting this right matters.

### 3. Zoho

Zoho is configured as **Generic OIDC** in Cloudflare, using a client created in
the Zoho API Console. (Zoho Directory can also act as a SAML IdP, but if you are
using the API Console then OIDC is the right integration type.)

**In [api-console.zoho.com](https://api-console.zoho.com/):**

1. **Add Client → Server-based Applications.**
2. Name it, set the homepage URL, and set **Authorized Redirect URI** to the
   callback URL above.
3. Copy the **Client ID** and **Client Secret**.

**Get the exact endpoint URLs from your data centre's discovery document.**
Zoho runs regional data centres (`.com`, `.eu`, `.in`, `.com.au`, `.jp`, `.ca`,
`.sa`) and the URLs differ per region. Open:

```
https://accounts.zoho.com/.well-known/openid-configuration
```

substituting your region's domain, and read off three values:

| Cloudflare field | Discovery document key |
|---|---|
| **Auth URL** | `authorization_endpoint` |
| **Token URL** | `token_endpoint` |
| **Certificate URL** | `jwks_uri` |

> These are typically under `https://accounts.zoho.com/oauth/v2/…`, but **take
> them from the discovery document rather than typing them from memory** — the
> JWKS path in particular varies, and a wrong value fails at login with an
> unhelpful error.

**In Cloudflare:** **Zero Trust → Integrations → Identity providers → Add new
identity provider → OpenID Connect.** Enter the client ID, client secret, and
the three URLs. Enable **PKCE** if Zoho supports it for your client type.
**Save**, then **Test**.

Requested scopes should include `openid`, `email`, `profile` so the `email`
claim comes back — the app cannot match a user without it.

### 4. Create the Access application

**Zero Trust → Access → Applications → Add an application → Self-hosted.**

| Field | Value |
|---|---|
| Application name | `Vendor Invoice Request SSO` |
| Domain | `invoices.example.com` |
| Path | `api/auth/sso` |

Then add a policy:

| Field | Value |
|---|---|
| Policy name | `client staff` |
| Action | Allow |
| Include | **Emails ending in** `@yourcompany.com` |

Under the application's **Authentication** settings, select **both** the Entra ID
and Zoho login methods so users get a chooser.

> **Lock Entra to your tenant.** You configured the specific Directory (tenant)
> ID in step 2, and the email-domain policy above is the second layer. Both
> matter: an Entra integration that accepts the multi-tenant `common` endpoint
> without validating the tenant will let any Microsoft account on the internet
> authenticate.

### 5. Copy the AUD tag into the Worker

Open the Access application you just created and copy its **Application
Audience (AUD) Tag** from the overview/settings page. Then in `wrangler.toml`:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"
ACCESS_AUD = "the-long-hex-aud-tag"
```

Redeploy. The Worker verifies every Access JWT against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` **and** checks that
`aud` matches. Without the AUD check, a token minted for any other Access
application in the same team would be accepted here.

### 6. Add the client users

Access proves who someone is; this app decides what they may do. Provisioning is
**closed** — authenticating with Entra or Zoho is not an account:

```bash
node scripts/add-user.mjs client someone@yourcompany.com "Their Name" requester > u.sql
npx wrangler d1 execute vendor-invoice-request --remote --file=/tmp/u.sql
```

Anyone who authenticates without a `users` row gets a "No access" page. This is
deliberate: without it, every employee of the client could raise funding requests.

**Roles are never read from IdP group claims.** Vendor staff are not in
the client's directory, so group mapping cannot express the model — and it would
let the client's IT grant themselves approver rights.

---

## Managing users

```bash
# Vendor staff (password required, 12+ characters)
node scripts/add-user.mjs vendor <vendor-code> someone@example.com "Their Name" \
  approver "Their Job Title" "+234 800 000 0000" 'a-long-password'

# Client (SSO; no password)
node scripts/add-user.mjs client someone@yourcompany.com "Their Name" requester
```

Pipe the output into `wrangler d1 execute … --file=`.

| Role | Org | Can |
|---|---|---|
| `requester` | client | Raise and withdraw own requests |
| `approver` | vendor | Approve, reject, download and share PDFs |
| `admin` | vendor | Also edit their own bank, signatory and tax details |

To disable someone: `UPDATE users SET status='disabled' WHERE email='…';`

---

## How it works

### Invoice numbering

```
BU / SITE / YYYY / MON / NNN        RFC/GBG/2026/SEP/001
```

Counter scope is **(business unit, site, period)**, so Lekki Clinic and RFC
Surulere have independent sequences. Numbers are assigned **at approval**, never
at request time — otherwise a rejected request burns a number and leaves a gap
in the issued sequence.

The ref is a derived display string; `period` is a separate sortable column.
Year sits before month so a plain text sort in Excel comes out chronological.
Download filenames flatten the slashes: `RFC-GBG-2026-SEP-001.pdf`.

### Duplicate prevention

The highest-value control in the system — it stops the same bill being funded
twice.

| Type | One per |
|---|---|
| Electricity | site + month |
| Router internet | site + month + router number |
| Staff data & credit | business unit + month |

Rejected and withdrawn requests are excluded, so a corrected resubmission is
never blocked.

### Why The client cannot produce a letterheaded document

Three things enforce this, and all three are load-bearing:

1. An `invoices` row is created only by `/api/requests/:id/approve`, which
   requires `org = 'vendor'`.
2. The PDF route resolves an issued invoice **by number only** — no request id,
   no ad-hoc field values.
3. The requester's on-screen preview is plain text with **no artwork**.

> Adding a "preview as it will look" feature with the letterhead on it silently
> destroys this. Don't.

### Bank details

Editable by that vendor's own admin, and **copied onto each invoice row at issue**.
Changing them affects future approvals only; a document already issued keeps its
original account number. There is a test for this.

---

## Testing

```bash
npm test
```

59 assertions against a real SQLite database through a D1 shim — routes, roles,
validation, duplicate guards, numbering, PDF bytes, and the SSO route's failure
modes. No Cloudflare account and no network required, so it runs in CI.

Not covered, so exercise these manually after any change:

- Cloudflare Access JWT verification (no offline signing key)
- The React components (no DOM tests)
- D1 under a genuine concurrent-approve race — the optimistic retry is written
  and the constraints are correct, but only tested single-threaded

---

## Troubleshooting

**`access_not_configured` when clicking single sign-on**
No Access policy covers `/api/auth/sso`, or you are on localhost. Check the
Access application's **Path** is `api/auth/sso` with no leading slash.

**`Could not verify the Access token`**
`ACCESS_AUD` does not match the application's AUD tag, or `ACCESS_TEAM_DOMAIN`
is wrong. It must be the bare hostname, `<team>.cloudflareaccess.com`, with no
`https://`.

**"No access" page after a successful SSO login**
The email authenticated fine but has no `users` row. Add it (see above). If the
address shown is not what you expect, your IdP is returning a UPN rather than an
email — configure the email claim.

**All ₦ symbols missing from the PDF**
The font in KV lacks U+20A6. Upload Arimo, not Liberation Sans.

**`Missing asset in KV: header.png`**
`./scripts/upload-assets.sh` was not run for that environment. Local and remote
KV are separate.

**the client login stopped working, nothing changed**
The Entra client secret expired. Create a new one and update the Cloudflare IdP
config.

**`duplicate_period` on a request you believe is new**
Something for that site and month already exists in `pending` or `approved`. The
error names it. Reject or withdraw the old one first.

---

## Before go-live

- [ ] Confirm the **WHT treatment** against how the client AP actually pays. VAT
      is added to the invoice total; WHT is shown as a deduction with a
      net-payable figure. That is the standard treatment but it is an
      assumption, and it changes what gets transferred.
- [ ] Upload each vendor's letterhead artwork to KV under their vendor code.
      Approvals succeed without it; the PDF render is what fails.
- [ ] Verify the phone number on the letterhead — it was transcribed from a
      raster image and is unconfirmed.
- [ ] Confirm the beneficiary account, and that the Zoho and Entra populations
      use the **same email domain**. If they differ, one person becomes two user
      rows and the self-approval guard stops working.
- [ ] Note the Entra client secret expiry somewhere you will see it.
- [ ] Decide whether bank-detail changes should notify both teams. Currently
      they only write a `BANK_DETAILS_CHANGED` line visible in `wrangler tail`.

## Known gaps

- No per-vendor template *geometry*. Onboarding swaps artwork and contact lines
  but not the layout, so a vendor whose invoice is laid out differently comes
  out looking like the first vendor's with their logo on it.
- A rejection is terminal for **all** vendors, not just the one that rejected.
- Every vendor sees every pending request, including amounts — deliberate, but
  it is visible competitor information.
- No email delivery — the vendor shares manually, via the Share to WhatsApp
  button or a download. ApprovalMax
  Capture accepts a forwarded PDF at a per-organisation address, so emailing
  approved PDFs straight there is the obvious next step (one PDF per email,
  since ApprovalMax creates a draft for every attachment).
- No render hash or template versioning. Regenerating an old invoice after a
  template change produces a visually different document. Fine with one
  template; revisit if a document is ever disputed.
- Corrections are reject-then-resubmit, not a supersede chain.

## Further reading

- `CLAUDE.md` — conventions, invariants and traps for anyone (or any agent)
  editing the code
- `DESIGN.md` — why it is shaped this way, and the decisions log
