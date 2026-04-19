# nterm-js

**A modern SSH and telnet terminal with a built-in encrypted credential vault.**

Tabbed sessions, ten themes, session capture, and a connection layer that works with every server — modern or ancient. Electron desktop app, no runtime dependencies, no Python install required.

[![nterm-js desktop — SSH terminal with session tree](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/nterm1.gif)](https://github.com/scottpeterman/nterm-js/blob/main/screenshots/nterm1.gif)

---

## Why nterm-js

Most free SSH clients ask you to pick two of three: good terminal, good session management, good credential handling. The ones that have all three are usually either paid, enterprise-targeted, or written for a specific platform.

nterm-js bundles them in one standalone app:

* **xterm.js terminal** — the same engine that powers VS Code's integrated terminal. Full VT100/ANSI, 256-color, Unicode, box-drawing. Renders htop, vim, and 30-year-old Cisco menus equally well.
* **AES-256-GCM credential vault** — built-in, SQLite-backed, unlocked per session or cached in the OS keychain. Credentials never cross process boundaries to the renderer.
* **Legacy device support** — RSA SHA-1, diffie-hellman-group-exchange-sha1, aes128-cbc. Connects to servers that modern OpenSSH has long since refused.
* **Multi-protocol transport** — SSH and telnet side-by-side in the same session tree. Telnet covers GNS3 consoles, reverse telnet through terminal servers, and legacy telnet-only gear.
* **Session management** — folder hierarchy, YAML files, search, and persistent per-tab state.

Download, install, connect. That's the pitch.

---

## Features

**Terminal**

* xterm.js rendering — full color, resize, configurable scrollback
* Tab-per-session with live connection status indicators (connecting / connected / disconnected / error)
* Tab context menu: Close, Close Others, Close to the Right, Close All
* Terminal font zoom (Cmd/Ctrl+= / Cmd/Ctrl+- / Cmd/Ctrl+0) — per-terminal, persists across sessions
* Multi-line paste warning with preview and confirmation
* Configurable font size, font family, and cursor style
* Press Enter to reconnect on disconnected or errored tabs
* Refit-on-reconnect keeps xterm and the remote PTY in sync

**Protocols**

* **SSH** — ssh2-based, full auth chain (password, key file, agent, keyboard-interactive), legacy cipher fallback, shell → exec channel fallback for devices that reject shell requests
* **Telnet** — net.Socket-based, RFC 854 IAC negotiation (ECHO / SGA / NAWS), CR/LF → CRLF line mode per SecureCRT default, 0xFF escape on write
* Protocol selectable per-session in the session editor or ad-hoc from the quick-connect dialog
* Session YAML gets an optional `protocol: telnet` field — absent or `ssh` keeps existing files working unchanged
* One xterm.js instance per tab regardless of transport; terminals don't know or care what's underneath

**Themes**

* Ten themes shipped: Catppuccin Mocha, Catppuccin Latte, Darcula, Nord, Gruvbox Dark, Gruvbox Light, Solarized Dark, Solarized Light, Corporate Dark, Corporate Light
* Live theme switcher in the top bar
* Persists across launches

**Authentication (SSH)**

* Password and keyboard-interactive (multi-language prompt detection)
* SSH key file with passphrase support
* SSH agent (Pageant on Windows, `SSH_AUTH_SOCK` on Linux/macOS)
* Default key discovery (`~/.ssh/id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`)
* Combined key + password authentication

Telnet auth is interactive — type username / password at the device prompt. No pre-connect auth state to manage.

**Credential Vault**

* AES-256-GCM authenticated encryption, PBKDF2 key derivation (480,000 iterations)
* SQLite storage in the OS-native user data path — separate from the session YAML, never committed
* Host-pattern matching (`10.0.*`, `*.lab.example.com`) with score-based resolution
* Per-credential match tags, default-credential fallback
* Optional OS keychain integration (macOS Keychain, Windows DPAPI, Linux libsecret) for auto-unlock
* Credentials injected server-side at connect time — the renderer never sees passwords or key content
* Master password changeable; all stored credentials re-encrypted in place
* On-disk storage: encrypted SQLite database plus an optional keychain-wrapped master password blob (see [Vault Storage](#vault-storage))

**Legacy Device Support (SSH)**

* RSA SHA-1 fallback for OpenSSH < 7.2 servers
* Legacy KEX: `diffie-hellman-group14-sha1`, `group1-sha1`, `group-exchange-sha1`
* Legacy ciphers: `aes128-cbc`, `3des-cbc`
* Shell → exec channel fallback for devices that reject shell requests
* Retry-with-legacy-algorithms as a user action
* Tested with Cisco IOS 12.2+, Junos 14.x+, Arista EOS, NX-OS

**Session Management**

* YAML/JSON session files with folder hierarchy
* Auto-reload of last sessions file on launch
* Session search and filter
* Session editor (add, edit, duplicate, delete) with protocol selector
* Folder editor (add, rename, delete)
* Quick-connect dialog with protocol selector and SSH auth method chooser
* Credential selector bound to the vault
* Native file browser for key selection

**Session Capture**

* Per-tab capture to file, ANSI-stripped
* Native file picker for capture destination
* Live capturing indicator on the tab
* Auto-flush on tab close

**Safety**

* Active-connection warning on window close
* Active-connection warning on app quit (File → Exit, Cmd+Q)
* Per-tab warning when closing a connected tab individually
* Bulk tab close (Close All, Close Others) confirms once

**Settings**

* Unified Settings dialog (`File → Settings…` or `Cmd/Ctrl+,`) for appearance, terminal behavior, and connection defaults
* Terminal font picker with availability detection — unavailable fonts on the current OS are labeled and disabled so users can't pick something that renders broken
* Live apply on Save — font, cursor style, scrollback, and sidebar size changes take effect across open terminals immediately
* Window position and size restored on launch
* Theme preference (set from the top bar)
* Terminal font family, terminal font size, sidebar font size
* Cursor style and blink
* Scrollback depth
* Sidebar width (persists from splitter drag)
* Default auth method, username, and private key path
* Paste warning threshold
* Last sessions file (auto-loaded on next launch)
* Cross-platform storage: `%APPDATA%` / `~/Library/Application Support` / `~/.config`

**Distribution**

* Cross-platform builds via electron-builder
* Linux: AppImage + deb
* macOS: DMG
* Windows: NSIS installer

---

## Screenshots

|  |  |
| --- | --- |
| [Terminal — Gruvbox Dark](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/gruv-htop.png) | [Terminal — Corporate Light](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/corp-light-htop.png) |
| Gruvbox Dark — htop | Corporate Light — htop |
| [Vault unlock](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/vault-login.png) | [Vault manager](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/vault1.png) |
| Credential vault — unlock | Credential vault — manager |
| [Session editor](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/gruv-edit-session.png) |  |
| Session editor |  |

---

## Install

### From Source

There are no binary releases yet — installers are the next milestone. To run from source:

```
git clone https://github.com/scottpeterman/nterm-js.git
cd nterm-js
npm install
npm start
```

Requires Node.js 20+ and npm.

### Building Installers

```
npm run build:win      # Windows NSIS installer
npm run build:mac      # macOS DMG
npm run build:linux    # AppImage + deb
```

Output lands in `release/`.

---

## Architecture

```
src/
├── main/
│   ├── main.ts              # Electron main process — window, menu, IPC
│   ├── transportManager.ts  # Abstract base class for transports
│   │                        #   IPC message plumbing · connection state
│   │                        #   dimension tracking · diagnostics
│   ├── sshManager.ts        # SSH transport (ssh2)
│   │                        #   full auth chain · legacy cipher fallback
│   │                        #   shell → exec channel fallback
│   │                        #   keyboard-interactive · key/agent auth
│   ├── telnetManager.ts     # Telnet transport (net.Socket)
│   │                        #   RFC 854 IAC negotiation
│   │                        #   NAWS window-size updates
│   │                        #   CRLF line-mode normalization
│   ├── settings.ts          # Persistent settings (electron-store)
│   ├── vaultCrypto.ts       # AES-256-GCM + PBKDF2 primitives
│   ├── vaultStore.ts        # SQLite-backed encrypted credential storage
│   ├── vaultKeychain.ts     # Electron safeStorage integration
│   ├── vaultResolver.ts     # Host pattern → credential scoring
│   ├── vaultIpc.ts          # Vault IPC handlers
│   └── networkCheck.ts      # LAN access probe
├── preload/
│   └── preload.ts            # Secure IPC bridge (window.nterm API)
│
└── renderer/
    ├── index.html            # Split layout: session tree + terminal tabs
    ├── renderer.js           # xterm.js terminals, tab management, dialogs
    ├── themes.js             # Ten theme palettes
    ├── vault-ui.js           # Vault unlock and credential manager UI
    └── styles.css            # CSS variable theming
```

### Transport Abstraction

`TransportManager` is an abstract base class that owns the transport-agnostic plumbing: IPC message formatting and throttling, the connection state machine, dimension tracking, byte counters, and diagnostics. Subclasses implement four hooks: `performConnect`, `performWrite`, `performResize`, `performDisconnect`.

`SSHManager` and `TelnetManager` each extend it. The renderer and IPC layer don't know or care which subclass is at the other end — they speak a single message vocabulary (`output`, `connectionStatus`, `error`, `input`, `resize`, etc.) routed through the same `ssh:message` channel.

Adding a new transport (e.g. serial) is a new subclass plus a dispatcher branch in `main.ts`. No changes to the renderer, the session YAML schema, or the settings layer.

### Data Flow

```
 Keystrokes                                    Device Output
     │                                              │
     ▼                                              ▼
 xterm.js ──► preload IPC ──► main.ts ──► TransportManager ──► ssh2 / net.Socket
 (renderer)   (bridge)        (dispatch) (SSH or Telnet)        (wire)
                                              │
                                              ▼
                                         ssh:message IPC
                                              │
                                              ▼
                                    renderer (writes to xterm.js)
```

The transport layer runs in the Electron main process. The renderer never touches Node.js or the network — it sends keystrokes through IPC and receives output through a single `ssh:message` channel. Context isolation is enforced.

Vault secrets are resolved in the main process at connect time (SSH only — telnet has no pre-auth). The renderer sees credential names and usernames; it never sees passwords or key content. This applies to the credential manager UI too — the list returns metadata only.

Settings are owned by the main process (`settings.ts`) and exposed to the renderer through IPC. The Settings dialog takes a snapshot of current values on open, diffs against the form on Save, and pushes only changed keys — changes apply live to open terminals via xterm's option setters, with no reload required.

### Origin

The SSH engine was ported from the [Terminal Telemetry VS Code extension](https://marketplace.visualstudio.com/items?itemName=ScottPeterman.terminal-telemetry) with two changes:

1. `vscode.Webview.postMessage()` → `BrowserWindow.webContents.send()`
2. VS Code logger → `electron-log`

All auth logic, legacy device handling, exec channel fallback, and diagnostic output carried over unchanged. It later became the first subclass of `TransportManager` when the telnet support landed, but the SSH-specific code paths were not modified in that refactor.

The vault is a direct port of the Python vault from the [nterm-ng](https://github.com/scottpeterman/nterm-ng) project — same schema, same encryption parameters, same score-based resolver — with AES-256-GCM substituted for Fernet (stronger cipher, zero external dependencies).

---

## Session File Format

YAML session files are compatible with nterm and TerminalTelemetry:

```yaml
- folder_name: Lab Switches
  sessions:
    - display_name: usa-leaf-1
      host: 192.168.1.101
      port: 22
      DeviceType: arista_eos
      username: admin
      password: admin

    - display_name: core-rtr-1
      host: 192.168.1.1
      port: 22
      DeviceType: cisco_ios
      credential_name: lab-admin   # pulls from vault

- folder_name: GNS3 — Leaf Spine Lab
  sessions:
    - display_name: spine1 (console)
      protocol: telnet
      host: 127.0.0.1
      port: 2001
      DeviceType: arista_eos

    - display_name: spine2 (console)
      protocol: telnet
      host: 127.0.0.1
      port: 2002
      DeviceType: arista_eos
```

The `protocol` field is optional and defaults to `ssh` when absent — existing session files work unchanged. Set it to `telnet` for GNS3 consoles, reverse telnet, or legacy telnet-only devices. When `protocol: telnet`, auth fields (`username`, `password`, `credential_name`, `use_vault`, `use_agent`, `legacyMode`) are ignored.

Three resolution modes for SSH credentials:

1. Explicit `credential_name` — look up by name in the vault
2. `use_vault: true` — score vault credentials against host/tags
3. Neither — use inline fields or prompt via connection dialog

A Python script is included for converting JSON session exports:

```
python convert_json.py sessions.json -o sessions.yaml
```

---

## Settings

Settings persist across launches in the OS-native config path:

| Setting | Default | Description |
| --- | --- | --- |
| `theme` | `catppuccin-mocha` | One of ten shipped themes |
| `terminalFontFamily` | Platform-specific† | Terminal font — selected from a curated list with availability detection |
| `terminalFontSize` | `14` | Terminal font size (8–32) |
| `sidebarFontSize` | `12` | Session tree font size (10–20) |
| `cursorStyle` | `block` | `block`, `underline`, or `bar` |
| `cursorBlink` | `true` | Blinking cursor |
| `scrollbackLines` | `10000` | Scrollback buffer depth (500–100,000) |
| `sidebarWidth` | `220` | Session tree width in pixels |
| `pasteWarningThreshold` | `1` | Line count that triggers paste confirmation |
| `defaultUsername` | *(empty)* | Pre-filled username in connection dialog |
| `defaultAuthMethod` | `password` | Default auth method in connection dialog |
| `defaultPrivateKeyPath` | *(empty)* | Default private key path for key-based auth |
| `defaultLegacyMode` | `false` | Default legacy mode toggle |
| `lastSessionsFile` | *(empty)* | Auto-loaded on next launch |
| `windowBounds` | 1400×900 | Restored window position, size, maximized state |

† Default terminal font is `Cascadia Mono` on Windows, `Menlo` on macOS, and `DejaVu Sans Mono` on Linux — each ships with its respective OS so first-run always renders correctly.

Settings file locations:

* **Windows**: `%APPDATA%\nterm-js\config.json`
* **macOS**: `~/Library/Application Support/nterm-js/config.json`
* **Linux**: `~/.config/nterm-js/config.json`

Vault database lives alongside the config; see below.

---

## Vault Storage

The vault uses two files, both in the same OS-native user data directory as `config.json`:

| File | Contents | When created |
| --- | --- | --- |
| `vault.db` | SQLite database. Credential fields (password, SSH key, key passphrase) are AES-256-GCM encrypted at rest. Non-sensitive fields (name, username, match patterns) are plaintext for query speed. | First time you initialize the vault |
| `vault-keychain.bin` | The vault master password, encrypted by the OS credential store via Electron's `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret). Used to auto-unlock on launch. | Only if you check "remember password" at unlock |

A few things worth knowing:

* The vault master password is never written anywhere in plaintext. PBKDF2-HMAC-SHA256 (480,000 iterations) derives the actual encryption key, and a verification token pattern lets the app check the password without storing it.
* `vault-keychain.bin` is optional. If it's absent, nterm-js prompts for the master password on every launch. Delete the file to clear auto-unlock; the vault itself is untouched.
* Deleting `vault.db` removes all stored credentials permanently. There is no backup or recovery path — the file *is* the vault.
* The vault is per-OS-user. There's no cloud sync; another user on the same machine cannot read it even with physical file access (they don't have your OS login to unwrap the keychain blob, and they don't have the master password to derive the key).
* The vault is SSH-only. Telnet sessions have no pre-auth and never touch the vault.

File locations by platform:

* **Windows**: `%APPDATA%\nterm-js\vault.db` and `%APPDATA%\nterm-js\vault-keychain.bin`
* **macOS**: `~/Library/Application Support/nterm-js/vault.db` (and `vault-keychain.bin`)
* **Linux**: `~/.config/nterm-js/vault.db` (and `vault-keychain.bin`)

---

## Development

```
# Run in dev mode
npm start

# Watch mode (recompiles TypeScript on save)
npm run watch
# Then in another terminal:
npx electron .

# Build distributables
npm run build:win
npm run build:mac
npm run build:linux
```

TypeScript in `src/main/` and `src/preload/` compiles to `dist/`. The renderer is plain HTML, CSS, and JavaScript — no framework, no build step, directly debuggable in DevTools.

---

## Roadmap

### Shipped

* Multi-tab xterm.js terminal with per-tab state
* `TransportManager` abstraction with pluggable backends
* **SSH transport** — password, key file, SSH agent, keyboard-interactive authentication
* **Telnet transport** — RFC 854 IAC negotiation, NAWS resize, CRLF line-mode — tested against GNS3 / dynamips consoles and real terminal servers
* Protocol selector in session editor and quick-connect dialog
* Legacy cipher/KEX support for older SSH devices
* Shell → exec channel fallback
* YAML/JSON session files with folder hierarchy and optional `protocol` field
* Connection dialog with auth method and credential selector
* Session editor (add, edit, duplicate, delete)
* Folder editor (add, rename, delete)
* Ten themes with live switching
* Session search and filter
* Persistent settings (window bounds, theme, terminal prefs)
* Auto-reload last sessions file on launch
* Multi-line paste warning with preview
* Session capture to file (ANSI-stripped)
* Encrypted credential vault (AES-256-GCM, PBKDF2, SQLite)
* Host pattern matching and score-based credential resolution
* OS keychain integration for auto-unlock
* Tab context menu (Close, Close Others, Close to the Right, Close All)
* Terminal font zoom with persistence
* Active-connection confirmations on tab close, window close, and app quit
* Refit-on-reconnect
* Unified Settings dialog with live apply across open terminals
* Platform-aware terminal font defaults with availability detection

### Next (pre-release polish)

* Packaged installers published as GitHub Releases
* README and screenshot refresh for the Microsoft Store listing
* Code signing (Windows, macOS)
* Scrollback search (Ctrl+F)
* Session logging default filenames with timestamps
* Login actions / commands-on-connect (platform-aware from `DeviceType`)

### Planned

* Serial transport (console cables, crash carts) — next subclass of `TransportManager`
* Auto-reconnect with exponential backoff
* Auto-update via electron-updater
* Session export (ANSI + plain text, with timestamps)
* Jump host support (schema already reserves the fields)
* Command broadcast / send to selected tabs
* Additional themes contributed by users

---

## Related Projects

* [nterm](https://github.com/scottpeterman/nterm-qt) — PyQt6 SSH terminal widget with scripting API
* [nterm-ng](https://github.com/scottpeterman/nterm-ng) — Python SSH terminal with sniffer, telemetry, and parse chain
* [Terminal Telemetry](https://marketplace.visualstudio.com/items?itemName=ScottPeterman.terminal-telemetry) — VS Code SSH extension (origin of the SSH engine)
* [tfsmjs](https://github.com/scottpeterman/tfsmjs) — TextFSM JavaScript port

---

## License

GPL-3.0

---

## Author

**Scott Peterman**
[github.com/scottpeterman](https://github.com/scottpeterman)