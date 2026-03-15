// vaultStore.ts — Encrypted credential storage
// Lives in: src/main/vaultStore.ts
//
// SQLite database with AES-256-GCM encrypted credential fields.
// Master password required to unlock; derived key held in memory only.
//
// Lifecycle: init → unlock → operate → lock
//
// Depends on:
//   - vaultCrypto.ts (encryption primitives)
//   - better-sqlite3 (synchronous SQLite — npm install better-sqlite3)
//
// Storage location: <userData>/vault.db
//   Windows:  %APPDATA%/nterm-js/vault.db
//   macOS:    ~/Library/Application Support/nterm-js/vault.db
//   Linux:    ~/.config/nterm-js/vault.db

import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import Database from 'better-sqlite3';
import { app } from 'electron';

import {
    deriveKey,
    generateSalt,
    encrypt,
    decrypt,
    generateVerifyToken,
    verifyKey,
} from './vaultCrypto';

// ─── Types ───────────────────────────────────────────────────

export interface StoredCredential {
    id: number;
    name: string;
    username: string;

    /** Decrypted password (null if not decrypted or not set) */
    password: string | null;
    /** Decrypted SSH private key PEM content */
    sshKey: string | null;
    /** Decrypted SSH key passphrase */
    sshKeyPassphrase: string | null;

    /** Jump host hostname (cleartext — not sensitive) */
    jumpHost: string | null;
    jumpUsername: string | null;
    jumpAuthMethod: string;     // 'agent' | 'password' | 'key'
    jumpRequiresTouch: boolean;

    /** Glob patterns for host matching (e.g. '10.0.*', '*.lab.example.com') */
    matchHosts: string[];
    /** Tags for matching (e.g. 'production', 'cisco') */
    matchTags: string[];

    isDefault: boolean;
    createdAt: string | null;
    lastUsed: string | null;
}

/** Credential summary — metadata only, no decrypted secrets */
export interface CredentialSummary {
    id: number;
    name: string;
    username: string;
    hasPassword: boolean;
    hasSshKey: boolean;
    isDefault: boolean;
    createdAt: string | null;
    lastUsed: string | null;
}

/** Data for adding or updating a credential */
export interface CredentialInput {
    name: string;
    username: string;
    password?: string | null;
    sshKey?: string | null;
    sshKeyPassphrase?: string | null;
    jumpHost?: string | null;
    jumpUsername?: string | null;
    jumpAuthMethod?: string;
    jumpRequiresTouch?: boolean;
    matchHosts?: string[];
    matchTags?: string[];
    isDefault?: boolean;
}

// ─── Schema ──────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
    CREATE TABLE IF NOT EXISTS vault_meta (
        key   TEXT PRIMARY KEY,
        value BLOB
    );

    CREATE TABLE IF NOT EXISTS credentials (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        name                    TEXT UNIQUE NOT NULL,
        username                TEXT NOT NULL,
        password_enc            BLOB,
        ssh_key_enc             BLOB,
        ssh_key_passphrase_enc  BLOB,
        jump_host               TEXT,
        jump_username           TEXT,
        jump_auth_method        TEXT DEFAULT 'agent',
        jump_requires_touch     INTEGER DEFAULT 0,
        match_hosts             TEXT,
        match_tags              TEXT,
        is_default              INTEGER DEFAULT 0,
        created_at              TEXT,
        last_used               TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_credentials_name
        ON credentials(name);
    CREATE INDEX IF NOT EXISTS idx_credentials_default
        ON credentials(is_default);
`;

// ─── Vault Store ─────────────────────────────────────────────

export class VaultStore {
    readonly dbPath: string;

    private db: Database.Database | null = null;
    private key: Buffer | null = null;

    constructor(dbPath?: string) {
        if (dbPath) {
            this.dbPath = dbPath;
        } else {
            // Default: alongside electron-store config
            const userData = app.getPath('userData');
            this.dbPath = path.join(userData, 'vault.db');
        }
    }

    // ─── State ───────────────────────────────────────────────

    /** Check if vault database exists and has been initialized */
    get isInitialized(): boolean {
        if (!fs.existsSync(this.dbPath)) return false;

        // Open transiently to check for vault_meta table
        let db: Database.Database | null = null;
        try {
            db = new Database(this.dbPath, { readonly: true });
            const row = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='vault_meta'"
            ).get();
            return row !== undefined;
        } catch {
            return false;
        } finally {
            db?.close();
        }
    }

    /** Check if vault is currently unlocked (key in memory) */
    get isUnlocked(): boolean {
        return this.key !== null && this.db !== null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Initialize a new vault with a master password.
     *
     * Creates the database, generates salt, derives key, stores
     * a verification token, and creates the credentials table.
     *
     * @throws Error if vault is already initialized
     */
    initVault(password: string): void {
        if (this.isInitialized) {
            throw new Error('Vault already initialized');
        }

        // Ensure parent directory exists
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const salt = generateSalt();
        const key = deriveKey(password, salt);
        const { token, encrypted } = generateVerifyToken(key);

        const db = new Database(this.dbPath);
        try {
            db.exec(CREATE_TABLES);

            const insert = db.prepare(
                'INSERT INTO vault_meta (key, value) VALUES (?, ?)'
            );

            db.transaction(() => {
                insert.run('salt', salt);
                insert.run('verify_token', token);
                insert.run('verify_encrypted', encrypted);
                insert.run('version', Buffer.from(String(SCHEMA_VERSION)));
            })();
        } finally {
            db.close();
        }

        log.info(`Vault initialized at ${this.dbPath}`);
    }

    /**
     * Unlock the vault with a master password.
     *
     * Derives the key, verifies against stored token, and holds
     * the key + database connection in memory for operations.
     *
     * @returns true if password is correct and vault is now unlocked
     */
    unlock(password: string): boolean {
        if (!this.isInitialized) {
            throw new Error('Vault not initialized');
        }

        // If already unlocked, lock first (clean slate)
        if (this.isUnlocked) {
            this.lock();
        }

        let db: Database.Database | null = null;
        try {
            db = new Database(this.dbPath);

            // Retrieve salt and verification data
            const getMeta = db.prepare(
                'SELECT value FROM vault_meta WHERE key = ?'
            );

            const saltRow = getMeta.get('salt') as { value: Buffer } | undefined;
            const tokenRow = getMeta.get('verify_token') as { value: Buffer } | undefined;
            const encRow = getMeta.get('verify_encrypted') as { value: Buffer } | undefined;

            if (!saltRow || !tokenRow || !encRow) {
                log.error('Vault metadata incomplete');
                db.close();
                return false;
            }

            // Derive key and verify
            const key = deriveKey(password, saltRow.value);

            if (!verifyKey(key, encRow.value, tokenRow.value)) {
                log.warn('Vault unlock failed — invalid password');
                db.close();
                return false;
            }

            // Success — store key and keep DB open
            this.key = key;
            this.db = db;

            log.info('Vault unlocked');
            return true;

        } catch (err) {
            log.error('Vault unlock error:', err);
            db?.close();
            return false;
        }
    }

    /**
     * Lock the vault — clear key from memory and close database.
     */
    lock(): void {
        this.key = null;
        if (this.db) {
            try { this.db.close(); } catch { /* ignore */ }
            this.db = null;
        }
        log.info('Vault locked');
    }

    // ─── Internal Helpers ────────────────────────────────────

    /** Throw if vault is not unlocked */
    private requireUnlocked(): void {
        if (!this.isUnlocked) {
            throw new Error('Vault not unlocked');
        }
    }

    /** Encrypt a string field (returns null if input is null/undefined/empty) */
    private encryptField(value: string | null | undefined): Buffer | null {
        if (!value) return null;
        return encrypt(value, this.key!);
    }

    /** Decrypt a blob field (returns null if input is null) */
    private decryptField(value: Buffer | null): string | null {
        if (!value) return null;
        try {
            return decrypt(value, this.key!);
        } catch (err) {
            log.error('Field decryption failed:', err);
            return null;
        }
    }

    /** Parse a comma-separated string into an array */
    private parseList(value: string | null): string[] {
        if (!value) return [];
        return value.split(',').map(s => s.trim()).filter(Boolean);
    }

    /** Serialize an array to comma-separated string (null if empty) */
    private serializeList(values: string[] | null | undefined): string | null {
        if (!values || values.length === 0) return null;
        return values.join(',');
    }

    /** Convert a database row to a fully decrypted StoredCredential */
    private rowToCredential(row: any): StoredCredential {
        return {
            id: row.id,
            name: row.name,
            username: row.username,
            password: this.decryptField(row.password_enc),
            sshKey: this.decryptField(row.ssh_key_enc),
            sshKeyPassphrase: this.decryptField(row.ssh_key_passphrase_enc),
            jumpHost: row.jump_host,
            jumpUsername: row.jump_username,
            jumpAuthMethod: row.jump_auth_method || 'agent',
            jumpRequiresTouch: Boolean(row.jump_requires_touch),
            matchHosts: this.parseList(row.match_hosts),
            matchTags: this.parseList(row.match_tags),
            isDefault: Boolean(row.is_default),
            createdAt: row.created_at,
            lastUsed: row.last_used,
        };
    }

    // ─── CRUD ────────────────────────────────────────────────

    /**
     * Add a credential to the vault.
     *
     * @returns The new credential's database ID
     */
    addCredential(input: CredentialInput): number {
        this.requireUnlocked();

        // If setting as default, clear other defaults first
        if (input.isDefault) {
            this.db!.prepare('UPDATE credentials SET is_default = 0').run();
        }

        const result = this.db!.prepare(`
            INSERT INTO credentials (
                name, username,
                password_enc, ssh_key_enc, ssh_key_passphrase_enc,
                jump_host, jump_username, jump_auth_method, jump_requires_touch,
                match_hosts, match_tags, is_default, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            input.name,
            input.username,
            this.encryptField(input.password),
            this.encryptField(input.sshKey?.trim()),
            this.encryptField(input.sshKeyPassphrase),
            input.jumpHost || null,
            input.jumpUsername || null,
            input.jumpAuthMethod || 'agent',
            input.jumpRequiresTouch ? 1 : 0,
            this.serializeList(input.matchHosts),
            this.serializeList(input.matchTags),
            input.isDefault ? 1 : 0,
            new Date().toISOString(),
        );

        log.info(`Credential added: ${input.name}`);
        return Number(result.lastInsertRowid);
    }

    /**
     * Get a credential by name (with decrypted secrets).
     *
     * @returns StoredCredential or null if not found
     */
    getCredential(name: string): StoredCredential | null {
        this.requireUnlocked();

        const row = this.db!.prepare(
            'SELECT * FROM credentials WHERE name = ?'
        ).get(name);

        return row ? this.rowToCredential(row) : null;
    }

    /**
     * Get a credential by ID (with decrypted secrets).
     */
    getCredentialById(id: number): StoredCredential | null {
        this.requireUnlocked();

        const row = this.db!.prepare(
            'SELECT * FROM credentials WHERE id = ?'
        ).get(id);

        return row ? this.rowToCredential(row) : null;
    }

    /**
     * List all credentials — metadata only, no decrypted secrets.
     *
     * Safe to call for UI display. Works when unlocked (uses open DB)
     * but also opens a transient connection if needed for listing
     * while locked (e.g. showing "3 credentials" in status bar).
     */
    listCredentials(): CredentialSummary[] {
        const db = this.db || this.openTransient();
        const ownDb = db !== this.db;

        try {
            const rows = db.prepare(`
                SELECT id, name, username,
                       password_enc IS NOT NULL as has_password,
                       ssh_key_enc IS NOT NULL as has_ssh_key,
                       is_default, created_at, last_used
                FROM credentials
                ORDER BY name
            `).all();

            return rows.map((row: any) => ({
                id: row.id,
                name: row.name,
                username: row.username,
                hasPassword: Boolean(row.has_password),
                hasSshKey: Boolean(row.has_ssh_key),
                isDefault: Boolean(row.is_default),
                createdAt: row.created_at,
                lastUsed: row.last_used,
            }));
        } finally {
            if (ownDb) db.close();
        }
    }

    /**
     * List all credentials with decrypted secrets.
     * Used by the resolver for pattern matching.
     */
    listCredentialsFull(): StoredCredential[] {
        this.requireUnlocked();

        const rows = this.db!.prepare(
            'SELECT * FROM credentials ORDER BY name'
        ).all();

        return rows.map((row: any) => this.rowToCredential(row));
    }

    /**
     * Get the default credential (with decrypted secrets).
     */
    getDefault(): StoredCredential | null {
        this.requireUnlocked();

        const row = this.db!.prepare(
            'SELECT * FROM credentials WHERE is_default = 1'
        ).get();

        return row ? this.rowToCredential(row) : null;
    }

    /**
     * Update an existing credential.
     *
     * Only provided fields are updated — omitted fields are unchanged.
     * To clear a field, pass null explicitly.
     *
     * @returns true if the credential was found and updated
     */
    updateCredential(name: string, updates: Partial<CredentialInput>): boolean {
        this.requireUnlocked();

        // Build dynamic SET clause
        const setClauses: string[] = [];
        const values: any[] = [];

        if ('username' in updates) {
            setClauses.push('username = ?');
            values.push(updates.username);
        }
        if ('password' in updates) {
            setClauses.push('password_enc = ?');
            values.push(this.encryptField(updates.password));
        }
        if ('sshKey' in updates) {
            setClauses.push('ssh_key_enc = ?');
            values.push(this.encryptField(updates.sshKey?.trim()));
        }
        if ('sshKeyPassphrase' in updates) {
            setClauses.push('ssh_key_passphrase_enc = ?');
            values.push(this.encryptField(updates.sshKeyPassphrase));
        }
        if ('jumpHost' in updates) {
            setClauses.push('jump_host = ?');
            values.push(updates.jumpHost || null);
        }
        if ('jumpUsername' in updates) {
            setClauses.push('jump_username = ?');
            values.push(updates.jumpUsername || null);
        }
        if ('jumpAuthMethod' in updates) {
            setClauses.push('jump_auth_method = ?');
            values.push(updates.jumpAuthMethod);
        }
        if ('jumpRequiresTouch' in updates) {
            setClauses.push('jump_requires_touch = ?');
            values.push(updates.jumpRequiresTouch ? 1 : 0);
        }
        if ('matchHosts' in updates) {
            setClauses.push('match_hosts = ?');
            values.push(this.serializeList(updates.matchHosts));
        }
        if ('matchTags' in updates) {
            setClauses.push('match_tags = ?');
            values.push(this.serializeList(updates.matchTags));
        }
        if ('isDefault' in updates) {
            if (updates.isDefault) {
                this.db!.prepare('UPDATE credentials SET is_default = 0').run();
            }
            setClauses.push('is_default = ?');
            values.push(updates.isDefault ? 1 : 0);
        }

        if (setClauses.length === 0) return true; // nothing to update

        values.push(name); // WHERE name = ?

        const result = this.db!.prepare(
            `UPDATE credentials SET ${setClauses.join(', ')} WHERE name = ?`
        ).run(...values);

        return result.changes > 0;
    }

    /**
     * Remove a credential by name.
     *
     * @returns true if a credential was removed
     */
    removeCredential(name: string): boolean {
        const db = this.db || this.openTransient();
        const ownDb = db !== this.db;

        try {
            const result = db.prepare(
                'DELETE FROM credentials WHERE name = ?'
            ).run(name);
            return result.changes > 0;
        } finally {
            if (ownDb) db.close();
        }
    }

    /**
     * Set a credential as the default.
     *
     * Clears the default flag on all other credentials first.
     *
     * @returns true if the credential was found
     */
    setDefault(name: string): boolean {
        const db = this.db || this.openTransient();
        const ownDb = db !== this.db;

        try {
            return db.transaction(() => {
                db.prepare('UPDATE credentials SET is_default = 0').run();
                const result = db.prepare(
                    'UPDATE credentials SET is_default = 1 WHERE name = ?'
                ).run(name);
                return result.changes > 0;
            })();
        } finally {
            if (ownDb) db.close();
        }
    }

    /**
     * Update the last_used timestamp for a credential.
     */
    updateLastUsed(name: string): void {
        const db = this.db || this.openTransient();
        const ownDb = db !== this.db;

        try {
            db.prepare(
                'UPDATE credentials SET last_used = ? WHERE name = ?'
            ).run(new Date().toISOString(), name);
        } finally {
            if (ownDb) db.close();
        }
    }

    // ─── Master Password Change ──────────────────────────────

    /**
     * Change the master password.
     *
     * Derives a new key, re-encrypts all credentials, and updates
     * the verification token. Requires the old password to verify.
     *
     * @returns true if successful
     */
    changeMasterPassword(oldPassword: string, newPassword: string): boolean {
        // Verify old password by unlocking
        if (!this.unlock(oldPassword)) {
            return false;
        }

        // Read all credentials with decrypted secrets
        const credentials = this.listCredentialsFull();

        // Derive new key
        const newSalt = generateSalt();
        const newKey = deriveKey(newPassword, newSalt);
        const { token: newToken, encrypted: newEncrypted } = generateVerifyToken(newKey);

        // Re-encrypt everything in a single transaction
        this.db!.transaction(() => {
            // Update vault metadata
            const updateMeta = this.db!.prepare(
                'UPDATE vault_meta SET value = ? WHERE key = ?'
            );
            updateMeta.run(newSalt, 'salt');
            updateMeta.run(newToken, 'verify_token');
            updateMeta.run(newEncrypted, 'verify_encrypted');

            // Re-encrypt all credential secrets
            const updateCred = this.db!.prepare(`
                UPDATE credentials
                SET password_enc = ?, ssh_key_enc = ?, ssh_key_passphrase_enc = ?
                WHERE name = ?
            `);

            for (const cred of credentials) {
                updateCred.run(
                    cred.password ? encrypt(cred.password, newKey) : null,
                    cred.sshKey ? encrypt(cred.sshKey, newKey) : null,
                    cred.sshKeyPassphrase ? encrypt(cred.sshKeyPassphrase, newKey) : null,
                    cred.name,
                );
            }
        })();

        // Update in-memory key
        this.key = newKey;

        log.info('Master password changed — all credentials re-encrypted');
        return true;
    }

    // ─── Utilities ───────────────────────────────────────────

    /** Open a transient read-only connection (for operations when locked) */
    private openTransient(): Database.Database {
        return new Database(this.dbPath, { readonly: true });
    }

    /** Get the count of stored credentials */
    get credentialCount(): number {
        if (!this.isInitialized) return 0;

        const db = this.db || this.openTransient();
        const ownDb = db !== this.db;

        try {
            const row = db.prepare(
                'SELECT COUNT(*) as count FROM credentials'
            ).get() as { count: number };
            return row.count;
        } catch {
            return 0;
        } finally {
            if (ownDb) db.close();
        }
    }
}
