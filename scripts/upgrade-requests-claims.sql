-- One-off upgrade for a database created BEFORE the claim model.
--
-- migrations/0001_init.sql is written with CREATE TABLE IF NOT EXISTS, so
-- re-running it against a live database never adds a column or widens a
-- CHECK. A database from before the claim model is missing
-- claimed_vendor_id / claimed_by / claimed_at / return_reason /
-- decline_reason, still has reject_reason, and its status CHECK refuses
-- 'claimed', 'returned' and 'declined'. The first symptom is
--   D1_ERROR: no such column: r.claimed_vendor_id
-- on GET /api/requests for a vendor. SQLite cannot alter a CHECK, so the
-- table is rebuilt in place, keeping every row and id.
--
-- Run ONCE, then re-run the migration to recreate the indexes:
--   npx wrangler d1 execute vendor-invoice-request --local  --file=scripts/upgrade-requests-claims.sql
--   npm run db:local
-- (--remote / npm run db:remote for the live database. Back it up first.)
--
-- Safe to run only when pragma_table_info('requests') lacks claimed_vendor_id.
-- It maps the old vocabulary onto the new: 'rejected' -> 'declined', and
-- reject_reason -> decline_reason.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE requests_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_ref   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','claimed','returned',
                                    'approved','declined','withdrawn')),
  bu_code       TEXT NOT NULL,
  site_code     TEXT,
  type_code     TEXT NOT NULL,
  period        TEXT NOT NULL,
  asset_key     TEXT,
  addressee     TEXT NOT NULL,
  addressee_loc TEXT NOT NULL DEFAULT 'Lagos.',
  subject       TEXT NOT NULL,
  narrative     TEXT NOT NULL,
  description   TEXT NOT NULL,
  fee_kobo      INTEGER NOT NULL,
  amount_kobo   INTEGER NOT NULL CHECK (amount_kobo > 0),
  total_kobo    INTEGER NOT NULL,
  ack_flags     TEXT NOT NULL DEFAULT '[]',
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by    INTEGER REFERENCES users(id),
  decided_vendor_id INTEGER REFERENCES vendors(id),
  decided_at    TEXT,
  claimed_vendor_id INTEGER REFERENCES vendors(id),
  claimed_by    INTEGER REFERENCES users(id),
  claimed_at    TEXT,
  return_reason TEXT,
  decline_reason TEXT,
  CHECK (total_kobo = amount_kobo + fee_kobo)
);

-- An approved request under the old model was decided by a vendor without a
-- claim step; treat the deciding vendor as the claimant so the vendor's own
-- history view, which is scoped by the claim, still shows it.
INSERT INTO requests_new (
  id, request_ref, status, bu_code, site_code, type_code, period, asset_key,
  addressee, addressee_loc, subject, narrative, description,
  fee_kobo, amount_kobo, total_kobo, ack_flags, created_by, created_at,
  decided_by, decided_vendor_id, decided_at,
  claimed_vendor_id, claimed_by, claimed_at, return_reason, decline_reason
)
SELECT
  id, request_ref,
  CASE status WHEN 'rejected' THEN 'declined' ELSE status END,
  bu_code, site_code, type_code, period, asset_key,
  addressee, addressee_loc, subject, narrative, description,
  fee_kobo, amount_kobo, total_kobo, ack_flags, created_by, created_at,
  decided_by, decided_vendor_id, decided_at,
  decided_vendor_id, decided_by, decided_at, NULL, reject_reason
FROM requests;

-- invoices is the only table that references requests, and SQLite's deferred
-- foreign-key tally has no way to re-validate children after their parent
-- table is dropped and recreated: the batch would roll back at commit with
-- "FOREIGN KEY constraint failed" even though every parent row is present.
-- So the invoice rows are parked while requests has no children, then put
-- back, id for id, once the rebuilt table exists.
CREATE TABLE invoices_park AS SELECT * FROM invoices;
DELETE FROM invoices;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

INSERT INTO invoices SELECT * FROM invoices_park;
DROP TABLE invoices_park;
