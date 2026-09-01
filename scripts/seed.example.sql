-- Example seed. Copy to scripts/seed.local.sql and edit for your deployment:
--
--   cp scripts/seed.example.sql scripts/seed.local.sql
--   npm run seed
--
-- scripts/seed.local.sql is gitignored, so nothing about your organisation,
-- your sites or your vendors ends up in this repository.

-- The organisation running this deployment. Shown in the UI.
INSERT OR REPLACE INTO config (id, org_name, default_fee_kobo)
VALUES (1, 'Example Group', 10000);

-- Locations. Codes are permanent once used; names are editable in Settings.
INSERT OR IGNORE INTO sites (code, name) VALUES
  ('HQ',  'Head Office'),
  ('NTH', 'North Branch'),
  ('STH', 'South Branch');

-- Business units. numbering_site supplies the ref segment for unit-wide
-- requests, whose site_code is NULL.
INSERT OR IGNORE INTO business_units (code, name, numbering_site) VALUES
  ('OPS', 'Operations', 'HQ');

-- Which locations each unit may raise requests against. Many-to-many: a site
-- can be billed by more than one unit.
INSERT OR IGNORE INTO bu_sites (bu_code, site_code) VALUES
  ('OPS', 'HQ'),
  ('OPS', 'NTH'),
  ('OPS', 'STH');

-- The root admin. They own the vendor list, every vendor roster, the locations
-- above and the single sign-on settings, and can add further admins.
--
-- Single sign-on is OFF until they configure it, so give this account a
-- password with scripts/add-user.mjs and sign in with it. Once SSO is set up
-- and someone has completed a sign-on with it, client passwords stop working
-- and staff are provisioned automatically on first sign-in.
--
-- If you will use SSO, this email must match what your IdP asserts.
-- 'admin' only: administering the platform and raising payment requests are
-- separate jobs, and this account does not need to do the second. Give staff
-- who do both 'admin,member' and they switch context in the app.
--
-- No password here. Create one so you can sign in before SSO exists:
--   node scripts/add-user.mjs client admin@example.com "First Admin" --        admin 'a-long-password' > /tmp/admin.sql
INSERT OR IGNORE INTO users (email, full_name, org, roles, default_role) VALUES
  ('admin@example.com', 'First Admin', 'client', 'admin', 'admin');

-- Vendors are onboarded in the app rather than seeded: they need bank details,
-- a signatory, optional tax settings, and letterhead artwork uploaded to KV
-- under their vendor code.
