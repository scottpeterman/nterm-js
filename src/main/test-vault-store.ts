// test-vault-store.ts — Validate credential store lifecycle
// Run with: npx ts-node src/main/test-vault-store.ts
//
// Requires: npm install better-sqlite3 electron-log
// Note: Mocks Electron's app module for testing outside Electron.

// Mock Electron's app module before any imports
const mockUserData = '/tmp/nterm-js-test-' + Date.now();
require('module')._cache = {};

// Intercept electron import
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
    if (id === 'electron') {
        return {
            app: {
                getPath: (name: string) => {
                    if (name === 'userData') return mockUserData;
                    return '/tmp';
                },
            },
            safeStorage: {
                isEncryptionAvailable: () => false,
                encryptString: () => Buffer.alloc(0),
                decryptString: () => '',
            },
        };
    }
    return originalRequire.apply(this, arguments);
};

import fs from 'fs';
import path from 'path';
import { VaultStore } from './vaultStore';

const TEST_DB = path.join(mockUserData, 'test-vault.db');

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message}`);
        failed++;
    }
}

function cleanup(): void {
    try {
        if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
        if (fs.existsSync(mockUserData)) fs.rmdirSync(mockUserData, { recursive: true } as any);
    } catch { /* ignore */ }
}

// ─── Setup ───────────────────────────────────────────────────

cleanup();
fs.mkdirSync(mockUserData, { recursive: true });

const PASSWORD = 'test-master-password-2024';
const WRONG_PASSWORD = 'wrong-password';

// ─── Test: Initialization ────────────────────────────────────

console.log('\n[Initialization]');

const store = new VaultStore(TEST_DB);

assert(!store.isInitialized, 'New store is not initialized');
assert(!store.isUnlocked, 'New store is not unlocked');

store.initVault(PASSWORD);
assert(store.isInitialized, 'Store is initialized after initVault');
assert(!store.isUnlocked, 'Store is still locked after initVault');

// Double init should throw
try {
    store.initVault(PASSWORD);
    assert(false, 'Double init should throw');
} catch (err: any) {
    assert(err.message.includes('already initialized'), 'Double init throws expected error');
}

// ─── Test: Unlock / Lock ─────────────────────────────────────

console.log('\n[Unlock / Lock]');

assert(!store.unlock(WRONG_PASSWORD), 'Wrong password returns false');
assert(!store.isUnlocked, 'Still locked after wrong password');

assert(store.unlock(PASSWORD), 'Correct password returns true');
assert(store.isUnlocked, 'Store is unlocked');

store.lock();
assert(!store.isUnlocked, 'Store is locked after lock()');

// Re-unlock
assert(store.unlock(PASSWORD), 'Can unlock again');

// ─── Test: Add Credential ────────────────────────────────────

console.log('\n[Add Credential]');

const credId = store.addCredential({
    name: 'lab-switches',
    username: 'admin',
    password: 'cisco123',
    matchHosts: ['10.0.*', '192.168.1.*'],
    matchTags: ['lab', 'cisco'],
    isDefault: false,
});

assert(credId > 0, `Credential added with id ${credId}`);

const credId2 = store.addCredential({
    name: 'prod-routers',
    username: 'netops',
    password: 'secure-pw',
    sshKey: '-----BEGIN RSA PRIVATE KEY-----\nfake-key-data\n-----END RSA PRIVATE KEY-----',
    sshKeyPassphrase: 'key-passphrase',
    jumpHost: 'bastion.example.com',
    jumpUsername: 'jump-user',
    jumpAuthMethod: 'agent',
    jumpRequiresTouch: true,
    matchHosts: ['*.prod.example.com'],
    matchTags: ['production'],
    isDefault: true,
});

assert(credId2 > credId, `Second credential added with id ${credId2}`);

// Duplicate name should throw
try {
    store.addCredential({ name: 'lab-switches', username: 'other' });
    assert(false, 'Duplicate name should throw');
} catch {
    assert(true, 'Duplicate name throws');
}

// ─── Test: Get Credential ────────────────────────────────────

console.log('\n[Get Credential]');

const cred = store.getCredential('lab-switches');
assert(cred !== null, 'Credential found by name');
assert(cred!.username === 'admin', 'Username matches');
assert(cred!.password === 'cisco123', 'Password decrypted correctly');
assert(cred!.matchHosts.length === 2, 'Match hosts preserved');
assert(cred!.matchHosts[0] === '10.0.*', 'First host pattern matches');
assert(cred!.matchTags.includes('cisco'), 'Tags preserved');

const cred2 = store.getCredential('prod-routers');
assert(cred2!.sshKey!.includes('RSA PRIVATE KEY'), 'SSH key decrypted');
assert(cred2!.sshKeyPassphrase === 'key-passphrase', 'Key passphrase decrypted');
assert(cred2!.jumpHost === 'bastion.example.com', 'Jump host preserved');
assert(cred2!.jumpRequiresTouch === true, 'Jump touch flag preserved');
assert(cred2!.isDefault === true, 'Default flag set');

const missing = store.getCredential('nonexistent');
assert(missing === null, 'Missing credential returns null');

// ─── Test: List Credentials (Summary) ────────────────────────

console.log('\n[List Credentials — Summary]');

const summaries = store.listCredentials();
assert(summaries.length === 2, `Listed ${summaries.length} credentials`);

const labSummary = summaries.find(s => s.name === 'lab-switches')!;
assert(labSummary.hasPassword === true, 'Summary shows hasPassword');
assert(labSummary.hasSshKey === false, 'Summary shows no SSH key');

const prodSummary = summaries.find(s => s.name === 'prod-routers')!;
assert(prodSummary.hasSshKey === true, 'Summary shows hasSshKey');
assert(prodSummary.isDefault === true, 'Summary shows isDefault');

// ─── Test: List Full (Decrypted) ─────────────────────────────

console.log('\n[List Credentials — Full]');

const fullList = store.listCredentialsFull();
assert(fullList.length === 2, 'Full list has 2 entries');
assert(fullList[0].password !== null || fullList[1].password !== null, 'Full list includes secrets');

// ─── Test: Update Credential ─────────────────────────────────

console.log('\n[Update Credential]');

const updated = store.updateCredential('lab-switches', {
    password: 'new-password-2024',
    matchTags: ['lab', 'cisco', 'updated'],
});

assert(updated, 'Update returned true');

const afterUpdate = store.getCredential('lab-switches')!;
assert(afterUpdate.password === 'new-password-2024', 'Password updated');
assert(afterUpdate.matchTags.includes('updated'), 'Tags updated');
assert(afterUpdate.username === 'admin', 'Unchanged fields preserved');

// ─── Test: Set Default ───────────────────────────────────────

console.log('\n[Set Default]');

store.setDefault('lab-switches');

const newDefault = store.getDefault();
assert(newDefault!.name === 'lab-switches', 'New default is lab-switches');

const oldDefault = store.getCredential('prod-routers');
assert(oldDefault!.isDefault === false, 'Old default flag cleared');

// ─── Test: Last Used ─────────────────────────────────────────

console.log('\n[Last Used]');

store.updateLastUsed('lab-switches');
const afterUsed = store.getCredential('lab-switches')!;
assert(afterUsed.lastUsed !== null, 'Last used timestamp set');

// ─── Test: Remove Credential ─────────────────────────────────

console.log('\n[Remove Credential]');

const removed = store.removeCredential('lab-switches');
assert(removed, 'Remove returned true');

const afterRemove = store.getCredential('lab-switches');
assert(afterRemove === null, 'Credential gone after remove');

assert(store.credentialCount === 1, 'Credential count is 1');

// ─── Test: Change Master Password ────────────────────────────

console.log('\n[Change Master Password]');

const NEW_PASSWORD = 'new-master-2024';

const changed = store.changeMasterPassword(PASSWORD, NEW_PASSWORD);
assert(changed, 'Password change returned true');

// Old password should fail
store.lock();
assert(!store.unlock(PASSWORD), 'Old password no longer works');

// New password should work
assert(store.unlock(NEW_PASSWORD), 'New password works');

// Credentials still accessible
const afterChange = store.getCredential('prod-routers');
assert(afterChange!.password === 'secure-pw', 'Credentials survive re-encryption');
assert(afterChange!.sshKey!.includes('RSA PRIVATE KEY'), 'SSH key survives re-encryption');

// ─── Test: Credential Count ──────────────────────────────────

console.log('\n[Credential Count]');

assert(store.credentialCount === 1, `Count is ${store.credentialCount}`);

// ─── Cleanup ─────────────────────────────────────────────────

store.lock();
cleanup();

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(48)}\n`);

process.exit(failed > 0 ? 1 : 0);
