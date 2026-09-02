-- Hall & Stall Management (Task 3)
--
-- Adds stall inventory + hall manager tables. Independent of the
-- registration site's schema (visitors / exhibitor_eoi / exhibitor_booking) —
-- this is data the admin portal itself owns and manages.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS stalls (
  id SERIAL PRIMARY KEY,
  hall_number TEXT NOT NULL,
  stall_number TEXT NOT NULL,
  floor TEXT,
  open_sides TEXT,
  length NUMERIC,
  breadth NUMERIC,
  -- Kept as a plain stored column (not GENERATED) so a row can still be
  -- saved even if only one of length/breadth is known yet — the app
  -- computes/refreshes this on insert & edit instead.
  area_sqm NUMERIC,
  -- Vacant until Task 4 (Space Booking <-> Stall linking) allots it to an
  -- exhibitor. exhibitor_booking_id is added now so that task doesn't need
  -- another migration.
  status TEXT NOT NULL DEFAULT 'Vacant',
  exhibitor_booking_id INTEGER REFERENCES exhibitor_booking(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE stalls DROP CONSTRAINT IF EXISTS stalls_status_check;
ALTER TABLE stalls ADD CONSTRAINT stalls_status_check
  CHECK (status IN ('Vacant', 'Allotted'));

-- A stall number only has to be unique within its own hall (two different
-- halls can both have a "01" stall).
DROP INDEX IF EXISTS stalls_hall_stall_unique;
CREATE UNIQUE INDEX stalls_hall_stall_unique ON stalls (hall_number, stall_number);

CREATE INDEX IF NOT EXISTS stalls_status_idx ON stalls (status);
CREATE INDEX IF NOT EXISTS stalls_floor_idx ON stalls (floor);

CREATE TABLE IF NOT EXISTS hall_managers (
  id SERIAL PRIMARY KEY,
  hall_number TEXT NOT NULL,
  manager_name TEXT NOT NULL,
  mobile_number TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);