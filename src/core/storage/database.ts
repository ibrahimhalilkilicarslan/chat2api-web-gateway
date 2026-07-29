import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

export class GatewayDatabase {
  readonly connection: BetterSqlite3.Database

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }

    this.connection = new BetterSqlite3(path)
    this.connection.pragma('foreign_keys = ON')
    this.connection.pragma('busy_timeout = 5000')
    this.connection.pragma('synchronous = NORMAL')
    if (path !== ':memory:') {
      this.connection.pragma('journal_mode = WAL')
      chmodSync(path, 0o600)
    }
    this.migrate()
  }

  close(): void {
    this.connection.close()
  }

  assertReady(): void {
    const row = this.connection.prepare('SELECT 1 AS ready').get() as { ready: number } | undefined
    if (row?.ready !== 1) {
      throw new Error('SQLite readiness check failed')
    }
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)

    const current = this.connection
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number }

    if (current.version < 1) {
      this.connection.transaction(() => {
        this.connection.exec(`
          CREATE TABLE providers (
            id TEXT PRIMARY KEY,
            data_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE accounts (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            email TEXT,
            status TEXT NOT NULL,
            encrypted_credentials TEXT NOT NULL,
            last_used INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            error_message TEXT,
            request_count INTEGER NOT NULL DEFAULT 0,
            daily_limit INTEGER,
            today_used INTEGER NOT NULL DEFAULT 0,
            usage_date TEXT NOT NULL
          );
          CREATE INDEX idx_accounts_provider ON accounts(provider_id);

          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            account_id TEXT NOT NULL,
            data_json TEXT NOT NULL,
            status TEXT NOT NULL,
            last_active_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX idx_sessions_account ON sessions(account_id);
          CREATE INDEX idx_sessions_provider ON sessions(provider_id);

          CREATE TABLE api_keys (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            key_hash TEXT NOT NULL UNIQUE,
            key_prefix TEXT NOT NULL,
            scopes_json TEXT NOT NULL,
            model_allowlist_json TEXT NOT NULL,
            requests_per_minute INTEGER NOT NULL,
            daily_quota INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            usage_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER
          );

          CREATE TABLE api_key_daily_usage (
            api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
            usage_date TEXT NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (api_key_id, usage_date)
          );

          CREATE TABLE request_logs (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            timestamp INTEGER NOT NULL,
            completed_at INTEGER,
            status TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            method TEXT NOT NULL,
            url TEXT NOT NULL,
            model TEXT NOT NULL,
            actual_model TEXT,
            provider_id TEXT,
            account_id TEXT,
            api_key_id TEXT,
            latency INTEGER NOT NULL DEFAULT 0,
            is_stream INTEGER NOT NULL,
            error_code TEXT
          );
          CREATE INDEX idx_request_logs_timestamp ON request_logs(timestamp DESC);

          CREATE TABLE audit_logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            outcome TEXT NOT NULL,
            metadata_json TEXT NOT NULL
          );
          CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp DESC);
        `)
        this.connection
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(1, Date.now())
      })()
    }
  }
}
