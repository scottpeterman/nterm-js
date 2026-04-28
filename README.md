# nterm-js

**Free, multi-protocol terminal for network engineers and sysadmins.**
SSH · telnet · serial · Windows/macOS/Linux · encrypted credential vault · git-friendly YAML session files

Tabbed sessions, thirty themes, session capture, and a connection layer that works with every server or console port — modern or ancient. Electron desktop app, no runtime dependencies, no Python install required.

#### See "Releases" for installable binaries - Window, Mac and Linux - v0.2.9 latest

[![nterm-js desktop — SSH terminal with session tree](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/splash.jpg)](https://github.com/scottpeterman/nterm-js/blob/main/screenshots/splash.jpg)

---

## Why nterm-js

Most free SSH clients ask you to pick two of three: good terminal, good session management, good credential handling. The ones that have all three are usually either paid, enterprise-targeted, or written for a specific platform. Add a decent console-cable / serial experience on top and the field narrows to almost nothing.

nterm-js bundles them in one standalone app:

* **xterm.js terminal** — the same engine that powers VS Code's integrated terminal. Full VT100/ANSI, 256-color, Unicode, box-drawing. Renders htop, vim, and 30-year-old Cisco menus equally well.
* **AES-256-GCM credential vault** — built-in, SQLite-backed, unlocked per session or cached in the OS keychain. Credentials never cross process boundaries to the renderer.
* **Legacy device support** — RSA SHA-1, diffie-hellman-group-exchange-sha1, aes128-cbc. Connects to servers that modern OpenSSH has long since refused.
* **Multi-protocol transport** — SSH, telnet, and serial side-by-side in the same session tree. Telnet covers GNS3 consoles and reverse-telnet through terminal servers. Serial covers USB-to-serial console cables, crash carts, and ROMMON / bootloader recovery on real hardware.
* **Session management** — folder hierarchy, YAML files, search, and persistent per-tab state.

Download, install, connect. That's the pitch.

---
[![nterm-js desktop — SSH terminal with session tree](https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/slides.gif)](https://github.com/scottpeterman/nterm-js/blob/main/screenshots/slides.gif)
---

## Features

**Terminal**

* xterm.js rendering — full color, resize, configurable scrollback
* Tab-per-session with live connection status indicators (connecting / connected / disconnected / error)
* Tab context menu: Close, Close Others, Close to the Right, Close All (plus Send Break entries on serial tabs)
* Terminal font zoom (Cmd/Ctrl+= / Cmd/Ctrl+- / Cmd/Ctrl+0) — per-terminal, persists across sessions
* Multi-line paste warning with preview, confirmation, and optional per-paste line-delay pacing for slow CLIs (network gear, GNS3 console, low-baud serial)
* Backpressured terminal output — UI stays responsive when devices dump huge output (`cat`, `show tech-support`, full BGP table). Ctrl+C drains the local queue and snaps back to a prompt instead of waiting on in-flight bytes.
* Configurable font size, font family, and cursor style
* Press Enter to reconnect on disconnected or errored tabs
* Refit-on-reconnect keeps xterm and the remote PTY in sync

**Protocols**

* **SSH** — ssh2-based, full auth chain (password, key file, agent, keyboard-interactive), legacy cipher fallback, shell → exec channel fallback for devices that reject shell requests
* **Telnet** — net.Socket-based, RFC 854 IAC negotiation (ECHO / SGA / NAWS), CR/LF → CRLF line mode per SecureCRT default, 0xFF escape on write
* **Serial** — node-serialport-based, USB-to-serial and real UART support. Configurable baud / data bits / parity / stop bits / flow control (RTS-CTS or XON-XOFF). Per-connection line-ending selection (CR default for network gear, CRLF / LF / raw as alternatives), optional local echo, and a **Send Break** control for Cisco ROMMON and password-recovery workflows (1.5s pulse on click, 5× 500ms burst on Shift+click for stubborn CH340 / FTDI-clone adapters). Platform-aware port enumeration hides the 32 `/dev/ttyS` stubs on Linux and Bluetooth-audio noise on macOS; the dialog proactively warns on Linux if the user isn't in `dialout` / `uucp` with a copy-pasteable `usermod` fix.
* Protocol selectable per-session in the session editor or ad-hoc from the quick-connect dialog (SSH and telnet); serial is quick-connect only because port paths aren't portable across machines
* Session YAML gets an optional `protocol: telnet` field — absent or `ssh` keeps existing files working unchanged. Serial sessions are not persisted to YAML.
* One xterm.js instance per tab regardless of transport; terminals don't know or care what's underneath

**Themes**

* 30 themes spanning modern palettes (Catppuccin, Darcula, Nord, Gruvbox, Solarized, Corporate), retro classics (Borland, Norton, PC Tools, Lotus 1-2-3, Amiga, Vintage), CRT phosphor (green, amber), cyberpunk-family, and dark-chrome / light-terminal hybrids
* Live theme switcher in the top bar, persists across launches

**Authentication (SSH)**

* Password and keyboard-interactive (multi-language prompt detection)
* SSH key file with passphrase support
* SSH agent (Pageant on Windows, `SSH_AUTH_SOCK` on Linux/macOS)
* Default key discovery (`~/.ssh/id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`)
* Combined key + password authentication

Telnet auth is interactive — type username / password at the device prompt. No pre-connect auth state to manage. Serial has no auth concept at all; you type at whatever prompt the device shows on the wire.

**Credential Vault**

* AES-256-GCM authenticated encryption, PBKDF2 key derivation (480,000 iterations)
* SQLite storage in the OS-native user data path — separate from the session YAML, never committed
* Host-pattern matching (`10.0.*`, `*.lab.example.com`) with score-based resolution
* Per-credential match tags, default-credential fallback
* Optional OS keychain integration (macOS Keychain, Windows DPAPI, Linux libsecret) for auto-unlock
* Credentials injected server-side at connect time — the renderer never sees passwords or key content
* Master password changeable; all stored credentials re-encrypted in place
* On-disk storage: encrypted SQLite database plus an optional keychain-wrapped master password blob (see [Vault Storage](#vault-storage))

The vault is SSH-only. Telnet and serial have no pre-auth and never touch it.

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
* Quick-connect dialog with protocol selector, SSH auth method chooser, and serial port discovery
* Credential selector bound to the vault
* Native file browser for key selection

**Session Capture**

* Per-tab capture to file, ANSI-stripped
* Works identically across SSH, telnet, and serial — the capture layer sits above the transport
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

### Themes

<table>
  <tr>
    <td width="33%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme_solarized.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme_solarized.png" alt="Solarized Dark" />
      </a>
      <br /><sub>Solarized Dark</sub>
    </td>
    <td width="33%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme_gruvbox.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme_gruvbox.png" alt="Gruvbox Dark" />
      </a>
      <br /><sub>Gruvbox Dark</sub>
    </td>
    <td width="33%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme-light.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/theme-light.png" alt="Light theme" />
      </a>
      <br /><sub>Light theme</sub>
    </td>
  </tr>
</table>

### Credential Vault

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/valt_creds_list.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/valt_creds_list.png" alt="Vault manager" />
      </a>
      <br /><sub>Vault manager — score-based host matching, AES-256-GCM at rest</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/edit_creds.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/edit_creds.png" alt="Edit credential" />
      </a>
      <br /><sub>Edit credential — password, key file, host-match patterns</sub>
    </td>
  </tr>
</table>

### Connection

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/new_connection.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/new_connection.png" alt="Quick-connect dialog" />
      </a>
      <br /><sub>Quick-connect — protocol selector, auth chooser, vault binding</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/reverse_telnet_gns.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/reverse_telnet_gns.png" alt="Reverse telnet to GNS3 console" />
      </a>
      <br /><sub>Reverse telnet — GNS3 / dynamips console, RFC 854 IAC + CRLF line mode</sub>
    </td>
  </tr>
</table>

### Dialogs

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/app-settings.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/app-settings.png" alt="Settings dialog" />
      </a>
      <br /><sub>Settings — live-apply to open terminals, no reload required</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/multi-line-past.png">
        <img src="https://raw.githubusercontent.com/scottpeterman/nterm-js/refs/heads/main/screenshots/multi-line-past.png" alt="Multi-line paste warning" />
      </a>
      <br /><sub>Multi-line paste warning — preview, confirm, optional line-delay pacing</sub>
    </td>
  </tr>
</table>

---

## Install

### From Source
To run from source:

```
git clone https://github.com/scottpeterman/nterm-js.git
cd nterm-js
npm install
npm start
```

Requires Node.js 20+ and npm. The serial transport uses `serialport`, which is a native module — on first install, `@electron/rebuild` compiles its bindings against your Electron version automatically. If it doesn't, run:

```
npx electron-rebuild -f -w serialport
```

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
│   ├── serialManager.ts     # Serial transport (node-serialport)
│   │                        #   USB-to-serial + real UART support
│   │                        #   break signal (ROMMON / password recovery)
│   │                        #   line-ending normalization (CR/CRLF/LF/raw)
│   │                        #   platform-aware port enumeration
│   │                        #   Linux dialout pre-check
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
    ├── themes.js             # Thirty theme palettes
    ├── vault-ui.js           # Vault unlock and credential manager UI
    └── styles.css            # CSS variable theming
```

### Transport Abstraction

`TransportManager` is an abstract base class that owns the transport-agnostic plumbing: IPC message formatting and throttling, the connection state machine, dimension tracking, byte counters, and diagnostics. Subclasses implement four hooks: `performConnect`, `performWrite`, `performResize`, `performDisconnect`.

`SSHManager`, `TelnetManager`, and `SerialManager` each extend it. The renderer and IPC layer don't know or care which subclass is at the other end — they speak a single message vocabulary (`output`, `connectionStatus`, `error`, `input`, `resize`, etc.) routed through the same `ssh:message` channel.

Adding a new transport is a new subclass plus a dispatcher branch in `main.ts`. No changes to the renderer, the session YAML schema, or the settings layer. Serial landed this way — one subclass, one dispatch branch, plus two thin IPC additions (`serial:list-ports`, `serial:send-break`) for the port-discovery and break-signal paths that don't fit the generic transport vocabulary.

### Data Flow

```
 Keystrokes                                    Device Output
     │                                              │
     ▼                                              ▼
 xterm.js ──► preload IPC ──► main.ts ──► TransportManager ──► ssh2 / net.Socket / serialport
 (renderer)   (bridge)        (dispatch) (SSH / Telnet / Serial) (wire)
                                              │
                                              ▼
                                         ssh:message IPC
                                              │
                                              ▼
                                    renderer (writes to xterm.js)
```

The transport layer runs in the Electron main process. The renderer never touches Node.js or the network — it sends keystrokes through IPC and receives output through a single `ssh:message` channel. Context isolation is enforced.

Vault secrets are resolved in the main process at connect time (SSH only — telnet and serial have no pre-auth). The renderer sees credential names and usernames; it never sees passwords or key content. This applies to the credential manager UI too — the list returns metadata only.

Settings are owned by the main process (`settings.ts`) and exposed to the renderer through IPC. The Settings dialog takes a snapshot of current values on open, diffs against the form on Save, and pushes only changed keys — changes apply live to open terminals via xterm's option setters, with no reload required.

### Origin

The SSH engine was ported from the [Terminal Telemetry VS Code extension](https://marketplace.visualstudio.com/items?itemName=ScottPeterman.terminal-telemetry) with two changes:

1. `vscode.Webview.postMessage()` → `BrowserWindow.webContents.send()`
2. VS Code logger → `electron-log`

All auth logic, legacy device handling, exec channel fallback, and diagnostic output carried over unchanged. It later became the first subclass of `TransportManager` when the telnet support landed, but the SSH-specific code paths were not modified in that refactor. The telnet and serial managers were written from scratch against the `TransportManager` contract once it had been proven against SSH.

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

Serial sessions deliberately aren't persisted to YAML. `/dev/ttyUSB0` on Linux, `/dev/cu.usbserial-XXXX` on macOS, and `COM3` on Windows all name the same physical adapter on the same machine, but the enumeration order shifts whenever you plug dongles in different order. A shared sessions.yaml with a baked-in serial path is a footgun — so serial is exclusively a quick-connect flow.

Three resolution modes for SSH credentials:

1. Explicit `credential_name` — look up by name in the vault
2. `use_vault: true` — score vault credentials against host/tags
3. Neither — use inline fields or prompt via connection dialog

A Python script is included for converting JSON session exports:

```
python convert_json.py sessions.json -o sessions.yaml
```

---

## Serial Transport

Serial is built for the things you use a console cable for: network gear, crash carts, ROMMON / bootloader recovery, and generic USB-serial devices. Everything below is configurable per-connection in the quick-connect dialog.

**Baud / framing.** 9600 8N1 by default (the network-gear standard). Baud dropdown covers 2400 / 4800 / 9600 / 19200 / 38400 / 57600 / 115200 / 230400. Framing is configurable: 7 or 8 data bits, none / even / odd parity, 1 or 2 stop bits. RTS-CTS hardware flow control is available as a checkbox.

**Line endings.** xterm.js emits a bare `\r` on Enter. Network console firmware is unanimously happy with bare CR and sometimes unhappy with CRLF (double-newlines on older IOS). Default is `CR (network gear)`, with `CRLF`, `LF`, and `raw` (pass-through) as alternatives for unusual devices.

**Local echo.** Off by default. Some devices (raw UARTs, certain bootloaders) don't echo what you type. Flip on "Local echo" and the terminal mirrors each write locally after line-ending normalization, so what you see matches what's on the wire.

**Send Break.** Cisco ROMMON and password-recovery workflows need an RS-232 BREAK. When a serial tab is active, a **Send Break** button appears in the top bar. Click for a single 1.5s pulse (the standard). Shift+click for a 5× burst of 500ms pulses — some USB-serial adapters (CH340, certain FTDI clones) silently drop short BREAKs, and the burst is what makes them work. Both options are also in the tab's right-click menu.

**Platform-aware port discovery.** The quick-connect dialog populates the port dropdown the moment you switch to Serial, and there's a refresh button for hot-plug scenarios.

* **macOS** — `/dev/tty.*` paths are rewritten to `/dev/cu.*`. The `cu` ("calling unit") device is what you want for outgoing / interactive use; `tty` is for incoming connections and blocks on DCD, which usually isn't what a console user wants. Bluetooth-audio devices (Jabra, AirPods, Beats, Bluetooth-Incoming-Port, debug-console) are filtered out because they're technically serial devices but never something you want to connect to.
* **Linux** — the kernel enumerates `/dev/ttyS0..ttyS31` as serial devices whether or not real UART hardware is behind them. On modern laptops those 32 entries are all phantom stubs; on servers with real 16550 UARTs, udev populates `manufacturer` / `vendorId` fields. We hide `ttyS*` entries with no udev metadata — real hardware survives, phantom stubs get filtered out.
* **Windows** — COM ports only exist when a driver is behind them, so no filtering is applied.

There's an escape hatch at the API layer (`SerialPort.listPorts({ showAll: true })`) for edge cases where a legit port gets filtered.

**Linux dialout pre-check.** Serial devices on Linux are group-owned by `dialout` (Debian / Ubuntu) or `uucp` (Arch / Fedora). Users not in the group hit `EACCES` on port open. Rather than wait for the failure and echo a hint into the terminal, the quick-connect dialog inspects the running process's group list on open and surfaces an amber warning banner above the port dropdown, with the exact `usermod` command in monospace so it's copy-pasteable. The check distinguishes three states:

* Process has the group → no banner, all clear
* User is listed in `/etc/group` but the running session hasn't picked it up → banner says to log out / log back in (or use `newgrp`)
* User isn't in any serial group at all → banner gives the `sudo usermod -a -G dialout $USER` fix

**Reconnect.** Same as SSH and telnet: the transport config is stashed on the terminal entry when the session is created, and pressing Enter on a disconnected serial tab replays it. If the USB dongle was unplugged and came back on a different path (`/dev/ttyUSB1` instead of `/dev/ttyUSB0`), reconnect fails cleanly with a "Port not found" hint; close and reconnect through the dialog to pick the new path.

---

## Settings

Settings persist across launches in the OS-native config path:

| Setting | Default | Description |
| --- | --- | --- |
| `theme` | `catppuccin-mocha` | One of thirty shipped themes |
| `terminalFontFamily` | Platform-specific† | Terminal font — selected from a curated list with availability detection |
| `terminalFontSize` | `14` | Terminal font size (8–32) |
| `sidebarFontSize` | `12` | Session tree font size (10–20) |
| `cursorStyle` | `block` | `block`, `underline`, or `bar` |
| `cursorBlink` | `true` | Blinking cursor |
| `scrollbackLines` | `10000` | Scrollback buffer depth (500–100,000) |
| `sidebarWidth` | `220` | Session tree width in pixels |
| `pasteWarningThreshold` | `1` | Line count that triggers paste confirmation |
| `defaultPasteLineDelayMs` | `0` | Default line-delay pacing for the paste dialog (ms; `0` disables pacing) |
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
* The vault is SSH-only. Telnet and serial sessions have no pre-auth and never touch the vault.

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

`serialport` is the one native dependency in the tree. `@electron/rebuild` (already wired into devDependencies) rebuilds its bindings against Electron's ABI on install. If you ever hit a "module did not self-register" error, run `npx electron-rebuild -f -w serialport` to force a rebuild. For packaged builds, both `node_modules/serialport/**` and `node_modules/@serialport/**` are unpacked from the asar so native `dlopen` can find the binary at runtime.

---

## Roadmap

### Shipped

* Multi-tab xterm.js terminal with per-tab state
* `TransportManager` abstraction with pluggable backends
* **SSH transport** — password, key file, SSH agent, keyboard-interactive authentication
* **Telnet transport** — RFC 854 IAC negotiation, NAWS resize, CRLF line-mode — tested against GNS3 / dynamips consoles and real terminal servers
* **Serial transport** — node-serialport-based, USB-to-serial + real UART, configurable framing / flow control / line endings, Send Break (single and burst), platform-aware port discovery, Linux dialout pre-check — tested against Cisco 2911 ROMMON and Prolific PL2303 adapters
* Protocol selector in session editor (SSH / telnet) and quick-connect dialog (SSH / telnet / serial)
* Legacy cipher/KEX support for older SSH devices
* Shell → exec channel fallback
* YAML/JSON session files with folder hierarchy and optional `protocol` field
* Connection dialog with auth method and credential selector
* Session editor (add, edit, duplicate, delete)
* Folder editor (add, rename, delete)
* Thirty themes with live switching
* Session search and filter
* Persistent settings (window bounds, theme, terminal prefs)
* Auto-reload last sessions file on launch
* Multi-line paste warning with preview
* Session capture to file (ANSI-stripped, works across all three transports)
* Encrypted credential vault (AES-256-GCM, PBKDF2, SQLite)
* Host pattern matching and score-based credential resolution
* OS keychain integration for auto-unlock
* Tab context menu (Close, Close Others, Close to the Right, Close All; plus Send Break entries on serial tabs)
* Terminal font zoom with persistence
* Active-connection confirmations on tab close, window close, and app quit
* Refit-on-reconnect
* Unified Settings dialog with live apply across open terminals
* Platform-aware terminal font defaults with availability detection
* Per-paste line-delay pacing for slow CLIs and serial console workflows
* Backpressured output handling for large remote dumps, with Ctrl+C drain to escape mid-flood

### Next (pre-release polish)

* Packaged installers published as GitHub Releases
* README and screenshot refresh for the Microsoft Store listing
* Code signing (Windows, macOS)
* Scrollback search (Ctrl+F)
* Session logging default filenames with timestamps
* Login actions / commands-on-connect (platform-aware from `DeviceType`)

### Planned

* Colored tabs (per-session or per-folder) for at-a-glance disambiguation across many open sessions
* Tab reordering via drag-and-drop
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