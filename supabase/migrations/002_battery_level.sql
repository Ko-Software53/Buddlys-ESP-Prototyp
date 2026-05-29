-- Battery level reported by the device (0–100 %), NULL until first report.
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS battery_level INTEGER
  CHECK (battery_level IS NULL OR (battery_level >= 0 AND battery_level <= 100));
