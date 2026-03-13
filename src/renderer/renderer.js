// renderer.js — Frontend logic
// Owns: xterm.js terminals, tab management, session tree, connection dialog
// Talks to main process through window.nterm (preload bridge)
// Receives SSHManager messages through window.nterm.onMessage()

(() => {
    'use strict';

    // ─── State ───────────────────────────────────────────────
    const terminals = new Map();  // sessionId → { term, fitAddon, element, tab, label, status }
    let activeSessionId = null;
    let sessionData = null;

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

    // ─── Theme ───────────────────────────────────────────────

    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        for (const [, session] of terminals) {
            session.term.options.theme = getTerminalTheme();
        }
    });

    function getTerminalTheme() {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        if (isLight) {
            return {
                background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78',
                selectionBackground: '#ccd0da',
                black: '#5c5f77', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
                blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#acb0be',
                brightBlack: '#6c6f85', brightRed: '#d20f39', brightGreen: '#40a02b',
                brightYellow: '#df8e1d', brightBlue: '#1e66f5', brightMagenta: '#8839ef',
                brightCyan: '#179299', brightWhite: '#bcc0cc',
            };
        }
        return {
            background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
            selectionBackground: '#45475a',
            black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
            blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
            brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
            brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#cba6f7',
            brightCyan: '#94e2d5', brightWhite: '#a6adc8',
        };
    }

    // ─── Connection Dialog ───────────────────────────────────

    function showConnectDialog(prefill) {
        // Reset form
        dlgHost.value = prefill?.host || '';
        dlgPort.value = prefill?.port || 22;
        dlgUsername.value = prefill?.username || '';
        dlgPassword.value = prefill?.password || '';
        dlgKeypath.value = prefill?.privateKeyPath || '';
        dlgPassphrase.value = '';
        dlgLegacy.checked = prefill?.legacyMode || false;
        dlgAuthMethod.value = prefill?.authMethod || 'password';
        updateAuthFields();

        connectDialog.style.display = 'flex';
        dlgHost.focus();
    }

    function hideConnectDialog() {
        connectDialog.style.display = 'none';
        dlgPassword.value = '';
        dlgPassphrase.value = '';
    }

    // Auth method switching
    function updateAuthFields() {
        const method = dlgAuthMethod.value;
        rowPassword.style.display   = (method === 'password' || method === 'key-and-password') ? 'block' : 'none';
        rowKeyfile.style.display    = (method === 'keyfile' || method === 'key-and-password') ? 'block' : 'none';
        rowPassphrase.style.display = (method === 'keyfile' || method === 'key-and-password') ? 'block' : 'none';
    }

    dlgAuthMethod.addEventListener('change', updateAuthFields);

    // Browse for key file — uses native Electron dialog via preload
    document.getElementById('btn-browse-key').addEventListener('click', async () => {
        const keyPath = await window.nterm.selectKeyFile();
        if (keyPath) {
            dlgKeypath.value = keyPath;
        }
    });

    // Dialog buttons
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

        const config = {
            host,
            port: parseInt(dlgPort.value) || 22,
            username,
            legacyMode: dlgLegacy.checked,
            tryKeyboard: true,
        };

        const method = dlgAuthMethod.value;

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

        hideConnectDialog();
        connectSession({
            ...config,
            display_name: `${username}@${host}`,
        });
    });

    // Ctrl+N shortcut
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            showConnectDialog();
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
                el.innerHTML = `<span class="dot"></span>${session.display_name || session.host}`;

                // Double-click to connect with prefilled dialog
                el.addEventListener('dblclick', () => {
                    if (session.password) {
                        // Session has credentials — connect directly
                        connectSession(session);
                    } else {
                        // Open dialog with session info prefilled
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

        setStatus(`Connecting to ${config.host}...`);

        // Create terminal tab immediately (shows "connecting..." state)
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

        // xterm.js
        const term = new Terminal({
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            fontSize: 14,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 10000,
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
    // All SSH messages come through a single channel with the
    // same protocol as the VS Code extension.

    window.nterm.onMessage((message) => {
        const { sessionId, type, payload } = message;
        const session = terminals.get(sessionId);
        if (!session) return;

        switch (type) {
            case 'output':
                if (payload?.data) {
                    session.term.write(payload.data);
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
                // Could display negotiated algorithms, etc.
                break;

            case 'diagnostic':
                // Diagnostic data — already printed to terminal as output
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
        }
    });

    // ─── Helpers ─────────────────────────────────────────────

    function setStatus(msg) {
        statusMessage.textContent = msg;
    }

    function updateSessionCount() {
        statusSessions.textContent = `${terminals.size} session${terminals.size !== 1 ? 's' : ''}`;
    }

})();
