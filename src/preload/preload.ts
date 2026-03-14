// preload.ts — Secure IPC bridge (window.nterm API)
// Exposes typed methods to renderer; all comms go through ipcRenderer.
// No Node.js APIs leak to the renderer.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('nterm', {
    // ─── SSH ─────────────────────────────────────────────────
    connect: (sessionId: string, config: any) =>
        ipcRenderer.invoke('ssh:connect', { sessionId, config }),

    disconnect: (sessionId: string) =>
        ipcRenderer.invoke('ssh:disconnect', { sessionId }),

    send: (sessionId: string, data: string) =>
        ipcRenderer.send('ssh:input', { sessionId, data }),

    resize: (sessionId: string, cols: number, rows: number) =>
        ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),

    retryLegacy: (sessionId: string) =>
        ipcRenderer.invoke('ssh:retry-legacy', { sessionId }),

    diagnostics: (sessionId: string) =>
        ipcRenderer.invoke('ssh:diagnostics', { sessionId }),

    listSessions: () =>
        ipcRenderer.invoke('ssh:list-sessions'),

    // ─── SSH Messages (from SSHManager → renderer) ──────────
    onMessage: (callback: (message: any) => void) => {
        ipcRenderer.on('ssh:message', (_event, message) => callback(message));
    },

    // ─── Sessions ────────────────────────────────────────────
    loadSessionsFile: () =>
        ipcRenderer.invoke('sessions:load-file'),

    loadLastSessionsFile: () =>
        ipcRenderer.invoke('sessions:load-last'),

    // ─── Settings ────────────────────────────────────────────
    getSettings: () =>
        ipcRenderer.invoke('settings:get-all'),

    getSetting: (key: string) =>
        ipcRenderer.invoke('settings:get', { key }),

    setSetting: (key: string, value: any) =>
        ipcRenderer.invoke('settings:set', { key, value }),

    setSettings: (settings: Record<string, any>) =>
        ipcRenderer.invoke('settings:set-multiple', { settings }),

    resetSetting: (key: string) =>
        ipcRenderer.invoke('settings:reset', { key }),

    resetAllSettings: () =>
        ipcRenderer.invoke('settings:reset-all'),

    getSettingsPath: () =>
        ipcRenderer.invoke('settings:path'),

    // ─── Dialogs ─────────────────────────────────────────────
    selectKeyFile: () =>
        ipcRenderer.invoke('dialog:select-keyfile'),

    // ─── DevTools ────────────────────────────────────────────
    openDevTools: () =>
        ipcRenderer.invoke('devtools:open'),

    // ─── App Info ────────────────────────────────────────────
    getVersionInfo: () =>
        ipcRenderer.invoke('app:version-info'),

    // ─── Menu Events (from main process menu → renderer) ────
    onShowAbout: (callback: () => void) => {
        ipcRenderer.on('menu:show-about', () => callback());
    },

    onMenuNewConnection: (callback: () => void) => {
        ipcRenderer.on('menu:new-connection', () => callback());
    },

    onMenuLoadSessions: (callback: () => void) => {
        ipcRenderer.on('menu:load-sessions', () => callback());
    },
});