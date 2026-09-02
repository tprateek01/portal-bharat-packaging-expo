-- Bharat Packaging Expo — admin portal migration
--
-- Run this against the SAME Neon database used by the registration site
-- (bharat-expo). It only ADDS a status column to the existing tables so
-- the portal can track Registered / Approved / Rejected / Inactive —
-- it does not touch any existing data.
--
-- Safe to re-run.

ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Registered';

ALTER TABLE exhibitor_eoi
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Registered';

ALTER TABLE exhibitor_booking
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Registered';

-- Keep status values consistent. (Re-running this after already having
-- rows with a different casing is fine — this only constrains new writes.)
ALTER TABLE visitors DROP CONSTRAINT IF EXISTS visitors_status_check;
ALTER TABLE visitors ADD CONSTRAINT visitors_status_check
  CHECK (status IN ('Registered', 'Approved', 'Rejected', 'Inactive'));

ALTER TABLE exhibitor_eoi DROP CONSTRAINT IF EXISTS exhibitor_eoi_status_check;
ALTER TABLE exhibitor_eoi ADD CONSTRAINT exhibitor_eoi_status_check
  CHECK (status IN ('Registered', 'Approved', 'Rejected', 'Inactive'));

ALTER TABLE exhibitor_booking DROP CONSTRAINT IF EXISTS exhibitor_booking_status_check;
ALTER TABLE exhibitor_booking ADD CONSTRAINT exhibitor_booking_status_check
  CHECK (status IN ('Registered', 'Approved', 'Rejected', 'Inactive'));

-- ---------------------------------------------------------------------
-- Bulk upload history — tracks every .xlsx bulk-upload run (Domestic
-- Buyers today; reusable for other bulk-upload sections later) so the
-- "Uploads" panel can show past runs and let an admin download a
-- failure report for any rows that didn't import.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bulk_uploads (
  id SERIAL PRIMARY KEY,
  upload_type TEXT NOT NULL,              -- e.g. 'domestic_buyers'
  filename TEXT NOT NULL,
  uploaded_by TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Completed', -- Completed | Failed
  failure_report JSONB,                     -- [{ row, reason }, ...]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bulk_uploads_type_idx ON bulk_uploads (upload_type, created_at DESC);