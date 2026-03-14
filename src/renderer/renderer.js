// renderer.js — Frontend logic
// Owns: xterm.js terminals, tab management, session tree, connection dialog, session capture
// Talks to main process through window.nterm (preload bridge)
// Receives SSHManager messages through window.nterm.onMessage()

(() => {
    'use strict';

    console.log('[nterm renderer] loaded — v6 session capture');

    // ─── ANSI Stripper ──────────────────────────────────────
    // Strips escape sequences from terminal output for session
    // capture. Handles partial sequences split across chunks
    // (common with slow network gear connections).

    const _CSI_RE         = /\x1b\[[?!>]*[0-9;]*[A-Za-z@`]/g;
    const _OSC_RE         = /\x1b\].*?(?:\x1b\\|\x07)/g;
    const _CHARSET_RE     = /\x1b[()][A-B012]/g;
    const _SIMPLE_RE      = /\x1b[=>78DEHM]/g;
    const _CTRL_RE        = /[\x00-\x06\x0e\x0f\x11-\x1a\x1c-\x1f]/g;
    const _BEL_RE         = /\x07/g;
    const _BS_RE          = /\x08/g;
    const _TRAILING_ESC_RE = /\x1b\[?[?!>]*[0-9;]*$/;

    class AnsiStripper {
        constructor() {
            this._partial = '';
        }

        strip(data) {
            let text = this._partial + data;
            this._partial = '';

            const trailingMatch = text.match(_TRAILING_ESC_RE);
            if (trailingMatch) {
                this._partial = trailingMatch[0];
                text = text.slice(0, -this._partial.length);
            }

            text = text.replace(_OSC_RE, '');
            text = text.replace(_CSI_RE, '');
            text = text.replace(_CHARSET_RE, '');
            text = text.replace(_SIMPLE_RE, '');
            text = text.replace(_BEL_RE, '');
            text = text.replace(_BS_RE, '');
            text = text.replace(_CTRL_RE, '');

            return text;
        }

        flush() {
            const remaining = this._partial;
            this._partial = '';
            if (remaining.length <= 2) return '';
            return remaining.replace(_CSI_RE, '')
                            .replace(_OSC_RE, '')
                            .replace(_CHARSET_RE, '')
                            .replace(_SIMPLE_RE, '')
                            .replace(_CTRL_RE, '');
        }

        reset() {
            this._partial = '';
        }
    }

    // ─── State ───────────────────────────────────────────────
    const terminals = new Map();  // sessionId → { term, fitAddon, element, tab, label, status }
    let activeSessionId = null;
    let sessionData = null;
    let settings = null;  // hydrated from electron-store on startup

    // Per-session capture state (separate from terminals Map)
    const captureState = new Map();  // sessionId → { active, filePath, stripper }

    // ─── Last-Used Credentials ───────────────────────────────
    // Populated from persisted settings, updated in-memory,
    // and written back to store on change.
    let lastUsedCreds = {
        username: '',
        authMethod: 'password',
        privateKeyPath: '',
        legacyMode: false,
    };

    // ─── DOM refs ────────────────────────────────────────────
    const tabList        = document.getElementById('tab-list');
    const termContainer  = document.getElementById('terminal-container');
    const welcome        = document.getElementById('welcome');
    const sessionTree    = document.getElementById('session-tree');
    const statusMessage  = document.getElementById('status-message');
    const statusSessions = document.getElementById('status-sessions');
    const searchInput    = document.getElementById('session-search');

    // Dialog refs
    const connectDialog  = document.getElementById('connect-dialog');
    const dlgHost        = document.getElementById('dlg-host');
    const dlgPort        = document.getElementById('dlg-port');
    const dlgUsername     = document.getElementById('dlg-username');
    const dlgAuthMethod  = document.getElementById('dlg-auth-method');
    const dlgPassword    = document.getElementById('dlg-password');
    const dlgKeypath     = document.getElementById('dlg-keypath');
    const dlgPassphrase  = document.getElementById('dlg-passphrase');
    const dlgLegacy      = document.getElementById('dlg-legacy-mode');
    const rowPassword    = document.getElementById('row-password');
    const rowKeyfile     = document.getElementById('row-keyfile');
    const rowPassphrase  = document.getElementById('row-passphrase');

    // Context menu refs
    const contextMenu    = document.getElementById('context-menu');
    const ctxCopy        = document.getElementById('ctx-copy');
    const ctxPaste       = document.getElementById('ctx-paste');
    const ctxCapture     = document.getElementById('ctx-capture');
    const ctxCaptureText = document.getElementById('ctx-capture-text');
    const ctxClear       = document.getElementById('ctx-clear');

    // ─── Settings: Load & Apply ──────────────────────────────
    // Called once on startup before anything renders.

    async function loadSettings() {
        try {
            settings = await window.nterm.getSettings();
            console.log('[nterm] Settings loaded:', settings);
        } catch (err) {
            console.error('[nterm] Failed to load settings, using defaults:', err);
            return;
        }

        // Apply theme (handles migration from 'dark'/'light' to named themes)
        if (settings.theme) {
            applyAndGetTerminalTheme(settings.theme);
        }

        // Apply sidebar width
        if (settings.sidebarWidth) {
            sidebar.style.width = `${settings.sidebarWidth}px`;
        }

        // Hydrate last-used credentials from persisted defaults
        if (settings.defaultUsername) {
            lastUsedCreds.username = settings.defaultUsername;
        }
        if (settings.defaultAuthMethod) {
            lastUsedCreds.authMethod = settings.defaultAuthMethod;
        }
        if (settings.defaultPrivateKeyPath) {
            lastUsedCreds.privateKeyPath = settings.defaultPrivateKeyPath;
        }
        if (settings.defaultLegacyMode !== undefined) {
            lastUsedCreds.legacyMode = settings.defaultLegacyMode;
        }

        // Auto-load last sessions file
        if (settings.lastSessionsFile) {
            try {
                const result = await window.nterm.loadLastSessionsFile();
                if (result && !result.error) {
                    sessionData = result.sessions;
                    renderSessionTree(sessionData);
                    setStatus(`Loaded: ${result.filePath.split(/[\\/]/).pop()}`);
                }
            } catch (err) {
                console.warn('[nterm] Failed to auto-load sessions:', err);
            }
        }
    }

    // ─── Settings: Persist Credentials ───────────────────────
    // Called after any credential change (dialog or direct connect)

    function persistCredentials() {
        window.nterm.setSettings({
            defaultUsername: lastUsedCreds.username,
            defaultAuthMethod: lastUsedCreds.authMethod,
            defaultPrivateKeyPath: lastUsedCreds.privateKeyPath,
            defaultLegacyMode: lastUsedCreds.legacyMode,
        });
    }

    // ─── Theme ───────────────────────────────────────────────

    document.getElementById('btn-devtools').addEventListener('click', () => {
        console.log('[nterm] DevTools button clicked');
        window.nterm.openDevTools();
    });

    // Build theme selector dropdown
    const themeSelect = document.getElementById('theme-select');
    (function populateThemeSelector() {
        const list = window.NtermThemes.getThemeList();
        const darkGroup = document.createElement('optgroup');
        darkGroup.label = 'Dark';
        const lightGroup = document.createElement('optgroup');
        lightGroup.label = 'Light';

        for (const t of list) {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.label;
            if (t.type === 'dark') darkGroup.appendChild(opt);
            else lightGroup.appendChild(opt);
        }
        themeSelect.appendChild(darkGroup);
        themeSelect.appendChild(lightGroup);
    })();

    themeSelect.addEventListener('change', () => {
        const themeName = themeSelect.value;
        const xtermTheme = window.NtermThemes.applyTheme(themeName);
        for (const [, session] of terminals) {
            session.term.options.theme = xtermTheme;
        }
        // Persist theme choice
        window.nterm.setSetting('theme', themeName);
    });

    /** Apply named theme and return xterm theme object */
    function applyAndGetTerminalTheme(themeName) {
        const resolved = window.NtermThemes.migrateLegacyTheme(themeName || 'catppuccin-mocha');
        themeSelect.value = resolved;
        return window.NtermThemes.applyTheme(resolved);
    }

    /** Get current xterm theme (for new terminals) */
    function getTerminalTheme() {
        const name = document.documentElement.getAttribute('data-theme-name');
        const theme = window.NtermThemes.getTheme(name);
        return theme.xterm;
    }

    // ─── Connection Dialog ───────────────────────────────────

    function showConnectDialog(prefill) {
        console.log('[nterm] showConnectDialog called', { prefill, lastUsedCreds });
        const hasAuth = prefill?.username || prefill?.password || prefill?.privateKeyPath;
        const defaults = hasAuth ? {} : lastUsedCreds;

        dlgHost.value = prefill?.host || '';
        dlgPort.value = prefill?.port || 22;
        dlgUsername.value = prefill?.username || defaults.username || '';
        dlgPassword.value = prefill?.password || '';
        dlgKeypath.value = prefill?.privateKeyPath || defaults.privateKeyPath || '';
        dlgPassphrase.value = '';
        dlgLegacy.checked = prefill?.legacyMode ?? defaults.legacyMode ?? false;
        dlgAuthMethod.value = prefill?.authMethod || defaults.authMethod || 'password';
        updateAuthFields();

        connectDialog.style.display = 'flex';
        if (!dlgHost.value) {
            dlgHost.focus();
        } else if (!dlgUsername.value) {
            dlgUsername.focus();
        } else {
            dlgPassword.focus();
        }
    }

    function hideConnectDialog() {
        connectDialog.style.display = 'none';
        dlgPassword.value = '';
        dlgPassphrase.value = '';
    }

    function updateAuthFields() {
        const method = dlgAuthMethod.value;
        rowPassword.style.display   = (method === 'password' || method === 'key-and-password') ? 'block' : 'none';
        rowKeyfile.style.display    = (method === 'keyfile' || method === 'key-and-password') ? 'block' : 'none';
        rowPassphrase.style.display = (method === 'keyfile' || method === 'key-and-password') ? 'block' : 'none';
    }

    dlgAuthMethod.addEventListener('change', updateAuthFields);

    document.getElementById('btn-browse-key').addEventListener('click', async () => {
        const keyPath = await window.nterm.selectKeyFile();
        if (keyPath) {
            dlgKeypath.value = keyPath;
        }
    });

    document.getElementById('btn-quick-connect').addEventListener('click', () => showConnectDialog());
    document.getElementById('btn-dialog-close').addEventListener('click', hideConnectDialog);
    document.getElementById('btn-dialog-cancel').addEventListener('click', hideConnectDialog);

    document.getElementById('btn-dialog-connect').addEventListener('click', () => {
        const host = dlgHost.value.trim();
        const username = dlgUsername.value.trim();
        if (!host || !username) {
            dlgHost.focus();
            return;
        }

        const method = dlgAuthMethod.value;

        const config = {
            host,
            port: parseInt(dlgPort.value) || 22,
            username,
            legacyMode: dlgLegacy.checked,
            tryKeyboard: true,
        };

        if (method === 'password' || method === 'key-and-password') {
            config.password = dlgPassword.value;
        }
        if (method === 'keyfile' || method === 'key-and-password') {
            config.privateKeyPath = dlgKeypath.value;
            if (dlgPassphrase.value) {
                config.passphrase = dlgPassphrase.value;
            }
        }
        if (method === 'agent') {
            config.useAgent = true;
        }

        // Remember credentials (in-memory + persisted)
        lastUsedCreds = {
            username,
            authMethod: method,
            privateKeyPath: (method === 'keyfile' || method === 'key-and-password') ? dlgKeypath.value : lastUsedCreds.privateKeyPath,
            legacyMode: dlgLegacy.checked,
        };
        console.log('[nterm] lastUsedCreds saved (dialog):', lastUsedCreds);
        persistCredentials();

        hideConnectDialog();
        connectSession({
            ...config,
            display_name: `${username}@${host}`,
        });
    });

    // Ctrl+N shortcut, F12 for DevTools
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            showConnectDialog();
        }
        if (e.key === 'F12') {
            e.preventDefault();
            window.nterm.openDevTools();
        }
        if (e.key === 'Escape' && connectDialog.style.display !== 'none') {
            hideConnectDialog();
        }
    });

    // Enter in dialog fields
    ['dlg-host', 'dlg-port', 'dlg-username', 'dlg-password', 'dlg-passphrase'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('btn-dialog-connect').click();
            }
        });
    });

    // ─── Load Sessions ───────────────────────────────────────

    document.getElementById('btn-load-sessions').addEventListener('click', async () => {
        const result = await window.nterm.loadSessionsFile();
        if (!result) return;
        if (result.error) {
            setStatus(`Error: ${result.error}`);
            return;
        }
        sessionData = result.sessions;
        renderSessionTree(sessionData);
        setStatus(`Loaded: ${result.filePath.split(/[\\/]/).pop()}`);

        // Path is also persisted by main process in sessions:load-file handler,
        // but we set it from renderer too for the auto-load-on-next-launch path
        window.nterm.setSetting('lastSessionsFile', result.filePath);
    });

    function renderSessionTree(data) {
        sessionTree.innerHTML = '';
        if (!Array.isArray(data)) return;

        for (const folder of data) {
            const folderName = folder.folder_name || folder.name || 'Unnamed';
            const sessions = folder.sessions || folder.children || [];

            const folderEl = document.createElement('div');
            folderEl.className = 'tree-folder';
            folderEl.textContent = `▸ ${folderName}`;
            folderEl.addEventListener('click', () => {
                const isOpen = folderEl.textContent.startsWith('▾');
                folderEl.textContent = `${isOpen ? '▸' : '▾'} ${folderName}`;
                const items = folderEl.parentElement.querySelectorAll(
                    `.tree-session[data-folder="${folderName}"]`
                );
                items.forEach(el => el.style.display = isOpen ? 'none' : 'flex');
            });

            const wrapper = document.createElement('div');
            wrapper.appendChild(folderEl);

            for (const session of sessions) {
                const el = document.createElement('div');
                el.className = 'tree-session';
                el.setAttribute('data-folder', folderName);
                el.style.display = 'none';
                el.innerHTML = `<span class="dot"></span>${session.display_name || session.host}`;

                el.addEventListener('dblclick', () => {
                    if (session.password) {
                        connectSession(session);
                    } else {
                        showConnectDialog(session);
                    }
                });
                wrapper.appendChild(el);
            }

            sessionTree.appendChild(wrapper);
        }
    }

    // Session search
    searchInput.addEventListener('input', () => {
        const filter = searchInput.value.toLowerCase();
        sessionTree.querySelectorAll('.tree-session').forEach(el => {
            el.style.display = el.textContent.toLowerCase().includes(filter) ? 'flex' : 'none';
        });
    });

    // ─── Connect Session ─────────────────────────────────────

    async function connectSession(config) {
        const sessionId = crypto.randomUUID();
        const label = config.display_name || `${config.username}@${config.host}`;

        // Update last-used creds from direct connects too
        if (config.username) {
            lastUsedCreds.username = config.username;
        }
        if (config.privateKeyPath) {
            lastUsedCreds.privateKeyPath = config.privateKeyPath;
            lastUsedCreds.authMethod = config.password ? 'key-and-password' : 'keyfile';
        }
        if (config.legacyMode !== undefined) {
            lastUsedCreds.legacyMode = config.legacyMode;
        }
        console.log('[nterm] lastUsedCreds saved (direct):', { ...lastUsedCreds });
        persistCredentials();

        setStatus(`Connecting to ${config.host}...`);

        createTerminalTab(sessionId, label);

        try {
            const sshConfig = {
                host: config.host,
                port: config.port || 22,
                username: config.username,
                password: config.password,
                privateKeyPath: config.privateKeyPath,
                passphrase: config.passphrase,
                useAgent: config.useAgent,
                legacyMode: config.legacyMode,
                tryKeyboard: true,
            };

            await window.nterm.connect(sessionId, sshConfig);
        } catch (err) {
            setStatus(`Failed: ${err}`);
        }
    }

    // ─── Terminal Tab Management ─────────────────────────────

    function createTerminalTab(sessionId, label) {
        welcome.style.display = 'none';

        // Tab
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.setAttribute('data-session', sessionId);
        tab.innerHTML = `
            <span class="tab-status connecting"></span>
            <span class="tab-label">${label}</span>
            <span class="tab-close" title="Close">&times;</span>
        `;
        tab.querySelector('.tab-label').addEventListener('click', () => activateTab(sessionId));
        tab.querySelector('.tab-close').addEventListener('click', (e) => {
            e.stopPropagation();
            closeTab(sessionId);
        });
        tabList.appendChild(tab);

        // Terminal pane
        const pane = document.createElement('div');
        pane.className = 'terminal-pane';
        pane.id = `pane-${sessionId}`;
        termContainer.appendChild(pane);

        // xterm.js — uses persisted settings for font, cursor, scrollback
        const term = new Terminal({
            fontFamily: settings?.terminalFontFamily || "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            fontSize: settings?.terminalFontSize || 14,
            cursorBlink: settings?.cursorBlink ?? true,
            cursorStyle: settings?.cursorStyle || 'block',
            scrollback: settings?.scrollbackLines || 10000,
            theme: getTerminalTheme(),
            allowProposedApi: true,
        });

        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(pane);
        fitAddon.fit();

        // Keystrokes → main process → SSHManager → device
        term.onData((data) => {
            window.nterm.send(sessionId, data);
        });

        // Resize → main process → SSHManager → PTY
        term.onResize(({ cols, rows }) => {
            window.nterm.resize(sessionId, cols, rows);
        });

        // ─── Copy / Paste ────────────────────────────────────
        if (term.textarea) {
            term.textarea.addEventListener('paste', (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();
                const text = e.clipboardData?.getData('text');
                if (text) {
                    checkAndSendPaste(sessionId, text);
                }
            }, { capture: true });
        }

        term.attachCustomKeyEventHandler((event) => {
            const mod = event.ctrlKey || event.metaKey;
            if (event.type !== 'keydown') return true;

            if (mod && event.key === 'c') {
                if (term.hasSelection()) {
                    navigator.clipboard.writeText(term.getSelection());
                    term.clearSelection();
                    return false;
                }
                return true;
            }

            return true;
        });

        pane.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData?.getData('text');
            if (text) {
                checkAndSendPaste(sessionId, text);
            }
        });

        // Store
        terminals.set(sessionId, {
            term, fitAddon, element: pane, tab, label,
            status: 'connecting',
        });

        activateTab(sessionId);

        // Fit after render
        requestAnimationFrame(() => {
            fitAddon.fit();
            const { cols, rows } = term;
            window.nterm.resize(sessionId, cols, rows);
        });

        updateSessionCount();
    }

    function activateTab(sessionId) {
        for (const [, session] of terminals) {
            session.tab.classList.remove('active');
            session.element.classList.remove('active');
        }

        const session = terminals.get(sessionId);
        if (session) {
            session.tab.classList.add('active');
            session.element.classList.add('active');
            activeSessionId = sessionId;
            requestAnimationFrame(() => session.fitAddon.fit());
        }
    }

    function closeTab(sessionId) {
        const session = terminals.get(sessionId);
        if (!session) return;

        // Stop capture if active (flush buffer before disconnect)
        const capState = captureState.get(sessionId);
        if (capState?.active) {
            const remaining = capState.stripper.flush();
            if (remaining) {
                window.nterm.captureWrite(sessionId, remaining);
            }
            window.nterm.captureStop(sessionId);
            captureState.delete(sessionId);
        }

        window.nterm.disconnect(sessionId);
        session.term.dispose();
        session.element.remove();
        session.tab.remove();
        terminals.delete(sessionId);

        if (terminals.size > 0) {
            activateTab(terminals.keys().next().value);
        } else {
            activeSessionId = null;
            welcome.style.display = 'flex';
        }

        updateSessionCount();
    }

    // ─── SSHManager Messages ─────────────────────────────────

    window.nterm.onMessage((message) => {
        const { sessionId, type, payload } = message;
        const session = terminals.get(sessionId);
        if (!session) return;

        switch (type) {
            case 'output':
                if (payload?.data) {
                    // Write raw data to terminal (unchanged)
                    session.term.write(payload.data);

                    // Tap: if capture is active, strip ANSI and send to main
                    const cap = captureState.get(sessionId);
                    if (cap?.active) {
                        const stripped = cap.stripper.strip(payload.data);
                        if (stripped) {
                            window.nterm.captureWrite(sessionId, stripped);
                        }
                    }
                }
                break;

            case 'connectionStatus':
                updateTabStatus(sessionId, payload.status);
                if (payload.status === 'connected') {
                    setStatus(`Connected: ${session.label}`);
                } else if (payload.status === 'error') {
                    setStatus(`Error: ${payload.message}`);
                } else if (payload.status === 'disconnected') {
                    setStatus(`Disconnected: ${session.label}`);
                }
                break;

            case 'error':
                setStatus(`Error: ${payload.message}`);
                break;

            case 'metadata':
                break;

            case 'diagnostic':
                break;
        }
    });

    function updateTabStatus(sessionId, status) {
        const session = terminals.get(sessionId);
        if (!session) return;

        session.status = status;
        const dot = session.tab.querySelector('.tab-status');
        if (dot) {
            dot.className = `tab-status ${status}`;
            // Preserve capturing indicator if active
            const capState = captureState.get(sessionId);
            if (capState?.active) {
                dot.classList.add('capturing');
            }
        }
    }

    // ─── Window Resize ───────────────────────────────────────

    window.addEventListener('resize', () => {
        for (const [, session] of terminals) {
            session.fitAddon.fit();
        }
    });

    // ─── Splitter Drag ───────────────────────────────────────

    const splitter = document.getElementById('splitter');
    const sidebar  = document.getElementById('sidebar');
    let dragging = false;

    splitter.addEventListener('mousedown', (e) => {
        dragging = true;
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const newWidth = Math.max(120, Math.min(500, e.clientX));
        sidebar.style.width = `${newWidth}px`;
        for (const [, session] of terminals) {
            session.fitAddon.fit();
        }
    });

    window.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor = '';
            // Persist sidebar width
            const width = parseInt(sidebar.style.width) || 220;
            window.nterm.setSetting('sidebarWidth', width);
        }
    });

    // ─── Context Menu ───────────────────────────────────────

    // Track which session the context menu was opened for
    let contextMenuSessionId = null;

    // Show context menu on right-click in terminal area
    termContainer.addEventListener('contextmenu', (e) => {
        e.preventDefault();

        if (!activeSessionId) return;
        contextMenuSessionId = activeSessionId;

        const session = terminals.get(activeSessionId);
        if (!session) return;

        // Update copy state
        if (session.term.hasSelection()) {
            ctxCopy.classList.remove('disabled');
        } else {
            ctxCopy.classList.add('disabled');
        }

        // Update capture label
        const capState = captureState.get(activeSessionId);
        if (capState?.active) {
            const fileName = capState.filePath.split(/[\\/]/).pop();
            ctxCaptureText.textContent = `Stop Capture (${fileName})`;
        } else {
            ctxCaptureText.textContent = 'Start Capture...';
        }

        // Position — keep menu on screen
        const x = Math.min(e.clientX, window.innerWidth - 200);
        const y = Math.min(e.clientY, window.innerHeight - 160);
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = 'block';
    });

    // Hide on click outside
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.style.display = 'none';
        }
    });

    // Hide on Escape (also hides connect dialog — existing behavior preserved)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            contextMenu.style.display = 'none';
        }
    });

    // Context Menu: Copy
    ctxCopy.addEventListener('click', () => {
        contextMenu.style.display = 'none';
        const session = terminals.get(contextMenuSessionId);
        if (session?.term.hasSelection()) {
            navigator.clipboard.writeText(session.term.getSelection());
            session.term.clearSelection();
        }
    });

    // Context Menu: Paste
    ctxPaste.addEventListener('click', async () => {
        contextMenu.style.display = 'none';
        if (!contextMenuSessionId) return;
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                checkAndSendPaste(contextMenuSessionId, text);
            }
        } catch (err) {
            console.warn('[nterm] Clipboard read failed:', err);
        }
    });

    // Context Menu: Clear Terminal
    ctxClear.addEventListener('click', () => {
        contextMenu.style.display = 'none';
        const session = terminals.get(contextMenuSessionId);
        if (session) {
            session.term.clear();
        }
    });

    // Context Menu: Capture Toggle
    ctxCapture.addEventListener('click', async () => {
        contextMenu.style.display = 'none';
        if (!contextMenuSessionId) return;

        const capState = captureState.get(contextMenuSessionId);

        if (capState?.active) {
            await stopCapture(contextMenuSessionId);
        } else {
            await startCapture(contextMenuSessionId);
        }
    });

    // ─── Session Capture ────────────────────────────────────

    async function startCapture(sessionId) {
        const session = terminals.get(sessionId);
        if (!session) return;

        // Build default filename: label_YYYYMMDD_HHMMSS.log
        const now = new Date();
        const ts = now.toISOString().replace(/[:\-T]/g, '').slice(0, 15);
        const safeName = session.label.replace(/[^a-zA-Z0-9@._-]/g, '_');
        const defaultName = `${safeName}_${ts}.log`;

        // Ask main process to show save dialog
        const filePath = await window.nterm.captureSelectFile(defaultName);
        if (!filePath) return;  // user cancelled

        // Tell main to open the file handle
        const result = await window.nterm.captureStart(sessionId, filePath);
        if (result?.error) {
            setStatus(`Capture error: ${result.error}`);
            return;
        }

        // Create ANSI stripper for this session
        const stripper = new AnsiStripper();

        captureState.set(sessionId, {
            active: true,
            filePath,
            stripper,
        });

        // Visual indicator: add capturing class to tab dot
        updateCaptureIndicator(sessionId, true);

        const fileName = filePath.split(/[\\/]/).pop();
        setStatus(`Capturing: ${session.label} → ${fileName}`);
    }

    async function stopCapture(sessionId) {
        const capState = captureState.get(sessionId);
        if (!capState?.active) return;

        // Flush any buffered partial ANSI sequence
        const remaining = capState.stripper.flush();
        if (remaining) {
            window.nterm.captureWrite(sessionId, remaining);
        }

        // Tell main to close the file handle
        await window.nterm.captureStop(sessionId);

        captureState.delete(sessionId);

        // Remove visual indicator
        updateCaptureIndicator(sessionId, false);

        setStatus('Capture stopped');
    }

    function updateCaptureIndicator(sessionId, isCapturing) {
        const session = terminals.get(sessionId);
        if (!session) return;

        const dot = session.tab.querySelector('.tab-status');
        if (!dot) return;

        if (isCapturing) {
            dot.classList.add('capturing');
        } else {
            dot.classList.remove('capturing');
        }
    }

    // Handle capture errors from main process (disk full, etc.)
    window.nterm.onCaptureError((msg) => {
        const { sessionId, error } = msg;
        const capState = captureState.get(sessionId);
        if (capState) {
            capState.stripper.reset();
            captureState.delete(sessionId);
            updateCaptureIndicator(sessionId, false);
            setStatus(`Capture failed: ${error}`);
        }
    });

    // ─── Paste Handling (multi-line warning) ────────────────

    function checkAndSendPaste(sessionId, text) {
        const lines = text.split(/\r?\n/);
        const threshold = settings?.pasteWarningThreshold ?? 1;
        if (lines.length > threshold) {
            showPasteWarning(sessionId, text, lines.length);
        } else {
            window.nterm.send(sessionId, text);
        }
    }

    function showPasteWarning(sessionId, text, lineCount) {
        const overlay = document.getElementById('paste-dialog');
        const preview = document.getElementById('paste-preview');
        const countEl = document.getElementById('paste-line-count');

        const previewLines = text.split(/\r?\n/).slice(0, 10);
        let previewText = previewLines.join('\n');
        if (lineCount > 10) {
            previewText += `\n... (${lineCount - 10} more lines)`;
        }
        preview.textContent = previewText;
        countEl.textContent = `${lineCount} lines`;

        overlay.style.display = 'flex';

        const btnConfirm = document.getElementById('btn-paste-confirm');
        const btnCancel  = document.getElementById('btn-paste-cancel');

        function cleanup() {
            overlay.style.display = 'none';
            btnConfirm.removeEventListener('click', onConfirm);
            btnCancel.removeEventListener('click', onCancel);
            const session = terminals.get(sessionId);
            if (session) session.term.focus();
        }

        function onConfirm() {
            cleanup();
            window.nterm.send(sessionId, text);
        }

        function onCancel() {
            cleanup();
        }

        btnConfirm.addEventListener('click', onConfirm);
        btnCancel.addEventListener('click', onCancel);

        function onKey(e) {
            if (e.key === 'Escape') { onCancel(); document.removeEventListener('keydown', onKey); }
            if (e.key === 'Enter')  { onConfirm(); document.removeEventListener('keydown', onKey); }
        }
        document.addEventListener('keydown', onKey);
    }

    // ─── Helpers ─────────────────────────────────────────────

    function setStatus(msg) {
        statusMessage.textContent = msg;
    }

    function updateSessionCount() {
        statusSessions.textContent = `${terminals.size} session${terminals.size !== 1 ? 's' : ''}`;
    }

    // ─── About Dialog ─────────────────────────────────────────

    const aboutDialog   = document.getElementById('about-dialog');
    const aboutVersion  = document.getElementById('about-version');
    const aboutRuntime  = document.getElementById('about-runtime');
    const aboutRepoLink = document.getElementById('about-repo-link');

    async function showAboutDialog() {
        try {
            const info = await window.nterm.getVersionInfo();
            aboutVersion.textContent = `v${info.appVersion}`;
            aboutRuntime.innerHTML = [
                `Electron ${info.electronVersion}`,
                `Chrome ${info.chromeVersion}`,
                `Node ${info.nodeVersion}`,
                info.platform,
            ].join(' · ');
        } catch (err) {
            aboutVersion.textContent = '';
            aboutRuntime.textContent = '';
        }
        aboutDialog.style.display = 'flex';
    }

    function hideAboutDialog() {
        aboutDialog.style.display = 'none';
    }

    document.getElementById('btn-about-close').addEventListener('click', hideAboutDialog);
    document.getElementById('btn-about-ok').addEventListener('click', hideAboutDialog);

    aboutRepoLink.addEventListener('click', (e) => {
        e.preventDefault();
        // shell.openExternal is handled via the main process menu,
        // but for the rendered link we open it through the OS
        window.open('https://github.com/scottpeterman/nterm-js', '_blank');
    });

    // Close About on Escape
    aboutDialog.addEventListener('click', (e) => {
        if (e.target === aboutDialog) hideAboutDialog();
    });

    // ─── Menu Events (from main process) ──────────────────────

    window.nterm.onShowAbout(() => showAboutDialog());

    window.nterm.onMenuNewConnection(() => showConnectDialog());

    window.nterm.onMenuLoadSessions(async () => {
        const result = await window.nterm.loadSessionsFile();
        if (!result) return;
        if (result.error) {
            setStatus(`Error: ${result.error}`);
            return;
        }
        sessionData = result.sessions;
        renderSessionTree(sessionData);
        setStatus(`Loaded: ${result.filePath.split(/[\\/]/).pop()}`);
        window.nterm.setSetting('lastSessionsFile', result.filePath);
    });

    // ─── Startup ─────────────────────────────────────────────
    loadSettings();

})();