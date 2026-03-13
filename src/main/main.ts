// main.ts — Electron main process
// Owns: window lifecycle, IPC registration, file dialogs
// Delegates: all SSH logic to SSHManager instances

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import log from 'electron-log';
import { SSHManager, SSHConnectionConfig } from './sshManager';

// ─── Session Registry ────────────────────────────────────────
// Each SSH session keyed by UUID. SSHManager handles all SSH logic;
// main.ts just routes IPC to the right instance.
const sessions = new Map<string, SSHManager>();

let mainWindow: BrowserWindow | null = null;

// ─── Logging ─────────────────────────────────────────────────
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

// ─── Window ──────────────────────────────────────────────────
function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 500,
        title: 'nterm',
        backgroundColor: '#1e1e2e',
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Load renderer HTML (not compiled — lives in src/renderer/)
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        // Clean up all SSH sessions
        for (const [id, manager] of sessions) {
            manager.disconnect();
        }
        sessions.clear();
        mainWindow = null;
    });

    log.info('Main window created');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

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
        return { filePath, sessions: parsed };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        log.error(`Failed to load sessions file: ${msg}`);
        return { error: msg };
    }
});

// ─── IPC: SSH Connect ───────────────────────────────────────
// Renderer sends session config; we create an SSHManager and let it handle everything.
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
