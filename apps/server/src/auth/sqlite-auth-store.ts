import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AuthError } from './core.js';
import type { AuthStore } from './service.js';

/** Accounts control access only. All local study stores still use one learner. */
export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: DatabaseSync) {}

  async register(username: string, passwordHash: string, firstOwner: string, allowOpen: boolean, now: Date): Promise<string> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const exists = Boolean(this.db.prepare('SELECT 1 FROM accounts LIMIT 1').get());
      if (exists && !allowOpen) throw new AuthError(403, 'Sign-up is closed');
      if (this.db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username)) {
        throw new AuthError(409, 'Username is already taken');
      }
      const ownerId = exists ? randomUUID() : firstOwner;
      this.db.prepare('INSERT INTO accounts(owner_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(ownerId, username, passwordHash, now.toISOString());
      this.db.exec('COMMIT');
      return ownerId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async loginLookup(username: string, now: Date): Promise<{ ownerId: string; passwordHash: string; locked: boolean } | null> {
    const row = this.db.prepare('SELECT owner_id, password_hash, locked_until FROM accounts WHERE username = ?').get(username);
    return row ? { ownerId: String(row.owner_id), passwordHash: String(row.password_hash),
      locked: typeof row.locked_until === 'string' && row.locked_until > now.toISOString() } : null;
  }

  async loginResult(ownerId: string, success: boolean, now: Date): Promise<void> {
    if (success) {
      this.db.prepare(`UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ?
        WHERE owner_id = ? AND (locked_until IS NULL OR locked_until <= ?)`)
        .run(now.toISOString(), ownerId, now.toISOString());
    } else {
      this.db.prepare(`UPDATE accounts SET
        locked_until = CASE WHEN failed_logins + 1 >= 10 THEN ? ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= 10 THEN 0 ELSE failed_logins + 1 END
        WHERE owner_id = ? AND (locked_until IS NULL OR locked_until <= ?)`)
        .run(new Date(now.getTime() + 15 * 60_000).toISOString(), ownerId, now.toISOString());
    }
  }

  async createSession(tokenHash: string, ownerId: string, now: Date, expires: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
        SELECT token_hash FROM auth_sessions WHERE owner_id = ?
        AND (expires_at < ? OR revoked_at < ?) ORDER BY created_at LIMIT 100
      )`).run(ownerId, cutoff, cutoff);
      this.db.prepare('INSERT INTO auth_sessions(token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(tokenHash, ownerId, now.toISOString(), expires.toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async sessionOwner(tokenHash: string, now: Date): Promise<{ ownerId: string; username: string } | null> {
    const row = this.db.prepare(`SELECT a.owner_id, a.username FROM auth_sessions AS s
      JOIN accounts AS a ON a.owner_id = s.owner_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash, now.toISOString());
    return row ? { ownerId: String(row.owner_id), username: String(row.username) } : null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    this.db.prepare('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?')
      .run(now.toISOString(), tokenHash);
  }

  async signupOpen(allowOpen: boolean): Promise<boolean> {
    return allowOpen || !this.db.prepare('SELECT 1 FROM accounts LIMIT 1').get();
  }
}
