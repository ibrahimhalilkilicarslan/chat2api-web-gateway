import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { GatewayDatabase } from './database.js'

describe('GatewayDatabase migrations', () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades a version-one API key table without losing existing rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2api-migration-'))
    directories.push(directory)
    const path = join(directory, 'gateway.sqlite')
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);
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
      INSERT INTO api_keys(
        id, name, key_hash, key_prefix, scopes_json, model_allowlist_json,
        requests_per_minute, daily_quota, created_at
      ) VALUES (
        'legacy-key', 'Legacy', 'hash', 'c2a_legacy', '["models"]', '[]',
        10, 100, 1
      );
    `)
    legacy.close()

    const migrated = new GatewayDatabase(path)
    expect(migrated.getMaintenanceStatus()).toMatchObject({
      integrity: 'ok',
      schemaVersion: 3,
    })
    const columns = migrated.connection
      .prepare('PRAGMA table_info(api_keys)')
      .all()
      .map((column) => (column as { name: string }).name)
    expect(columns).toEqual(expect.arrayContaining([
      'expires_at',
      'allowed_cidrs_json',
      'rotated_from_id',
      'replaced_by_id',
    ]))
    expect(migrated.connection.prepare(`
      SELECT id, allowed_cidrs_json AS allowedCidrs
      FROM api_keys
      WHERE id = 'legacy-key'
    `).get()).toEqual({
      id: 'legacy-key',
      allowedCidrs: '[]',
    })
    migrated.close()

    const reopened = new GatewayDatabase(path)
    expect(reopened.getMaintenanceStatus().schemaVersion).toBe(3)
    reopened.close()
  })
})
