// main.ts — Electron main process
// Owns: window lifecycle, IPC registration, file dialogs, settings persistence
// Delegates: all SSH logic to SSHManager instances

import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import log from 'electron-log';
import { SSHManager, SSHConnectionConfig } from './sshManager';
import { TelnetManager } from './telnetManager';
import { SerialManager, SerialConnectionConfig } from './serialManager';
import { TransportManager, TransportConfig } from './transportManager';
import { registerVaultIpc, getVaultStore, enrichSshConfig, tryAutoUnlock } from './vaultIpc';
import { probeLanAccess } from './networkCheck';

import {
    getSetting,
    setSetting,
    getAllSettings,
    setMultiple,
    resetSetting,
    resetAll,
    getStorePath,
    getDefaults,
    WindowBounds,
} from './settings';

// ─── Session Registry ────────────────────────────────────────
const sessions = new Map<string, TransportManager>();

// ─── Capture File Handle Registry ────────────────────────────
// Tracks open file descriptors for active session captures.
// Key: sessionId, Value: { fd, filePath }
const captureHandles = new Map<string, { fd: number; filePath: string }>();

let mainWindow: BrowserWindow | null = null;

// ─── Exit Confirmation Flag ──────────────────────────────────
// Set once the user has confirmed they want to proceed with closing
// the window or quitting the app. Prevents double-prompts when one
// path (e.g. File→Exit on Linux) triggers both 'close' and 'before-quit'.
// Reset in the window's 'closed' handler so a reopened window (macOS
// activate path) starts fresh.
let exitConfirmed = false;

// ─── Logging ─────────────────────────────────────────────────
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'debug';

// ─── Window ──────────────────────────────────────────────────
function createWindow(): void {
    const savedBounds: WindowBounds = getSetting('windowBounds');
    const savedTheme = getSetting('theme');

    // Map theme names to initial window backgrounds (avoids white flash on launch)
    const themeBackgrounds: Record<string, string> = {
        'catppuccin-mocha': '#1e1e2e',
        'catppuccin-latte': '#eff1f5',
        'darcula':          '#2b2b2b',
        'nord':             '#2e3440',
        'gruvbox-dark':     '#282828',
        'gruvbox-light':    '#fbf1c7',
        'gruvbox-hybrid':   '#282828',
        'solarized-dark':   '#002b36',
        'solarized-light':  '#fdf6e3',
        'solarized-hybrid': '#002b36',
        'corporate':        '#f5f6fa',
        'corporate-dark':   '#0f1a2e',
    };
    const windowBg = themeBackgrounds[savedTheme] || '#1e1e2e';

    mainWindow = new BrowserWindow({
        // Use saved position if available, otherwise let OS decide
        ...(savedBounds.x !== undefined && savedBounds.y !== undefined
            ? { x: savedBounds.x, y: savedBounds.y }
            : {}),
        width: savedBounds.width,
        height: savedBounds.height,
        minWidth: 800,
        minHeight: 500,
        title: 'nterm-js',
        backgroundColor: windowBg,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
            icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    });

    if (savedBounds.maximized) {
        mainWindow.maximize();
    }

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

    // TODO: Remove after debugging — auto-open DevTools on launch
    // mainWindow.webContents.openDevTools({ mode: 'detach' });

    // ─── Persist window geometry on change ───────────────────
    let boundsTimer: ReturnType<typeof setTimeout> | null = null;

    function saveWindowBounds() {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (boundsTimer) clearTimeout(boundsTimer);
        boundsTimer = setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            const isMaximized = mainWindow.isMaximized();
            if (!isMaximized) {
                const bounds = mainWindow.getBounds();
                setSetting('windowBounds', {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                    maximized: false,
                });
            } else {
                const current = getSetting('windowBounds');
                setSetting('windowBounds', { ...current, maximized: true });
            }
        }, 500);
    }

    mainWindow.on('resize', saveWindowBounds);
    mainWindow.on('move', saveWindowBounds);
    mainWindow.on('maximize', saveWindowBounds);
    mainWindow.on('unmaximize', saveWindowBounds);

    // ─── Close Confirmation ──────────────────────────────────
    // Warn before the window closes (X button, Alt+F4, Cmd+W on mac app menu,
    // etc.) if any SSH sessions are still connected. Shares the exitConfirmed
    // flag with the before-quit handler so the dialog never fires twice.
    mainWindow.on('close', (e) => {
        if (exitConfirmed) return;

        const activeCount = Array.from(sessions.values())
            .filter(s => s.isConnected())
            .length;

        if (activeCount === 0) return;

        e.preventDefault();

        dialog.showMessageBox(mainWindow!, {
            type: 'warning',
            buttons: ['Close Window', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Close Window',
            message: `${activeCount} active SSH ${activeCount === 1 ? 'session is' : 'sessions are'} connected.`,
            detail: 'Closing the window will disconnect all sessions. Continue?',
        }).then(result => {
            if (result.response === 0) {
                exitConfirmed = true;
                mainWindow?.close();
            }
        });
    });

    mainWindow.on('closed', () => {
        // Close all active capture file handles
        for (const [id, handle] of captureHandles) {
            try { fs.closeSync(handle.fd); } catch (e) { /* ignore */ }
        }
        captureHandles.clear();

        for (const [id, manager] of sessions) {
            manager.disconnect();
        }
        sessions.clear();
        mainWindow = null;

        // Reset confirmation flag so a re-opened window (macOS activate path)
        // starts with a fresh check.
        exitConfirmed = false;
    });

    buildMenu();
    log.info('Main window created');
}

// ─── Application Menu ───────────────────────────────────────
function buildMenu(): void {
    const isMac = process.platform === 'darwin';

    const template: Electron.MenuItemConstructorOptions[] = [
        // File
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Connection',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => mainWindow?.webContents.send('menu:new-connection'),
                },
                {
                    label: 'Load Sessions...',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => mainWindow?.webContents.send('menu:load-sessions'),
                },
                {
                    label: 'Settings…',
                    accelerator: 'CmdOrCtrl+,',
                    click: () => mainWindow?.webContents.send('menu:open-settings'),
                },
                { type: 'separator' },
                {
                    label: 'Close Tab',
                    accelerator: 'CmdOrCtrl+W',
                    click: () => mainWindow?.webContents.send('menu:close-tab'),
                },
                {
                    label: 'Close All Tabs',
                    accelerator: 'CmdOrCtrl+Shift+W',
                    click: () => mainWindow?.webContents.send('menu:close-all-tabs'),
                },
                ...(isMac
                    ? []
                    : [
                          { type: 'separator' as const },
                          { label: 'Exit', role: 'quit' as const },
                      ]),
            ],
        },

        // Edit
        {
            label: 'Edit',
            submenu: [
                { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' as const },
                { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' as const },
                { type: 'separator' },
                { label: 'Select All', accelerator: 'CmdOrCtrl+A', role: 'selectAll' as const },
            ],
        },

        // View
        {
            label: 'View',
            submenu: [
                { label: 'Reload', role: 'reload' as const },
                { label: 'Force Reload', role: 'forceReload' as const },
                { type: 'separator' },
                {
                    label: 'Increase Terminal Font',
                    accelerator: 'CmdOrCtrl+=',
                    click: () => mainWindow?.webContents.send('menu:terminal-zoom-in'),
                },
                {
                    label: 'Decrease Terminal Font',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => mainWindow?.webContents.send('menu:terminal-zoom-out'),
                },
                {
                    label: 'Reset Terminal Font',
                    accelerator: 'CmdOrCtrl+0',
                    click: () => mainWindow?.webContents.send('menu:terminal-zoom-reset'),
                },
                { type: 'separator' },
                { label: 'Toggle Full Screen', role: 'togglefullscreen' as const },
                { type: 'separator' },
                {
                    label: 'Developer Tools',
                    accelerator: 'F12',
                    click: () => mainWindow?.webContents.toggleDevTools(),
                },
            ],
        },

        // Window
        {
            label: 'Window',
            submenu: [
                { label: 'Minimize', role: 'minimize' as const },
                ...(isMac
                    ? [
                        { label: 'Zoom', role: 'zoom' as const },
                        { type: 'separator' as const },
                        { label: 'Bring All to Front', role: 'front' as const },
                      ]
                    : []),
            ],
        },

        // Help
        {
            label: 'Help',
            submenu: [
                {
                    label: 'GitHub Repository',
                    click: () => shell.openExternal('https://github.com/scottpeterman/nterm-js'),
                },
                {
                    label: 'Report Issue',
                    click: () => shell.openExternal('https://github.com/scottpeterman/nterm-js/issues'),
                },
                { type: 'separator' },
                {
                    label: 'About nterm-js',
                    click: () => mainWindow?.webContents.send('menu:show-about'),
                },
            ],
        },
    ];

    // macOS: prepend app menu
    if (isMac) {
        template.unshift({
            label: app.name,
            submenu: [
                {
                    label: 'About nterm-js',
                    click: () => mainWindow?.webContents.send('menu:show-about'),
                },
                { type: 'separator' },
                { role: 'services' as const },
                { type: 'separator' },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' },
                { role: 'quit' as const },
            ],
        });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
    registerVaultIpc();
    createWindow();

    // After renderer finishes loading, try auto-unlock and push
    // vault state so vault-ui.js can show the unlock prompt if needed.
    mainWindow?.webContents.once('did-finish-load', () => {
        if (!mainWindow) return;

        const store = getVaultStore();

        // Try keychain auto-unlock first (silent — no UI)
        if (store.isInitialized && !store.isUnlocked) {
            tryAutoUnlock(mainWindow);
        }

        // Push initial state to renderer regardless of outcome.
        // vault-ui.js onVaultStateChanged handler will:
        //   - If unlocked (auto-unlock worked): hydrate credential list
        //   - If initialized + locked: show unlock prompt
        //   - If not initialized: do nothing (first run)
        mainWindow.webContents.send('vault:state-changed', {
            initialized: store.isInitialized,
            unlocked: store.isUnlocked,
            credentialCount: store.isUnlocked ? store.credentialCount : 0,
            keychainAvailable: true,  // safe default; vault-ui.js will poll for accurate value
        });
    });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── Quit Confirmation ───────────────────────────────────────
// Warn before quitting the app if any SSH sessions are still connected.
// The close handler on mainWindow covers the X-button / Alt-F4 path;
// this covers explicit File→Exit / Cmd+Q / role: 'quit' invocations.
// Both share the exitConfirmed flag declared at the top of this file.

app.on('before-quit', (e) => {
    if (exitConfirmed) return;

    const activeCount = Array.from(sessions.values())
        .filter(s => s.isConnected())
        .length;

    if (activeCount === 0) return;

    e.preventDefault();

    const parent = mainWindow ?? undefined;
    dialog.showMessageBox(parent!, {
        type: 'warning',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Quit nterm-js',
        message: `${activeCount} active SSH ${activeCount === 1 ? 'session is' : 'sessions are'} connected.`,
        detail: 'Quitting will close all connections. Continue?',
    }).then(result => {
        if (result.response === 0) {
            exitConfirmed = true;
            app.quit();
        }
    });
});

// ─── IPC: Settings ──────────────────────────────────────────

ipcMain.handle('settings:get-all', async () => {
    return getAllSettings();
});

ipcMain.handle('settings:get', async (event, { key }: { key: string }) => {
    return getSetting(key as any);
});

ipcMain.handle('settings:set', async (event, { key, value }: { key: string; value: any }) => {
    setSetting(key as any, value);
    return { success: true };
});

ipcMain.handle('settings:set-multiple', async (event, { settings }: { settings: Record<string, any> }) => {
    setMultiple(settings);
    return { success: true };
});

ipcMain.handle('settings:reset', async (event, { key }: { key: string }) => {
    const value = resetSetting(key as any);
    return { key, value };
});

ipcMain.handle('settings:reset-all', async () => {
    return resetAll();
});

ipcMain.handle('settings:path', async () => {
    return getStorePath();
});

ipcMain.handle('settings:get-defaults', async () => {
    return getDefaults();
});

// ─── IPC: Load Sessions File ────────────────────────────────
ipcMain.handle('sessions:load-file', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Sessions YAML',
        filters: [
            { name: 'YAML Files', extensions: ['yaml', 'yml'] },
            { name: 'JSON Files', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = filePath.endsWith('.json')
            ? JSON.parse(content)
            : yaml.load(content);
        log.info(`Loaded sessions from ${filePath}`);

        // Remember this path for auto-load on next launch
        setSetting('lastSessionsFile', filePath);

        return { filePath, sessions: parsed };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to load sessions file: ${msg}`);
        return { error: msg };
    }
});

// ─── IPC: Auto-load Last Sessions File ──────────────────────
ipcMain.handle('sessions:load-last', async () => {
    const lastPath = getSetting('lastSessionsFile');
    if (!lastPath) return null;

    try {
        const content = fs.readFileSync(lastPath, 'utf8');
        const parsed = lastPath.endsWith('.json')
            ? JSON.parse(content)
            : yaml.load(content);
        log.info(`Auto-loaded sessions from ${lastPath}`);
        return { filePath: lastPath, sessions: parsed };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.warn(`Failed to auto-load last sessions file: ${msg}`);
        setSetting('lastSessionsFile', '');
        return null;
    }
});

// ─── IPC: Save Sessions File ────────────────────────────────
ipcMain.handle('sessions:save', async (_event, { sessions }: { sessions: any }) => {
    const filePath = getSetting('lastSessionsFile');
    if (!filePath) {
        return { error: 'No sessions file loaded' };
    }

    try {
        const isJson = filePath.endsWith('.json');
        const content = isJson
            ? JSON.stringify(sessions, null, 2)
            : yaml.dump(sessions, { noRefs: true, lineWidth: -1, quotingType: '"' });

        fs.writeFileSync(filePath, content, 'utf8');
        log.info(`Sessions saved to ${filePath}`);
        return { success: true, filePath };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to save sessions: ${msg}`);
        return { error: msg };
    }
});

// ─── IPC: Save Sessions As (new file) ─────────────────────
ipcMain.handle('sessions:save-as', async (_event, { sessions }: { sessions: any }) => {
    if (!mainWindow) return { error: 'No window' };

    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Sessions As',
        defaultPath: 'sessions.yaml',
        filters: [
            { name: 'YAML Files', extensions: ['yaml', 'yml'] },
            { name: 'JSON Files', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });

    if (result.canceled || !result.filePath) return null;

    const filePath = result.filePath;
    try {
        const isJson = filePath.endsWith('.json');
        const content = isJson
            ? JSON.stringify(sessions, null, 2)
            : yaml.dump(sessions, { noRefs: true, lineWidth: -1, quotingType: '"' });

        fs.writeFileSync(filePath, content, 'utf8');

        // Remember this path for future saves and auto-load
        setSetting('lastSessionsFile', filePath);

        log.info(`Sessions saved as ${filePath}`);
        return { success: true, filePath };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to save sessions: ${msg}`);
        return { error: msg };
    }
});
// ─── IPC: Connect (SSH / Telnet dispatch) ───────────────────
ipcMain.handle('ssh:connect', async (event, { sessionId, config }: { sessionId: string; config: TransportConfig }) => {
    if (!mainWindow) return { error: 'No window' };

    try {
        const protocol = config.protocol || 'ssh';

        if (protocol === 'telnet') {
            const manager = new TelnetManager(mainWindow, sessionId, sessionId);
            sessions.set(sessionId, manager);
            manager.connectToHost(config);
            log.info(`Telnet session created: ${sessionId} → ${config.host}:${config.port}`);
            return { success: true, sessionId };
        }

        if (protocol === 'serial') {
            const manager = new SerialManager(mainWindow, sessionId, sessionId);
            sessions.set(sessionId, manager);
            const sConfig = config as SerialConnectionConfig;
            manager.connectToHost(sConfig);
            log.info(`Serial session created: ${sessionId} → ${sConfig.path} @ ${sConfig.baudRate || 9600}`);
            return { success: true, sessionId };
        }

        // Default: SSH (protocol === 'ssh' or absent for back-compat)
        const sshConfig = enrichSshConfig(config as SSHConnectionConfig);  // inject vault creds
        const manager = new SSHManager(mainWindow, sessionId, sessionId);
        sessions.set(sessionId, manager);
        manager.connectToHost(sshConfig);
        log.info(`SSH session created: ${sessionId} → ${config.host}:${config.port}`);
        return { success: true, sessionId };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to create session: ${msg}`);
        return { error: msg };
    }
});

// ─── IPC: SSH Input (keystrokes from renderer) ──────────────
ipcMain.on('ssh:input', (event, { sessionId, data }: { sessionId: string; data: string }) => {
    const manager = sessions.get(sessionId);
    if (manager) {
        manager.writeData(data);
    }
});

// ─── IPC: SSH Resize ────────────────────────────────────────
ipcMain.on('ssh:resize', (event, { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number }) => {
    const manager = sessions.get(sessionId);
    if (manager) {
        manager.setDimensions(cols, rows);
    }
});

// ─── IPC: SSH Disconnect ────────────────────────────────────
ipcMain.handle('ssh:disconnect', async (event, { sessionId }: { sessionId: string }) => {
    const manager = sessions.get(sessionId);
    if (manager) {
        manager.disconnect();
        sessions.delete(sessionId);
        log.info(`SSH session disconnected: ${sessionId}`);
    }
    return { success: true };
});

// ─── IPC: Retry with Legacy Algorithms ──────────────────────
ipcMain.handle('ssh:retry-legacy', async (event, { sessionId }: { sessionId: string }) => {
    const manager = sessions.get(sessionId);
    if (manager) {
        manager.handleMessage({ type: 'retry-with-legacy', payload: {} });
        return { success: true };
    }
    return { error: 'Session not found' };
});

// ─── IPC: Request Diagnostics ───────────────────────────────
ipcMain.handle('ssh:diagnostics', async (event, { sessionId }: { sessionId: string }) => {
    const manager = sessions.get(sessionId);
    if (manager) {
        return manager.getDebugInfo();
    }
    return { error: 'Session not found' };
});

// ─── IPC: List Active Sessions ──────────────────────────────
ipcMain.handle('ssh:list-sessions', async () => {
    const list: any[] = [];
    for (const [id, manager] of sessions) {
        list.push({ sessionId: id, ...manager.getDebugInfo() });
    }
    return list;
});

// ─── IPC: List Serial Ports ─────────────────────────────────
// Returns { ports: [...], warning?: string } or { error: string }.
// The optional `warning` field surfaces platform-specific issues that
// won't cause enumeration to fail but will cause connect to fail —
// most notably "user not in dialout group" on Linux.
ipcMain.handle('serial:list-ports', async (_event, { showAll }: { showAll?: boolean } = {}) => {
    try {
        const ports = await SerialManager.listPorts(!!showAll);
        const response: { ports: any[]; warning?: string } = { ports };

        // Linux: pre-flight permission check so the UI can warn about
        // missing group membership before the user tries to connect.
        const access = SerialManager.checkLinuxSerialAccess();
        if (!access.hasAccess && access.missingGroup) {
            response.warning = access.needsRelogin
                ? `You're in the "${access.missingGroup}" group but this login session doesn't know yet. Log out and back in — or run "newgrp ${access.missingGroup}" in a shell and relaunch nterm-js — to pick up the change.`
                : `Your user is not in the "${access.missingGroup}" group, so serial ports will fail to open with permission denied.\nFix: sudo usermod -a -G ${access.missingGroup} $USER   (then log out and back in)`;
        }

        return response;
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Serial port enumeration failed: ${msg}`);
        return { error: msg };
    }
});

// ─── IPC: Send Serial Break ─────────────────────────────────
// burst=false → one 1.5s pulse (standard ROMMON drop)
// burst=true  → five 500ms pulses with 100ms gaps (stubborn USB-serial)
ipcMain.handle('serial:send-break', async (_event, { sessionId, burst }: { sessionId: string; burst?: boolean }) => {
    const manager = sessions.get(sessionId);
    if (!manager) return { error: 'Session not found' };
    if (!(manager instanceof SerialManager)) return { error: 'Not a serial session' };
    manager.sendBreak(burst ? 5 : 1);
    return { success: true };
});

// ─── IPC: Open DevTools ─────────────────────────────────────
ipcMain.handle('devtools:open', async () => {
    log.info('DevTools IPC handler triggered');
    if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
    }
});

// ─── IPC: Read Key File Content (for vault editor) ──────────
ipcMain.handle('dialog:read-keyfile', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select SSH Private Key',
        defaultPath: path.join(require('os').homedir(), '.ssh'),
        filters: [
            { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    try {
        const content = fs.readFileSync(result.filePaths[0], 'utf8');
        return { path: result.filePaths[0], content };
    } catch (err) {
        return { error: err instanceof Error ? err.message : 'Failed to read key file' };
    }
});

// ─── IPC: Browse for Key File ───────────────────────────────
ipcMain.handle('dialog:select-keyfile', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select SSH Private Key',
        defaultPath: path.join(require('os').homedir(), '.ssh'),
        filters: [
            { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

// ─── IPC: App Version Info ──────────────────────────────────
ipcMain.handle('app:version-info', async () => {
    return {
        appVersion: app.getVersion(),
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
    };
});

ipcMain.handle('network:check-lan-access', async () => {
    return await probeLanAccess();
});
// ─── IPC: Session Capture ───────────────────────────────────

// Capture — Select File (native save dialog)
ipcMain.handle('capture:select-file', async (event, { defaultName }: { defaultName: string }) => {
    if (!mainWindow) return null;

    const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Session Capture',
        defaultPath: defaultName,
        filters: [
            { name: 'Log Files', extensions: ['log', 'txt'] },
            { name: 'All Files', extensions: ['*'] },
        ],
    });

    if (result.canceled || !result.filePath) return null;
    return result.filePath;
});

// Capture — Start (open file handle, write header)
ipcMain.handle('capture:start', async (event, { sessionId, filePath }: { sessionId: string; filePath: string }) => {
    // Close any existing capture for this session
    const existing = captureHandles.get(sessionId);
    if (existing) {
        try { fs.closeSync(existing.fd); } catch (e) { /* ignore */ }
        captureHandles.delete(sessionId);
    }

    try {
        // Open for append — creates file if it doesn't exist
        const fd = fs.openSync(filePath, 'a');

        // Write header
        const timestamp = new Date().toISOString();
        const header = `\n=== Session capture started: ${timestamp} ===\n\n`;
        fs.writeSync(fd, header);

        captureHandles.set(sessionId, { fd, filePath });
        log.info(`Capture started: ${sessionId} → ${filePath}`);
        return { success: true, filePath };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to start capture: ${msg}`);
        return { error: msg };
    }
});

// Capture — Write (fire-and-forget, uses .on not .handle)
ipcMain.on('capture:write', (event, { sessionId, data }: { sessionId: string; data: string }) => {
    const handle = captureHandles.get(sessionId);
    if (!handle) return;

    try {
        fs.writeSync(handle.fd, data);
    } catch (err) {
        // If write fails (disk full, etc.), stop the capture
        log.error(`Capture write failed for ${sessionId}: ${err}`);
        try { fs.closeSync(handle.fd); } catch (e) { /* ignore */ }
        captureHandles.delete(sessionId);
        // Notify renderer that capture died
        if (mainWindow) {
            mainWindow.webContents.send('capture:error', { sessionId, error: 'Write failed' });
        }
    }
});

// Capture — Stop (write footer, close file handle)
ipcMain.handle('capture:stop', async (event, { sessionId }: { sessionId: string }) => {
    const handle = captureHandles.get(sessionId);
    if (!handle) return { success: true };

    try {
        // Write footer
        const timestamp = new Date().toISOString();
        const footer = `\n\n=== Session capture stopped: ${timestamp} ===\n`;
        fs.writeSync(handle.fd, footer);

        fs.closeSync(handle.fd);
        captureHandles.delete(sessionId);
        log.info(`Capture stopped: ${sessionId}`);
        return { success: true };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        captureHandles.delete(sessionId);
        return { error: msg };
    }
});