CREATE TABLE auth_state (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX auth_state_expiry ON auth_state(expires_at);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
