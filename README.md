# nterm-electron

Electron SSH terminal for network engineers. Pure JavaScript/TypeScript — no Python dependency.

Built from battle-tested components: the SSH layer is ported directly from the
[Terminal Telemetry VS Code extension](https://marketplace.visualstudio.com/items?itemName=ScottPeterman.terminal-telemetry),
with all auth logic, legacy device support, and exec channel fallback intact.

## Architecture

```
src/
├── main/
│   ├── main.ts              # Electron main process — window lifecycle, IPC routing
│   └── sshManager.ts        # SSH engine (ported from VS Code extension)
│                             #   - ssh2 connections with full auth chain
│                             #   - Shell → exec channel fallback
│                             #   - Legacy cipher/KEX for old network gear
│                             #   - Keyboard-interactive (multi-language)
│                             #   - Key file, agent, password auth
│                             #   - UUID-based session management
│                             #   - Diagnostic output
│
├── preload/
│   └── preload.ts            # Secure IPC bridge (window.nterm API)
│
└── renderer/
    ├── index.html            # Split layout: session tree + terminal tabs
    ├── renderer.js           # Frontend logic: xterm.js, tabs, dialogs
    └── styles.css            # CSS variable theming (dark + light)
```

### Data Flow

```
 Keystrokes                                    Device Output
     │                                              │
     ▼                                              ▼
 xterm.js ──► preload IPC ──► main.ts ──► sshManager ──► ssh2
 (renderer)   (bridge)        (routes)    (all SSH logic)  (wire)
                                              │
                                              ▼
                                         ssh:message IPC
                                              │
                                              ▼
                                    renderer (writes to xterm.js)
```

SSHManager sends all data through a single `ssh:message` IPC channel using the
same typed message protocol as the VS Code extension (output, connectionStatus,
error, metadata, diagnostic). The renderer routes by sessionId.

## Quick Start

```bash
npm install
npm start
```

This compiles TypeScript (`src/main/` and `src/preload/` → `dist/`) then launches Electron.

## Features

**SSH**
- Password, key file, SSH agent, keyboard-interactive auth
- Multi-language password prompt detection (English, Japanese, Chinese, Spanish)
- Legacy cipher/KEX for older Cisco IOS, Junos, Arista EOS
- Shell → exec channel fallback for devices that reject shell requests
- Retry-with-legacy-algorithms as a user action
- Auto-discovery of ~/.ssh/ keys (id_rsa, id_ed25519, id_ecdsa, id_dsa)
- Per-session diagnostics

**Terminal**
- xterm.js with full VT100/ANSI support
- Catppuccin Mocha (dark) and Catppuccin Latte (light) themes
- Theme toggle updates all open terminals
- Tab-per-session with status indicators (connecting/connected/error)
- Proper resize handling (terminal → PTY)

**Session Management**
- YAML/JSON session files (compatible with nterm/TerminalTelemetry format)
- Folder hierarchy with collapse/expand
- Session search/filter
- Connection dialog with auth method selector
- Native file browser for key files
- Double-click to connect (direct if credentials present, dialog if not)

**UI**
- Draggable splitter between session tree and terminal
- Status bar with connection state and session count
- Ctrl+N for new connection, Escape to close dialog
- Dark/light theme via CSS variables

## Connection Dialog Auth Methods

| Method | Password | Key File | Agent | Notes |
|--------|----------|----------|-------|-------|
| Password | ✅ | — | — | Also enables keyboard-interactive |
| Key File | — | ✅ | — | Browse button uses native OS dialog |
| SSH Agent | — | — | ✅ | Pageant (Win) / SSH_AUTH_SOCK (Unix) |
| Key + Password | ✅ | ✅ | — | For keys with passphrases + password auth |

All methods include legacy mode toggle for older network devices.

## Session File Format

```yaml
- folder_name: Lab Switches
  sessions:
    - display_name: usa-leaf-1
      host: 192.168.1.101
      port: 22
      DeviceType: arista_eos
      username: admin
      password: admin          # Optional — omit to prompt

    - display_name: core-rtr-1
      host: 192.168.1.1
      port: 22
      DeviceType: cisco_ios
      username: admin          # No password → opens connection dialog
```

## Roadmap

### Phase 1 — Credential Vault
- [ ] AES-256 encrypted vault (Node.js crypto)
- [ ] PBKDF2 key derivation (480K iterations)
- [ ] Pattern-based credential matching by hostname
- [ ] Vault manager UI

### Phase 2 — Intelligence (all JS, no Python)
- [ ] Sniffer pipeline (line accumulation → prompt detection → block extraction)
- [ ] Gutter bar (amber marks alongside terminal)
- [ ] tfsmjs integration (TextFSM parsing in JavaScript)
- [ ] Visualizer (structured tables from parsed output)
- [ ] Context menu (Copy Block, Export JSON/CSV/Markdown)

### Phase 3 — Telemetry
- [ ] Right-pane telemetry dashboard
- [ ] Per-device SSH polling via ssh2
- [ ] Interface throughput charts (ECharts)
- [ ] LLDP/CDP topology (SVG)
- [ ] CPU/memory gauges

### Phase 4 — Distribution
- [ ] electron-builder packaging (Win/Mac/Linux)
- [ ] Auto-update via electron-updater
- [ ] Code signing
- [ ] Installer branding

## Development

```bash
# Watch mode — recompiles TypeScript on save
npm run watch

# In another terminal, launch Electron
npx electron .

# Build for distribution
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG
npm run build:linux  # AppImage + deb
```

## Origin

The SSH layer in this project was ported from the
[Terminal Telemetry VS Code extension](https://marketplace.visualstudio.com/items?itemName=ScottPeterman.terminal-telemetry).
All auth logic, legacy device support, exec channel fallback, and the UUID-based
message protocol were preserved. The port involved two changes:

1. `vscode.Webview.postMessage()` → `BrowserWindow.webContents.send()`
2. VS Code logger → `electron-log`

Everything else — the battle-tested SSH handling for hundreds of real network
devices — carried over unchanged.

## License

GPL-3.0
