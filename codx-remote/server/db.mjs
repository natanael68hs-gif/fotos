import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized:false } : undefined,
  max: 10
});

export async function q(text, params=[]) {
  return pool.query(text, params);
}

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password_salt TEXT,
      password_hash TEXT,
      account_secret_hash TEXT UNIQUE NOT NULL,
      mcp_key_hash TEXT UNIQUE NOT NULL,
      mcp_key TEXT NOT NULL,
      manage_key_hash TEXT UNIQUE NOT NULL,
      manage_key TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'Free',
      monthly_limit INTEGER NOT NULL DEFAULT 500,
      monthly_tool_calls INTEGER NOT NULL DEFAULT 0,
      usage_month TEXT,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      disconnect_requested BOOLEAN NOT NULL DEFAULT FALSE,
      tool_calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      dispatched_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id,status,created_at);

    CREATE TABLE IF NOT EXISTS results (
      command_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      output TEXT,
      error TEXT,
      duration_ms INTEGER,
      finished_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS setup_tokens (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      device_id TEXT,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      redirect_uris_json TEXT NOT NULL,
      client_name TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_access (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);
}
