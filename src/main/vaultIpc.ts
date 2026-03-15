// vaultIpc.ts — IPC handlers for the credential vault
// Lives in: src/main/vaultIpc.ts
//
// Registers vault:* IPC channels and wires the vault store, resolver,
// and keychain into the Electron main process. Called once from main.ts
// at startup via registerVaultIpc().
//
// Security model:
//   - Decrypted secrets NEVER cross IPC to the renderer
//   - The renderer sees credential names, usernames, auth types
//   - Actual passwords/keys are injected server-side into SSH configs
//   - Keychain stores the master password (not the derived key)

import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log';

import { VaultStore, CredentialSummary, CredentialInput } from './vaultStore';
import { VaultResolver, CredentialMatch, ResolvedCredential } from './vaultResolver';
import {
    isKeychainAvailable,
    storeMasterPassword,
    getMasterPassword,
    clearMasterPassword,
    hasStoredPassword,
} from './vaultKeychain';

// ─── Module State ────────────────────────────────────────────

let vaultStore: VaultStore;
let vaultResolver: VaultResolver;

// ─── Public API for main.ts ──────────────────────────────────

/**
 * Initialize and register all vault IPC handlers.
 *
 * Call once from main.ts after app.whenReady():
 *
 *   import { registerVaultIpc, getVaultResolver } from './vaultIpc';
 *   app.whenReady().then(() => {
 *       registerVaultIpc();
 *       createWindow();
 *   });
 */
export function registerVaultIpc(dbPath?: string): void {
    vaultStore = new VaultStore(dbPath);
    vaultResolver = new VaultResolver(vaultStore);

    registerStatusHandlers();
    registerLifecycleHandlers();
    registerCredentialHandlers();
    registerKeychainHandlers();

    log.info(`Vault IPC registered — db: ${vaultStore.dbPath}`);
}

/**
 * Get the vault resolver for credential injection at connect time.
 *
 * Used by the ssh:connect handler in main.ts to inject credentials:
 *
 *   const resolved = getVaultResolver().resolveByName(config.credentialName);
 *   if (resolved) {
 *       config.username = resolved.username;
 *       config.password = resolved.password;
 *   }
 */
export function getVaultResolver(): VaultResolver {
    return vaultResolver;
}

/**
 * Get the vault store directly (for lock-on-close, etc.)
 */
export function getVaultStore(): VaultStore {
    return vaultStore;
}

/**
 * Attempt auto-unlock from system keychain.
 *
 * Call from main.ts after registerVaultIpc() and window creation.
 * If successful, sends 'vault:state-changed' to the renderer.
 */
export function tryAutoUnlock(win: BrowserWindow | null): boolean {
    if (!vaultStore.isInitialized) return false;
    if (vaultStore.isUnlocked) return true;

    const cachedPassword = getMasterPassword();
    if (!cachedPassword) return false;

    if (vaultStore.unlock(cachedPassword)) {
        log.info('Vault auto-unlocked from keychain');
        if (win) {
            win.webContents.send('vault:state-changed', {
                initialized: true,
                unlocked: true,
                credentialCount: vaultStore.credentialCount,
            });
        }
        return true;
    }

    // Cached password is stale — clear it
    log.warn('Keychain password stale — clearing');
    clearMasterPassword();
    return false;
}

// ─── IPC: Vault Status ──────────────────────────────────────

function registerStatusHandlers(): void {

    ipcMain.handle('vault:status', async () => {
        return {
            initialized: vaultStore.isInitialized,
            unlocked: vaultStore.isUnlocked,
            credentialCount: vaultStore.isUnlocked ? vaultStore.credentialCount : 0,
            keychainAvailable: isKeychainAvailable(),
            keychainHasPassword: hasStoredPassword(),
        };
    });

    ipcMain.handle('vault:db-path', async () => {
        return vaultStore.dbPath;
    });
}

// ─── IPC: Vault Lifecycle ───────────────────────────────────

function registerLifecycleHandlers(): void {

    ipcMain.handle('vault:init', async (_event, { password }: { password: string }) => {
        try {
            vaultStore.initVault(password);
            const unlocked = vaultStore.unlock(password);

            if (unlocked) {
                notifyStateChanged();
            }

            return { success: unlocked };
        } catch (err: any) {
            log.error('Vault init failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('vault:unlock', async (_event, { password, remember }: { password: string; remember?: boolean }) => {
        try {
            const success = vaultStore.unlock(password);

            if (success) {
                if (remember && isKeychainAvailable()) {
                    storeMasterPassword(password);
                }
                notifyStateChanged();
            }

            return {
                success,
                credentialCount: success ? vaultStore.credentialCount : 0,
            };
        } catch (err: any) {
            log.error('Vault unlock failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('vault:lock', async () => {
        vaultStore.lock();
        notifyStateChanged();
        return { success: true };
    });

    ipcMain.handle('vault:change-password', async (
        _event,
        { oldPassword, newPassword, remember }: { oldPassword: string; newPassword: string; remember?: boolean }
    ) => {
        try {
            const success = vaultStore.changeMasterPassword(oldPassword, newPassword);

            if (success && remember && isKeychainAvailable()) {
                storeMasterPassword(newPassword);
            }

            return { success };
        } catch (err: any) {
            log.error('Password change failed:', err);
            return { success: false, error: err.message };
        }
    });
}

// ─── IPC: Credential CRUD ───────────────────────────────────

function registerCredentialHandlers(): void {

    ipcMain.handle('vault:list', async () => {
        try {
            return { credentials: vaultStore.listCredentials() };
        } catch (err: any) {
            return { credentials: [], error: err.message };
        }
    });

    ipcMain.handle('vault:add', async (_event, { credential }: { credential: CredentialInput }) => {
        try {
            const id = vaultStore.addCredential(credential);
            return { success: true, id };
        } catch (err: any) {
            log.error('Add credential failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('vault:update', async (
        _event,
        { name, updates }: { name: string; updates: Partial<CredentialInput> }
    ) => {
        try {
            const success = vaultStore.updateCredential(name, updates);
            return { success };
        } catch (err: any) {
            log.error('Update credential failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('vault:remove', async (_event, { name }: { name: string }) => {
        try {
            const success = vaultStore.removeCredential(name);
            return { success };
        } catch (err: any) {
            log.error('Remove credential failed:', err);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('vault:set-default', async (_event, { name }: { name: string }) => {
        try {
            const success = vaultStore.setDefault(name);
            return { success };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // Match credential for a host — returns metadata only, no secrets
    ipcMain.handle('vault:match', async (
        _event,
        { host, port, tags }: { host: string; port?: number; tags?: string[] }
    ) => {
        return vaultResolver.matchForHost(host, port || 22, tags || []);
    });
}

// ─── IPC: Keychain ──────────────────────────────────────────

function registerKeychainHandlers(): void {

    ipcMain.handle('vault:keychain-clear', async () => {
        const success = clearMasterPassword();
        return { success };
    });
}

// ─── Credential Injection ───────────────────────────────────

/**
 * Enrich an SSH connect config with vault-resolved credentials.
 *
 * Call from the ssh:connect handler in main.ts BEFORE passing
 * the config to SSHManager. Secrets are injected server-side —
 * they never cross IPC.
 *
 * Resolution priority (matches Python vault_connect.py):
 *   1. Explicit credentialName → resolve by name
 *   2. useVault flag + hostname → pattern-match
 *   3. Neither → pass through unchanged
 *
 * Usage in main.ts:
 *   import { enrichSshConfig } from './vaultIpc';
 *
 *   ipcMain.handle('ssh:connect', async (event, { sessionId, config }) => {
 *       config = enrichSshConfig(config);  // inject vault creds
 *       const manager = new SSHManager(mainWindow, sessionId, sessionId);
 *       manager.connectToHost(config);
 *       ...
 *   });
 */
export function enrichSshConfig(config: any): any {
    if (!vaultStore.isUnlocked) return config;

    const credentialName: string | undefined = config.credentialName;
    const useVault: boolean = config.useVault === true;

    // Already has explicit credentials and no vault override — pass through
    const hasPassword = Boolean(config.password);
    const hasKey = Boolean(config.privateKey || config.keyPath);
    if ((hasPassword || hasKey) && !credentialName) {
        return config;
    }

    let resolved: ResolvedCredential | null = null;

    try {
        if (credentialName) {
            // Explicit credential name from connect dialog dropdown
            resolved = vaultResolver.resolveByName(credentialName);
            if (resolved) {
                log.info(`Vault: injected credential '${credentialName}' for ${config.host}`);
            }
        } else if (useVault) {
            // Pattern-match from vault
            resolved = vaultResolver.resolveForHost(config.host, config.port || 22);
            if (resolved) {
                log.info(`Vault: matched credential for ${config.host}`);
            }
        }
    } catch (err) {
        log.error(`Vault credential resolution failed for ${config.host}:`, err);
        return config;
    }

    if (!resolved) return config;

    // Inject resolved credentials — secrets stay in main process
    const enriched = { ...config };
    enriched.username = resolved.username;

    if (resolved.sshKey) {
        enriched.privateKey = resolved.sshKey;
        enriched.passphrase = resolved.sshKeyPassphrase || undefined;
    }
    if (resolved.password) {
        enriched.password = resolved.password;
    }

    // Tag that credentials came from vault (for status display in renderer)
    enriched._vaultResolved = true;
    enriched._credentialName = credentialName || 'auto-matched';

    return enriched;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Notify renderer of vault state change */
function notifyStateChanged(): void {
    const windows = BrowserWindow.getAllWindows();
    const state = {
        initialized: vaultStore.isInitialized,
        unlocked: vaultStore.isUnlocked,
        credentialCount: vaultStore.isUnlocked ? vaultStore.credentialCount : 0,
    };

    for (const win of windows) {
        win.webContents.send('vault:state-changed', state);
    }
}