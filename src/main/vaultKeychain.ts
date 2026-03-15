// vaultKeychain.ts — Master password caching via Electron safeStorage
// Lives in: src/main/vaultKeychain.ts
//
// Caches the vault master password in the OS credential store:
//   macOS:   Keychain
//   Windows: DPAPI (Data Protection API)
//   Linux:   libsecret (GNOME Keyring / KWallet)
//
// This does NOT replace vault encryption — it only caches the
// master password so users don't type it every session. The actual
// credential secrets are still AES-256-GCM encrypted in vault.db.
//
// Equivalent of Python keychain.py, but using Electron's built-in
// safeStorage API instead of the `keyring` pip package.

import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import { app, safeStorage } from 'electron';

// ─── Constants ───────────────────────────────────────────────

/** Filename for the encrypted master password blob */
const KEYCHAIN_FILE = 'vault-keychain.bin';

// ─── Keychain Integration ────────────────────────────────────

/**
 * Check if the OS credential store is available.
 *
 * Returns false on headless Linux without a secret service,
 * or if Electron's safeStorage is otherwise unavailable.
 */
export function isKeychainAvailable(): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

/**
 * Get the path to the keychain file.
 * Stored alongside other nterm-js config in userData.
 */
function getKeychainPath(): string {
    return path.join(app.getPath('userData'), KEYCHAIN_FILE);
}

/**
 * Store the vault master password in the OS credential store.
 *
 * The password is encrypted by Electron's safeStorage (OS-backed)
 * and written to a local file. Only the current OS user can decrypt it.
 *
 * @param password - The vault master password to cache
 * @returns true if stored successfully
 */
export function storeMasterPassword(password: string): boolean {
    if (!isKeychainAvailable()) {
        log.warn('Keychain not available — cannot store master password');
        return false;
    }

    try {
        const encrypted = safeStorage.encryptString(password);
        fs.writeFileSync(getKeychainPath(), encrypted);
        log.info('Master password stored in system keychain');
        return true;
    } catch (err) {
        log.error('Failed to store password in keychain:', err);
        return false;
    }
}

/**
 * Retrieve the cached master password from the OS credential store.
 *
 * @returns The password if found and decryptable, null otherwise
 */
export function getMasterPassword(): string | null {
    const keychainPath = getKeychainPath();

    if (!fs.existsSync(keychainPath)) {
        return null;
    }

    if (!isKeychainAvailable()) {
        return null;
    }

    try {
        const encrypted = fs.readFileSync(keychainPath);
        const password = safeStorage.decryptString(encrypted);
        log.debug('Retrieved master password from keychain');
        return password;
    } catch (err) {
        log.debug('Failed to read password from keychain:', err);
        return null;
    }
}

/**
 * Remove the cached master password from the OS credential store.
 *
 * @returns true if removed (or wasn't present)
 */
export function clearMasterPassword(): boolean {
    const keychainPath = getKeychainPath();

    try {
        if (fs.existsSync(keychainPath)) {
            fs.unlinkSync(keychainPath);
            log.info('Master password removed from keychain');
        }
        return true;
    } catch (err) {
        log.error('Failed to clear keychain:', err);
        return false;
    }
}

/**
 * Check if a master password is currently cached.
 */
export function hasStoredPassword(): boolean {
    return fs.existsSync(getKeychainPath());
}
