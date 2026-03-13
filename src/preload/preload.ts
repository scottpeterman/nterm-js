// preload.ts — Secure IPC bridge
// Exposes window.nterm to the renderer. No raw Node.js leaks.
// Maps cleanly to the SSHManager message protocol.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nterm', {

    // ─── Sessions File ──────────────────────────────────────
    loadSessionsFile: () => ipcRenderer.invoke('sessions:load-file'),

    // ─── SSH Lifecycle ──────────────────────────────────────
    connect: (sessionId: string, config: any) =>
        ipcRenderer.invoke('ssh:connect', { sessionId, config }),

    disconnect: (sessionId: string) =>
        ipcRenderer.invoke('ssh:disconnect', { sessionId }),

    retryLegacy: (sessionId: string) =>
        ipcRenderer.invoke('ssh:retry-legacy', { sessionId }),

    diagnostics: (sessionId: string) =>
        ipcRenderer.invoke('ssh:diagnostics', { sessionId }),

    listSessions: () =>
        ipcRenderer.invoke('ssh:list-sessions'),

    // ─── SSH Data ───────────────────────────────────────────
    send: (sessionId: string, data: string) =>
        ipcRenderer.send('ssh:input', { sessionId, data }),

    resize: (sessionId: string, cols: number, rows: number) =>
        ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),

    // ─── Events from SSHManager ─────────────────────────────
    // SSHManager sends all messages through 'ssh:message' channel.
    // The renderer filters by sessionId and message type.
    onMessage: (callback: (message: any) => void) => {
        ipcRenderer.on('ssh:message', (event, message) => callback(message));
    },

    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('ssh:message');
    },

    // ─── File Dialogs ───────────────────────────────────────
    selectKeyFile: () => ipcRenderer.invoke('dialog:select-keyfile'),
});
