-- Additional vehicle specifications. Most can be auto-filled by decoding the VIN
-- (trim, type, fuel, engine, transmission, drivetrain); license plate and exterior
-- color are user-entered. All additive & idempotent.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS trim           TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS vehicle_type   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_type      TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS license_plate  TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS engine_type    TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS transmission   TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS drivetrain     TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS exterior_color TEXT;
