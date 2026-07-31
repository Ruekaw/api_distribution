CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ip_minute_usage (
  minute_bucket TIMESTAMPTZ NOT NULL,
  ip_hash TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (minute_bucket, ip_hash)
);

CREATE TABLE IF NOT EXISTS hourly_ip_admissions (
  hour_bucket TIMESTAMPTZ NOT NULL,
  ip_hash TEXT NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hour_bucket, ip_hash)
);

CREATE INDEX IF NOT EXISTS hourly_ip_admissions_hour_bucket_idx
  ON hourly_ip_admissions (hour_bucket);

CREATE TABLE IF NOT EXISTS global_usage (
  scope TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO global_usage (scope, request_count)
VALUES ('lifetime', 0)
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS concurrency_leases (
  lease_id UUID PRIMARY KEY,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS concurrency_leases_expires_at_idx
  ON concurrency_leases (expires_at);
