// vaultCrypto.ts — Encryption primitives for the credential vault
// Lives in: src/main/vaultCrypto.ts
//
// Standalone module — no dependencies on other vault modules.
// Uses Node.js crypto (always available in Electron main process).
//
// Encryption: AES-256-GCM (authenticated encryption)
// Key derivation: PBKDF2-HMAC-SHA256 (480,000 iterations)
//
// Packed ciphertext format:
//   [IV (12 bytes)] [AuthTag (16 bytes)] [Ciphertext (variable)]
//
// Why AES-256-GCM over Fernet:
//   - 256-bit key vs Fernet's 128-bit
//   - GCM is authenticated encryption (integrity + confidentiality)
//   - Zero dependencies — Node.js crypto is always available
//   - No cross-platform vault sharing needed (nterm-js is standalone)

import crypto from 'crypto';

// ─── Constants ───────────────────────────────────────────────

/** PBKDF2 iterations — OWASP 2023 recommendation range for SHA-256 */
export const PBKDF2_ITERATIONS = 480_000;

/** Derived key length in bytes (256 bits for AES-256) */
const KEY_LENGTH = 32;

/** GCM initialization vector length in bytes */
const IV_LENGTH = 12;

/** GCM authentication tag length in bytes */
const AUTH_TAG_LENGTH = 16;

/** Salt length in bytes (128 bits) */
export const SALT_LENGTH = 16;

/** Verification token length in bytes */
export const VERIFY_TOKEN_LENGTH = 32;

// ─── Key Derivation ──────────────────────────────────────────

/**
 * Derive an AES-256 key from a master password and salt.
 *
 * Uses PBKDF2-HMAC-SHA256 with 480,000 iterations.
 * This is deliberately slow — ~200ms on modern hardware —
 * to make brute-force attacks impractical.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(
        password,
        salt,
        PBKDF2_ITERATIONS,
        KEY_LENGTH,
        'sha256',
    );
}

/**
 * Generate a cryptographically random salt for key derivation.
 */
export function generateSalt(): Buffer {
    return crypto.randomBytes(SALT_LENGTH);
}

// ─── Encrypt / Decrypt ───────────────────────────────────────

/**
 * Encrypt a UTF-8 string with AES-256-GCM.
 *
 * Returns a packed Buffer: [IV (12)] [AuthTag (16)] [Ciphertext (...)]
 *
 * Each call generates a fresh random IV, so encrypting the same
 * plaintext twice produces different ciphertext.
 *
 * @param plaintext - UTF-8 string to encrypt
 * @param key - 32-byte key from deriveKey()
 * @returns Packed ciphertext buffer
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: [IV] [AuthTag] [Ciphertext]
    return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Decrypt a packed AES-256-GCM ciphertext buffer to a UTF-8 string.
 *
 * @param packed - Buffer from encrypt(): [IV (12)] [AuthTag (16)] [Ciphertext (...)]
 * @param key - 32-byte key from deriveKey()
 * @returns Decrypted UTF-8 string
 * @throws Error if decryption fails (wrong key, corrupted data, tampered ciphertext)
 */
export function decrypt(packed: Buffer, key: Buffer): string {
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Ciphertext too short');
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    try {
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');
    } catch (err) {
        throw new Error('Decryption failed — wrong key or corrupted data');
    }
}

// ─── Verification Token ──────────────────────────────────────
//
// On vault init, we generate random bytes, encrypt them, and store both
// the plaintext and ciphertext in vault_meta. On unlock, we decrypt the
// ciphertext and compare to the stored plaintext. This verifies the
// master password without storing it.

/**
 * Generate a verification token pair for password verification.
 *
 * @param key - 32-byte key from deriveKey()
 * @returns { token: plaintext bytes, encrypted: packed ciphertext }
 */
export function generateVerifyToken(key: Buffer): { token: Buffer; encrypted: Buffer } {
    const token = crypto.randomBytes(VERIFY_TOKEN_LENGTH);
    const encrypted = encrypt(token.toString('hex'), key);
    return { token, encrypted };
}

/**
 * Verify a master password by decrypting the stored verification token
 * and comparing it to the stored plaintext.
 *
 * @param key - 32-byte key derived from the candidate password
 * @param encrypted - Stored encrypted verification token
 * @param token - Stored plaintext verification token
 * @returns true if the password is correct
 */
export function verifyKey(key: Buffer, encrypted: Buffer, token: Buffer): boolean {
    try {
        const decrypted = decrypt(encrypted, key);
        return decrypted === token.toString('hex');
    } catch {
        return false;
    }
}
