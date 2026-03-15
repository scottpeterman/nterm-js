# nterm-js Vault Architecture — Python Pattern Analysis

Design patterns extracted from nterm Python vault (`nterm/vault/`) mapped to Electron/TypeScript implementation targets.

---

## Layer Map

```
Python (nterm/vault/)              →  Electron (nterm-js)
─────────────────────                  ──────────────────
store.py (CredentialStore)         →  src/main/vaultStore.ts
  - SQLite + Fernet encryption          - better-sqlite3 + Node crypto
  - PBKDF2 key derivation               - crypto.pbkdf2Sync
  - Thread-safe with threading.Lock      - Single-threaded main process (no lock needed)

resolver.py (CredentialResolver)   →  src/main/vaultResolver.ts
  - Pattern matching (fnmatch)          - minimatch or manual glob
  - Score-based credential selection    - Same algorithm, direct port
  - ConnectionProfile construction      - SSH config object for sshManager

keychain.py (KeychainIntegration)  →  src/main/vaultKeychain.ts
  - keyring (optional)                  - Electron safeStorage API (built-in)

manager_ui.py (CredentialManagerWidget) → src/renderer/vault-manager.js
  - PyQt6 QDialog / QTableWidget        - HTML modal + table in renderer
  - ManagerTheme dataclass               - CSS variables (already themed)

vault_api.py (FastAPI router)      →  IPC handlers in main.ts
  - REST endpoints                      - ipcMain.handle('vault:*')
  - Never exposes secrets to client     - Same pattern: secrets stay in main process

vault_connect.py (resolve_ssh_config) → Integration in sshManager.ts
  - WebSocket connect enrichment        - IPC connect enrichment (same concept)
  - Resolution priority chain           - credential_name > use_vault > passthrough

vault_auth_provider.py             →  Not needed (Electron is single-app)
  - Wirlwind bridge                     - sshManager calls resolver directly

preload.ts (existing)              →  Add vault IPC surface to preload.ts
  - vault: Record<string, unknown>      - Expand to typed vault methods
```

---

## Pattern 1: Encryption Engine

### Python (store.py lines 253-274)

```python
def _derive_key(self, password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=480000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(password.encode()))
    return key

def _encrypt(self, data: str) -> bytes:
    return self._fernet.encrypt(data.encode())

def _decrypt(self, data: bytes) -> str:
    return self._fernet.decrypt(data).decode()
```

### Translation Target (TypeScript)

Two options for the symmetric cipher:

**Option A: Fernet-compatible** (npm `fernet` package)
- Pro: Vault files portable between Python and JS versions
- Con: Another dependency, Fernet is AES-128-CBC (weaker than AES-256-GCM)

**Option B: Native Node.js crypto (recommended)**
- `crypto.pbkdf2Sync(password, salt, 480000, 32, 'sha256')` for key derivation
- `crypto.createCipheriv('aes-256-gcm', key, iv)` for encryption
- Pro: Zero dependencies, stronger cipher (AES-256-GCM = authenticated encryption)
- Con: Not compatible with existing Python vault files (fresh vault per platform)

Recommendation: **Option B**. nterm-js is a standalone app, not sharing vault files
with the Python tools. AES-256-GCM is better than Fernet's AES-128-CBC, and
Node.js crypto is always available in Electron main process.

```typescript
// Sketch — src/main/vaultCrypto.ts
import crypto from 'crypto';

const ITERATIONS = 480_000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;

export function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

export function encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Pack: [iv (12)] [authTag (16)] [ciphertext (...)]
    return Buffer.concat([iv, authTag, encrypted]);
}

export function decrypt(packed: Buffer, key: Buffer): string {
    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

---

## Pattern 2: Vault Lifecycle (init → unlock → operate → lock)

### Python (store.py)

The vault has exactly four states:
1. **Not initialized** — no vault.db exists, or vault_meta table missing
2. **Initialized but locked** — vault.db exists with salt + verify token, no Fernet in memory
3. **Unlocked** — Fernet instance held in memory, DB connection open
4. **Locked** — Fernet cleared, DB connection closed

State transitions:
```
[not init] --init_vault(pw)--> [locked] --unlock(pw)--> [unlocked] --lock()--> [locked]
```

Key design decisions that carry forward:
- **Verification token pattern**: On init, generate random bytes, encrypt them, store both
  encrypted and plain. On unlock, decrypt the encrypted version and compare to plain.
  This verifies the password without storing it.
- **Connection lifecycle**: Python opens a persistent SQLite connection on unlock,
  closes it on lock. In Electron with better-sqlite3, this is synchronous and simpler.
- **Thread safety**: Python uses `threading.Lock` because PyQt6 has multiple threads.
  Electron main process is single-threaded — no lock needed.

### Translation Notes

```typescript
// State machine — same as Python, simpler without locks
class VaultStore {
    private db: BetterSqlite3.Database | null = null;
    private key: Buffer | null = null;

    get isInitialized(): boolean { /* check file + table existence */ }
    get isUnlocked(): boolean { return this.key !== null && this.db !== null; }

    initVault(password: string): void { /* create DB, salt, verify token */ }
    unlock(password: string): boolean { /* derive key, verify, store key + open DB */ }
    lock(): void { this.key = null; this.db?.close(); this.db = null; }
}
```

---

## Pattern 3: Credential Schema

### Python (store.py lines 123-149)

```sql
CREATE TABLE credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    password_enc BLOB,          -- encrypted
    ssh_key_enc BLOB,           -- encrypted (PEM content)
    ssh_key_passphrase_enc BLOB,-- encrypted
    jump_host TEXT,              -- cleartext (not sensitive)
    jump_username TEXT,
    jump_auth_method TEXT DEFAULT 'agent',
    jump_requires_touch INTEGER DEFAULT 0,
    match_hosts TEXT,            -- comma-separated glob patterns
    match_tags TEXT,             -- comma-separated tags
    is_default INTEGER DEFAULT 0,
    created_at TEXT,
    last_used TEXT
);
```

### Translation Notes

Schema ports directly. The only change: consider JSON columns for `match_hosts`
and `match_tags` instead of comma-separated strings (better-sqlite3 handles
JSON extraction natively).

**Encrypted fields** stay as BLOBs. The packed format (iv + authTag + ciphertext)
from the AES-256-GCM encrypt function stores cleanly in SQLite BLOB columns.

**Jump host fields** are forward-looking — nterm-js doesn't support jump hosts
yet, but including them in the schema from day one means the vault format is
ready when jump host support lands.

---

## Pattern 4: Credential Resolution (Score-Based Matching)

### Python (resolver.py lines 97-120)

```python
def _score_credential(self, cred, hostname, tags=None):
    score = 0
    for pattern in cred.match_hosts:
        if fnmatch.fnmatch(hostname, pattern):
            specificity = len(pattern) - pattern.count('*') - pattern.count('?')
            score += 10 + specificity
            break
    if tags and cred.match_tags:
        matching_tags = set(tags) & set(cred.match_tags)
        score += len(matching_tags) * 5
    if cred.is_default and score == 0:
        score = 1
    return score
```

### Translation Notes

This is the most important pattern to get right. The scoring logic is:
- **Host pattern match**: `10 + specificity` (more specific patterns score higher)
- **Tag match**: `5 × matching_tag_count`
- **Default fallback**: Score 1 if nothing else matched

In JS, `fnmatch` maps to `minimatch` or a simple glob implementation. Since
network patterns are typically `10.0.*`, `*.lab.example.com`, or exact IPs,
a minimal glob matcher covering `*` and `?` is sufficient — no need for
full minimatch.

**Resolution priority chain** (from vault_connect.py):
1. Explicit `credential_name` → look up by name, skip scoring
2. `use_vault: true` → run scoring against all credentials
3. Neither → pass through whatever credentials the user typed in the dialog

This three-tier priority is the connect-time decision tree for nterm-js.

---

## Pattern 5: Keychain Integration

### Python (keychain.py)

```python
class KeychainIntegration:
    SERVICE_NAME = "nterm-vault"
    ACCOUNT_NAME = "master-password"

    @classmethod
    def store_master_password(cls, password: str) -> bool:
        keyring.set_password(cls.SERVICE_NAME, cls.ACCOUNT_NAME, password)

    @classmethod
    def get_master_password(cls) -> Optional[str]:
        return keyring.get_password(cls.SERVICE_NAME, cls.ACCOUNT_NAME)
```

### Translation: Electron safeStorage

Electron has `safeStorage` built in — no external dependency. It uses the
OS credential store (macOS Keychain, Windows DPAPI, Linux libsecret).

```typescript
import { safeStorage } from 'electron';
import fs from 'fs';

const KEYCHAIN_PATH = path.join(app.getPath('userData'), '.vault-key');

export function storePassword(password: string): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(password);
    fs.writeFileSync(KEYCHAIN_PATH, encrypted);
    return true;
}

export function getPassword(): string | null {
    if (!fs.existsSync(KEYCHAIN_PATH)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = fs.readFileSync(KEYCHAIN_PATH);
    return safeStorage.decryptString(encrypted);
}

export function clearPassword(): void {
    if (fs.existsSync(KEYCHAIN_PATH)) fs.unlinkSync(KEYCHAIN_PATH);
}
```

`safeStorage.isEncryptionAvailable()` replaces the Python keychain probe pattern.
The auto-unlock flow is identical: on startup, check for stored password, try unlock,
emit vault_unlocked if successful.

---

## Pattern 6: IPC Surface (vault_api.py → preload.ts)

### Python (FastAPI endpoints)

```
GET  /api/vault/status        → { initialized, unlocked, credential_count }
POST /api/vault/init          → initialize new vault
POST /api/vault/unlock        → unlock with password
POST /api/vault/lock          → lock vault
GET  /api/vault/match?host=   → resolve credential for host (metadata only)
GET  /api/vault/credentials   → list all (metadata only, no secrets)
POST /api/vault/launch-manager → open native credential manager
```

### Translation: IPC Handlers

```typescript
// main.ts — add alongside existing IPC handlers
ipcMain.handle('vault:status', () => ({
    initialized: vaultStore.isInitialized,
    unlocked: vaultStore.isUnlocked,
    credentialCount: vaultStore.isUnlocked ? vaultStore.listCredentials().length : 0,
}));

ipcMain.handle('vault:init', (_e, { password }) => {
    vaultStore.initVault(password);
    return { status: 'initialized' };
});

ipcMain.handle('vault:unlock', (_e, { password }) => {
    const success = vaultStore.unlock(password);
    return { status: success ? 'unlocked' : 'failed' };
});

ipcMain.handle('vault:lock', () => {
    vaultStore.lock();
    return { status: 'locked' };
});

ipcMain.handle('vault:match', (_e, { host, port }) => {
    // Returns metadata only — never secrets over IPC
    return vaultResolver.matchForHost(host, port);
});

ipcMain.handle('vault:list', () => {
    // Credential summaries — no decrypted secrets
    return vaultStore.listCredentials();
});

ipcMain.handle('vault:add', (_e, { credential }) => {
    return vaultStore.addCredential(credential);
});

ipcMain.handle('vault:remove', (_e, { name }) => {
    return vaultStore.removeCredential(name);
});

ipcMain.handle('vault:update', (_e, { name, updates }) => {
    return vaultStore.updateCredential(name, updates);
});
```

### Preload Extension

```typescript
// Add to preload.ts — vault section
vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    init: (password: string) => ipcRenderer.invoke('vault:init', { password }),
    unlock: (password: string) => ipcRenderer.invoke('vault:unlock', { password }),
    lock: () => ipcRenderer.invoke('vault:lock'),
    match: (host: string, port?: number) =>
        ipcRenderer.invoke('vault:match', { host, port: port || 22 }),
    list: () => ipcRenderer.invoke('vault:list'),
    add: (credential: any) => ipcRenderer.invoke('vault:add', { credential }),
    remove: (name: string) => ipcRenderer.invoke('vault:remove', { name }),
    update: (name: string, updates: any) =>
        ipcRenderer.invoke('vault:update', { name, updates }),
},
```

---

## Pattern 7: Connect-Time Credential Injection

### Python (vault_connect.py)

The critical design: secrets never cross the IPC/WebSocket boundary.
The browser sends a `credential_name` or `hostname`; the server resolves
and injects credentials before passing to Paramiko.

### Translation: sshManager Integration

In nterm-js, the same pattern applies at the `ssh:connect` IPC handler.
Before calling sshManager.connect(), resolve credentials:

```typescript
// In main.ts ssh:connect handler (pseudocode)
ipcMain.handle('ssh:connect', async (_e, { sessionId, config }) => {
    // Credential injection — secrets stay in main process
    if (config.credentialName && vaultStore.isUnlocked) {
        const cred = vaultStore.getCredential(config.credentialName);
        if (cred) {
            config.username = cred.username;
            config.password = cred.password;  // decrypted in main process
            if (cred.sshKey) {
                config.privateKey = cred.sshKey;
                config.passphrase = cred.sshKeyPassphrase;
            }
        }
    } else if (config.useVault && vaultStore.isUnlocked) {
        const resolved = vaultResolver.resolveForHost(config.host, config.port);
        if (resolved) {
            // Inject resolved credentials into config
        }
    }
    // config now has credentials — pass to sshManager
    return sshManager.connect(sessionId, config);
});
```

The renderer only sees: "vault matched credential 'lab-switches' for this host."
The actual password or key content never appears in renderer memory.

---

## Pattern 8: UI State Machine (manager_ui.py)

### Python (QStackedWidget pattern)

```python
# Two states: locked view (index 0) and unlocked view (index 1)
self.stack = QStackedWidget()
self.stack.addWidget(locked_widget)    # 🔒 icon + "Unlock" button
self.stack.addWidget(unlocked_widget)  # toolbar + credentials table
```

### Translation: HTML in renderer

The same stacked-view pattern maps to `display: none` toggling in the renderer.
The vault manager can be a modal dialog (like the existing connect-dialog and
paste-dialog patterns in index.html) or a sidebar panel.

**Recommended approach**: Modal dialog matching existing nterm-js patterns.

```html
<!-- Vault Manager Dialog -->
<div id="vault-dialog" class="modal-overlay" style="display:none;">
    <div class="modal" style="max-width: 700px;">
        <!-- Locked state -->
        <div id="vault-locked" style="display:none;">
            <!-- Password input + Unlock/Create button -->
        </div>
        <!-- Unlocked state -->
        <div id="vault-unlocked" style="display:none;">
            <!-- Toolbar: Add, Edit, Delete, Lock -->
            <!-- Credentials table -->
        </div>
    </div>
</div>
```

The credential add/edit dialog is a nested modal — same pattern as
CredentialDialog in Python, but HTML form fields instead of QLineEdit/QTextEdit.

---

## Pattern 9: Settings Integration

### Python

The vault is its own module with its own storage path (`~/.nterm/vault.db`).
Settings live separately.

### Translation

The `settings.ts` already reserves `vault: Record<string, unknown>`. Use this
for vault preferences (auto-unlock enabled, vault file path override) while
the actual encrypted data lives in a separate SQLite file:

```
~/.config/nterm-js/
├── config.json          ← electron-store (settings.ts)
└── vault.db             ← SQLite (vaultStore.ts)
```

Add to settings schema:
```typescript
vault: {
    type: 'object',
    properties: {
        autoUnlock: { type: 'boolean', default: true },
        dbPath: { type: 'string', default: '' },  // empty = default location
    }
}
```

---

## Implementation Order

Based on the Python module dependency graph:

### Step 1: vaultCrypto.ts
Standalone module. No dependencies. Unit-testable in isolation.
- `deriveKey(password, salt) → Buffer`
- `encrypt(plaintext, key) → Buffer`
- `decrypt(packed, key) → string`
- `generateSalt() → Buffer`
- `generateVerifyToken() → { token: Buffer, encrypted: Buffer }`

### Step 2: vaultStore.ts
Depends on: vaultCrypto.ts, better-sqlite3
- Schema creation (vault_meta + credentials tables)
- init/unlock/lock lifecycle
- CRUD operations (add, get, list, update, remove)
- `change_master_password` (re-encrypt all credentials)

### Step 3: vaultKeychain.ts
Depends on: Electron safeStorage
- Store/retrieve/clear master password
- `isAvailable()` check

### Step 4: vaultResolver.ts
Depends on: vaultStore.ts
- Score-based credential matching
- Host pattern glob matching
- `resolveForHost(hostname, port) → CredentialMatch | null`

### Step 5: IPC handlers in main.ts
Depends on: all vault modules
- Register `vault:*` IPC handlers
- Wire credential injection into `ssh:connect` handler

### Step 6: Preload extension
Depends on: IPC handlers
- Add `vault` object to `window.nterm` API

### Step 7: Renderer UI
Depends on: preload
- Vault status indicator in topbar or status bar
- Unlock dialog (modal)
- Credential manager dialog (modal with table)
- Credential add/edit dialog (nested modal)
- Connect dialog integration (credential selector dropdown)

---

## What NOT to Port

- **vault_auth_provider.py** — This bridges to Wirlwind telemetry, which is a
  separate Python app. nterm-js's sshManager calls the resolver directly.

- **vault_api.py as REST** — The FastAPI router exists because the Python nterm
  uses a browser-based renderer talking over HTTP. nterm-js uses Electron IPC,
  which is more secure (no network surface). The endpoint logic ports to IPC
  handlers, but the HTTP layer is dropped.

- **profile.py jump host fields** — Include in schema for forward compatibility,
  but don't build jump host UI until nterm-js supports multi-hop SSH.

- **Threading locks** — Electron main process is single-threaded. The
  `threading.Lock` wrapping in Python is not needed.

- **ConnectionProfile dataclass** — nterm-js already has its own SSH config
  format in sshManager. The resolver returns a plain object that maps to
  sshManager's existing connect config.

---

## Security Boundaries (Preserved)

Both Python and Electron versions enforce the same security model:

1. **Secrets never cross the IPC/API boundary.** The renderer sees credential
   names, usernames, auth types — never passwords or key content.

2. **Master password → derived key → encrypted secrets.** The master password
   is not stored. The derived key is held in memory only while unlocked.

3. **Keychain caches the master password, not the derived key.** If the OS
   keychain is compromised, the attacker gets the master password and must
   still derive the key and read the vault.db to access credentials.

4. **Vault auto-locks on window close.** Python does this via QWidget
   destruction. Electron does this via `window.on('closed')` in main.ts.

5. **Schema version in vault_meta.** Allows future migration if the encryption
   scheme or schema changes. Currently version 1.

---

## Dependencies

| Python | Electron/Node.js |
|--------|------------------|
| `cryptography` (Fernet, PBKDF2) | `crypto` (built-in Node.js) |
| `sqlite3` (stdlib) | `better-sqlite3` (npm, synchronous API) |
| `keyring` (optional) | `safeStorage` (built-in Electron) |
| `fnmatch` (stdlib) | `minimatch` (npm) or hand-rolled |
| `PyQt6` (UI) | HTML/CSS/JS in renderer |
| `FastAPI` (API) | Electron IPC (built-in) |

Total new npm dependencies: **1** (better-sqlite3). Everything else is built-in.
If you hand-roll the glob matcher (just `*` and `?`), it's **1** total.
