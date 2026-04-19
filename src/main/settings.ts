// settings.ts — Cross-platform persistent settings
// Lives in: src/main/settings.ts
// Storage: OS-native userData path via electron-store
//   Windows:  %APPDATA%/nterm-js/config.json
//   macOS:    ~/Library/Application Support/nterm-js/config.json
//   Linux:    ~/.config/nterm-js/config.json
//
// Main process owns the store. Renderer reads/writes through IPC.
//
// NOTE: electron-store v9+ ships ESM-only types that don't resolve
// correctly in CJS Electron projects. We use require() + manual
// typing to sidestep the issue entirely.

import log from 'electron-log';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Store = require('electron-store');

// ─── Schema ──────────────────────────────────────────────────

export interface WindowBounds {
    x: number | undefined;
    y: number | undefined;
    width: number;
    height: number;
    maximized: boolean;
}

export interface NtermSettings {
    // Appearance
    theme: string;
    sidebarWidth: number;
    sidebarFontSize: number;
    terminalFontSize: number;
    terminalFontFamily: string;

    // Window geometry (restored on launch)
    windowBounds: WindowBounds;

    // Session defaults
    lastSessionsFile: string;
    defaultUsername: string;
    defaultAuthMethod: 'password' | 'keyfile' | 'agent' | 'key-and-password';
    defaultPrivateKeyPath: string;
    defaultLegacyMode: boolean;

    // Terminal behavior
    scrollbackLines: number;
    cursorStyle: 'block' | 'underline' | 'bar';
    cursorBlink: boolean;
    pasteWarningThreshold: number;

    // Future-proofing: opaque bags for Phase 2+ features
    sniffer: Record<string, unknown>;
    vault: Record<string, unknown>;
}

// ─── Defaults ────────────────────────────────────────────────

/**
 * Default terminal font per platform. First-run experience matters —
 * shipping 'Cascadia Mono' as the cross-platform default means Linux
 * users see proportional fallback until they open Settings, which looks
 * broken. Pick a font that ships with each OS.
 */
function defaultTerminalFont(): string {
    switch (process.platform) {
        case 'darwin': return 'Menlo';
        case 'win32': return 'Cascadia Mono';
        default:       return 'DejaVu Sans Mono';
    }
}

const defaults: NtermSettings = {
    theme: 'catppuccin-mocha',
    sidebarWidth: 220,
    sidebarFontSize: 12,
    terminalFontSize: 14,
    terminalFontFamily: defaultTerminalFont(),

    windowBounds: {
        x: undefined,
        y: undefined,
        width: 1400,
        height: 900,
        maximized: false,
    },

    lastSessionsFile: '',
    defaultUsername: '',
    defaultAuthMethod: 'password',
    defaultPrivateKeyPath: '',
    defaultLegacyMode: false,

    scrollbackLines: 10000,
    cursorStyle: 'block',
    cursorBlink: true,
    pasteWarningThreshold: 1,

    sniffer: {},
    vault: {},
};

// ─── Store Instance ──────────────────────────────────────────
// Typed as any to avoid electron-store's broken ESM declarations.
// All public functions below enforce NtermSettings types at the boundary.

const store: any = new Store({
    name: 'config',
    defaults,
    clearInvalidConfig: true,

    schema: {
        theme: {
            type: 'string',
        },
        sidebarWidth: {
            type: 'number',
            minimum: 80,
            maximum: 600,
        },
        sidebarFontSize: {
            type: 'number',
            minimum: 10,
            maximum: 20,
        },
        terminalFontSize: {
            type: 'number',
            minimum: 8,
            maximum: 32,
        },
        terminalFontFamily: {
            type: 'string',
        },
        windowBounds: {
            type: 'object',
            properties: {
                x: { type: ['number', 'null'] },
                y: { type: ['number', 'null'] },
                width: { type: 'number', minimum: 400 },
                height: { type: 'number', minimum: 300 },
                maximized: { type: 'boolean' },
            },
        },
        lastSessionsFile: { type: 'string' },
        defaultUsername: { type: 'string' },
        defaultAuthMethod: {
            type: 'string',
            enum: ['password', 'keyfile', 'agent', 'key-and-password'],
        },
        defaultPrivateKeyPath: { type: 'string' },
        defaultLegacyMode: { type: 'boolean' },
        scrollbackLines: {
            type: 'number',
            minimum: 500,
            maximum: 100000,
        },
        cursorStyle: {
            type: 'string',
            enum: ['block', 'underline', 'bar'],
        },
        cursorBlink: { type: 'boolean' },
        pasteWarningThreshold: {
            type: 'number',
            minimum: 1,
            maximum: 1000,
        },
        sniffer: { type: 'object' },
        vault: { type: 'object' },
    },
});

log.info(`Settings loaded from: ${store.path}`);

// ─── Public API ──────────────────────────────────────────────

/** Get a single setting by key */
export function getSetting<K extends keyof NtermSettings>(key: K): NtermSettings[K] {
    return store.get(key);
}

/** Set a single setting by key */
export function setSetting<K extends keyof NtermSettings>(key: K, value: NtermSettings[K]): void {
    try {
        store.set(key, value);
    } catch (err) {
        log.error(`Settings: failed to set ${key}:`, err);
    }
}

/** Get all settings (for renderer hydration on startup) */
export function getAllSettings(): NtermSettings {
    return store.store;
}

/** Bulk-set multiple settings at once */
export function setMultiple(partial: Partial<NtermSettings>): void {
    try {
        for (const [key, value] of Object.entries(partial)) {
            store.set(key, value);
        }
    } catch (err) {
        log.error('Settings: failed bulk set:', err);
    }
}

/** Reset a single key to its default */
export function resetSetting<K extends keyof NtermSettings>(key: K): NtermSettings[K] {
    const defaultValue = defaults[key];
    store.set(key, defaultValue);
    return defaultValue;
}

/** Reset all settings to defaults */
export function resetAll(): NtermSettings {
    store.store = defaults;
    return store.store;
}

/** Get the filesystem path where settings are stored (for diagnostics) */
export function getStorePath(): string {
    return store.path;
}

/** Get the schema defaults (pure; does not write to disk). */
export function getDefaults(): NtermSettings {
    return defaults;
}