-- A completed maintenance record's mileage is recorded as an odometer snapshot at
-- its service date. This links that snapshot back to the maintenance record so it
-- moves/updates when the maintenance's date or odometer is edited. SET NULL on
-- delete keeps the odometer data point if the maintenance is later removed.
ALTER TABLE vehicle_odometer_readings ADD COLUMN IF NOT EXISTS maintenance_id INTEGER REFERENCES vehicle_maintenance(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_maintenance ON vehicle_odometer_readings(maintenance_id);
