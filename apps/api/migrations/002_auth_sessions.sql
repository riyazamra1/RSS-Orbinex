BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  device_id UUID NOT NULL REFERENCES registered_devices(id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  CONSTRAINT auth_sessions_tenant_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS auth_sessions_active_lookup_idx
  ON auth_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_tenant_user_idx
  ON auth_sessions (tenant_id, user_id, created_at DESC);

COMMIT;
