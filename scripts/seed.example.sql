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

-- The first admin. They own the vendor list, every vendor roster, and the
-- locations above. Email must match what your IdP asserts.
--
-- Other client staff are provisioned automatically on first SSO sign-in, as
-- requesters. Vendor accounts are created in the app by this admin.
INSERT OR IGNORE INTO users (email, full_name, org, role) VALUES
  ('admin@example.com', 'First Admin', 'client', 'admin');

-- Vendors are onboarded in the app rather than seeded: they need bank details,
-- a signatory, optional tax settings, and letterhead artwork uploaded to KV
-- under their vendor code.
