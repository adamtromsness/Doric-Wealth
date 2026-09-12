-- Clarify the warranty mileage field: it's the absolute odometer reading at which
-- the warranty expires (e.g. bought at 25,000 with a 10,000-mile warranty => 35,000),
-- not a duration. Rename miles -> expires_miles. Idempotent (guarded both ways).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'vehicle_warranties' AND column_name = 'miles')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'vehicle_warranties' AND column_name = 'expires_miles') THEN
    ALTER TABLE vehicle_warranties RENAME COLUMN miles TO expires_miles;
  END IF;
END $$;
