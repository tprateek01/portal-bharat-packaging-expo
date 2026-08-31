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
