-- Payments (Task 6) & Service Request Forms (Task 7)
--
-- Both are data the admin portal itself owns (not the registration
-- site's schema) — same pattern as `stalls` / `hall_managers` in
-- 002_hall_stall_management.sql. Each row belongs to one exhibitor
-- (exhibitor_booking), so the admin picks the exhibitor when recording
-- a payment or logging a request; the API then joins in that
-- exhibitor's company name for display (see FROM_OVERRIDES in server.js).
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  exhibitor_booking_id INTEGER NOT NULL REFERENCES exhibitor_booking(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  payment_mode TEXT,
  transaction_reference TEXT,
  payment_date DATE,
  remarks TEXT,
  -- Same 4-state workflow as every other section of this portal:
  -- Registered = recorded but not yet verified, Approved = verified,
  -- Rejected = bounced / invalid payment, Inactive = cancelled/refunded.
  status TEXT NOT NULL DEFAULT 'Registered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('Registered', 'Approved', 'Rejected', 'Inactive'));

CREATE INDEX IF NOT EXISTS payments_exhibitor_idx ON payments (exhibitor_booking_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status);

CREATE TABLE IF NOT EXISTS service_requests (
  id SERIAL PRIMARY KEY,
  exhibitor_booking_id INTEGER NOT NULL REFERENCES exhibitor_booking(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL,
  description TEXT,
  requested_date DATE,
  -- Registered = new/open request, Approved = actioned/fulfilled,
  -- Rejected = declined, Inactive = withdrawn/closed without action.
  status TEXT NOT NULL DEFAULT 'Registered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE service_requests DROP CONSTRAINT IF EXISTS service_requests_status_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_status_check
  CHECK (status IN ('Registered', 'Approved', 'Rejected', 'Inactive'));

CREATE INDEX IF NOT EXISTS service_requests_exhibitor_idx ON service_requests (exhibitor_booking_id);
CREATE INDEX IF NOT EXISTS service_requests_status_idx ON service_requests (status);