import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';

/** An account holder invited by the owner. `id` is their AimHarder account ID. */
export interface Member { id: number; label: string; generation: string; createdAt: string }
export interface Invitation { id: string; label: string; expiresAt: string }
export interface Credentials { username: string; password: string }

const invitationDays = 7;
const now = () => new Date().toISOString();

/**
 * Durable state of the remote server in one SQLite file: invited members, pending invitations and settings.
 *
 * Member passwords are encrypted with AES-256-GCM under a key derived from MCP_OWNER_SECRET, so the file alone does not
 * reveal them. Invitation links are stored only as SHA-256 digests. A member's `generation` is part of every token
 * issued to them: removing the member, or inviting them again, invalidates older tokens.
 */
export class Store {
  readonly #db: DatabaseSync;

  constructor(directory: string, private readonly credentialsKey: Buffer) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(directory, 'aimharder-mcp.sqlite'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const version = (this.#db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version === 0) {
      this.#db.exec(`
        CREATE TABLE members (id INTEGER PRIMARY KEY, label TEXT NOT NULL, credentials TEXT NOT NULL, generation TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE invitations (id TEXT PRIMARY KEY, label TEXT NOT NULL, expires_at TEXT NOT NULL);
        CREATE TABLE settings (scope TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
        PRAGMA user_version = 2;`);
    } else if (version === 1) {
      // Version 2 changed the booking plan, friends and participant filter formats: personal settings start over.
      this.#db.exec("DELETE FROM settings WHERE scope <> 'gym'; PRAGMA user_version = 2;");
    } else if (version !== 2) {
      throw new Error('Unsupported data file version');
    }
  }

  close() { this.#db.close(); }

  members(): Member[] {
    return (this.#db.prepare('SELECT id, label, generation, created_at FROM members ORDER BY created_at').all() as unknown as MemberRow[]).map(member);
  }

  member(id: number): Member | undefined {
    const row = this.#db.prepare('SELECT id, label, generation, created_at FROM members WHERE id = ?').get(id) as MemberRow | undefined;
    return row && member(row);
  }

  /** The member's AimHarder credentials, or undefined when the member is gone or the key changed. */
  credentials(id: number): Credentials | undefined {
    const row = this.#db.prepare('SELECT credentials FROM members WHERE id = ?').get(id) as { credentials: string } | undefined;
    if (!row) return undefined;
    try {
      const [iv, tag, data] = row.credentials.split('.').map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', this.credentialsKey, iv!);
      decipher.setAuthTag(tag!);
      const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const { username, password } = parsed as Record<string, unknown>;
      return typeof username === 'string' && typeof password === 'string' ? { username, password } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Add a member, or replace one with a new generation (revoking their older tokens). */
  addMember(id: number, label: string, credentials: Credentials): Member {
    this.#db.prepare('INSERT OR REPLACE INTO members (id, label, credentials, generation, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, label, this.#encrypt(credentials), randomBytes(12).toString('base64url'), now());
    return this.member(id)!;
  }

  updateCredentials(id: number, credentials: Credentials) {
    this.#db.prepare('UPDATE members SET credentials = ? WHERE id = ?').run(this.#encrypt(credentials), id);
  }

  removeMember(id: number) {
    this.#db.prepare('DELETE FROM members WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM settings WHERE scope = ?').run(memberScope(id));
  }

  /** Create a single-use invitation link token, valid for seven days. Only its digest is stored. */
  createInvitation(label: string) {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + invitationDays * 86_400_000).toISOString();
    this.#db.prepare('INSERT INTO invitations (id, label, expires_at) VALUES (?, ?, ?)').run(digest(token), label, expiresAt);
    return { token, expiresAt };
  }

  /** Pending invitations that have not expired; expired ones are deleted. */
  invitations(): Invitation[] {
    this.#db.prepare('DELETE FROM invitations WHERE expires_at <= ?').run(now());
    return (this.#db.prepare('SELECT id, label, expires_at FROM invitations ORDER BY expires_at').all() as unknown as InvitationRow[]).map(invitation);
  }

  invitation(token: string): Invitation | undefined {
    const row = this.#db.prepare('SELECT id, label, expires_at FROM invitations WHERE id = ? AND expires_at > ?').get(digest(token), now()) as InvitationRow | undefined;
    return row && invitation(row);
  }

  /** Delete an invitation; true when it existed, so a link is used at most once. */
  deleteInvitation(id: string) {
    return Number(this.#db.prepare('DELETE FROM invitations WHERE id = ?').run(id).changes) > 0;
  }

  /** Stored settings for a scope, validated with the schema; empty when none were saved. */
  settings<T>(scope: string, schema: z.ZodType<T>, empty: T): T {
    const row = this.#db.prepare('SELECT value FROM settings WHERE scope = ?').get(scope) as { value: string } | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : empty;
  }

  saveSettings(scope: string, value: unknown) {
    this.#db.prepare('INSERT INTO settings (scope, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(scope, JSON.stringify(value), now());
  }

  #encrypt(credentials: Credentials) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.credentialsKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }
}

export const memberScope = (id: number) => `member:${id}`;

interface MemberRow { id: number; label: string; generation: string; created_at: string }
interface InvitationRow { id: string; label: string; expires_at: string }
const member = (row: MemberRow): Member => ({ id: Number(row.id), label: row.label, generation: row.generation, createdAt: row.created_at });
const invitation = (row: InvitationRow): Invitation => ({ id: row.id, label: row.label, expiresAt: row.expires_at });
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
