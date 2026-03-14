// main.ts — Electron main process
// Owns: window lifecycle, IPC registration, file dialogs, settings persistence
// Delegates: all SSH logic to SSHManager instances

import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import log from 'electron-log';
import { SSHManager, SSHConnectionConfig } from './sshManager';
import {
    getSetting,
    setSetting,
    getAllSettings,
    setMultiple,
    resetSetting,
    resetAll,
    getStorePath,
    WindowBounds,
} from './settings';

// ─── Session Registry ────────────────────────────────────────
const sessions = new Map<string, SSHManager>();

let mainWindow: BrowserWindow | null = null;

// ─── Logging ─────────────────────────────────────────────────
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

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
        'solarized-dark':   '#002b36',
        'solarized-light':  '#fdf6e3',
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

    mainWindow.on('closed', () => {
        for (const [id, manager] of sessions) {
            manager.disconnect();
        }
        sessions.clear();
        mainWindow = null;
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
                { type: 'separator' },
                isMac
                    ? { label: 'Close Window', role: 'close' as const }
                    : { label: 'Exit', role: 'quit' as const },
            ],
        },

        // Edit
        {
            label: 'Edit',
            submenu: [
                { label: 'Copy', accelerator: 'CmdOrCtrl+Shift+C', role: 'copy' as const },
                { label: 'Paste', accelerator: 'CmdOrCtrl+Shift+V', role: 'paste' as const },
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
                { label: 'Zoom In', role: 'zoomIn' as const },
                { label: 'Zoom Out', role: 'zoomOut' as const },
                { label: 'Reset Zoom', role: 'resetZoom' as const },
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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

// ─── IPC: SSH Connect ───────────────────────────────────────
ipcMain.handle('ssh:connect', async (event, { sessionId, config }: { sessionId: string; config: SSHConnectionConfig }) => {
    if (!mainWindow) return { error: 'No window' };

    try {
        const manager = new SSHManager(mainWindow, sessionId, sessionId);
        sessions.set(sessionId, manager);

        manager.connectToHost(config);

        log.info(`SSH session created: ${sessionId} → ${config.host}:${config.port}`);
        return { success: true, sessionId };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to create SSH session: ${msg}`);
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

// ─── IPC: Open DevTools ─────────────────────────────────────
ipcMain.handle('devtools:open', async () => {
    log.info('DevTools IPC handler triggered');
    if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
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