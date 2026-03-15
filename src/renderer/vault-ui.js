// vault-ui.js — Vault UI for the renderer
// Loaded before renderer.js in index.html
// Exposes window.NtermVault for renderer.js to call

(() => {
    'use strict';

    // ─── State ───────────────────────────────────────────────
    let vaultState = { initialized: false, unlocked: false, credentialCount: 0, keychainAvailable: false };
    let credentials = [];  // CredentialSummary[] from vault:list

    // ─── DOM refs ────────────────────────────────────────────
    const statusBar       = document.getElementById('statusbar');
    const vaultIndicator  = document.getElementById('vault-indicator');

    // Unlock dialog
    const unlockDialog    = document.getElementById('vault-unlock-dialog');
    const unlockTitle     = document.getElementById('vault-unlock-title');
    const unlockHint      = document.getElementById('vault-unlock-hint');
    const unlockPassword  = document.getElementById('vault-unlock-password');
    const unlockConfirm   = document.getElementById('vault-unlock-confirm');
    const unlockConfirmRow= document.getElementById('vault-unlock-confirm-row');
    const unlockRemember  = document.getElementById('vault-unlock-remember');
    const unlockRememberRow = document.getElementById('vault-unlock-remember-row');
    const unlockError     = document.getElementById('vault-unlock-error');
    const unlockBtn       = document.getElementById('btn-vault-unlock');
    const unlockCancelBtn = document.getElementById('btn-vault-unlock-cancel');

    // Manager dialog
    const managerDialog   = document.getElementById('vault-manager-dialog');
    const managerTable    = document.getElementById('vault-cred-table');
    const managerBody     = document.getElementById('vault-cred-tbody');
    const managerEditBtn  = document.getElementById('btn-vault-edit');
    const managerDeleteBtn= document.getElementById('btn-vault-delete');

    // Credential editor dialog
    const editorDialog    = document.getElementById('vault-editor-dialog');
    const editorTitle     = document.getElementById('vault-editor-title');
    const editorError     = document.getElementById('vault-editor-error');
    const edName          = document.getElementById('ved-name');
    const edUsername      = document.getElementById('ved-username');
    const edPassword      = document.getElementById('ved-password');
    const edSshKey        = document.getElementById('ved-sshkey');
    const edKeyPassphrase = document.getElementById('ved-keypass');
    const edJumpHost      = document.getElementById('ved-jumphost');
    const edJumpUser      = document.getElementById('ved-jumpuser');
    const edMatchHosts    = document.getElementById('ved-matchhosts');
    const edMatchTags     = document.getElementById('ved-matchtags');
    const edDefault       = document.getElementById('ved-default');

    // ─── Status Indicator ────────────────────────────────────

    function updateIndicator() {
        if (!vaultIndicator) return;

        if (!vaultState.initialized) {
            vaultIndicator.textContent = '🔒';
            vaultIndicator.title = 'Vault: not initialized — click to create';
        } else if (vaultState.unlocked) {
            vaultIndicator.textContent = '🔓';
            vaultIndicator.title = `Vault: unlocked (${vaultState.credentialCount} credentials)`;
        } else {
            vaultIndicator.textContent = '🔒';
            vaultIndicator.title = 'Vault: locked — click to unlock';
        }
    }

    if (vaultIndicator) {
        vaultIndicator.addEventListener('click', () => {
            if (vaultState.unlocked) {
                showManagerDialog();
            } else {
                showUnlockDialog();
            }
        });
    }

    // ─── Unlock Dialog ───────────────────────────────────────

    function showUnlockDialog() {
        const isInit = !vaultState.initialized;

        unlockTitle.textContent = isInit ? 'Create Vault' : 'Unlock Vault';
        unlockHint.textContent = isInit
            ? 'Create a master password to encrypt stored credentials.'
            : 'Enter your master password.';
        unlockHint.style.display = 'block';

        unlockConfirmRow.style.display = isInit ? 'block' : 'none';
        unlockRememberRow.style.display = vaultState.keychainAvailable ? 'block' : 'none';

        unlockBtn.textContent = isInit ? 'Create Vault' : 'Unlock';

        unlockPassword.value = '';
        unlockConfirm.value = '';
        unlockRemember.checked = true;
        unlockError.style.display = 'none';

        unlockDialog.style.display = 'flex';
        unlockPassword.focus();
    }

    function hideUnlockDialog() {
        unlockDialog.style.display = 'none';
        unlockPassword.value = '';
        unlockConfirm.value = '';
    }

    async function doUnlock() {
        const password = unlockPassword.value;
        const isInit = !vaultState.initialized;

        if (!password) {
            showUnlockError('Password is required');
            return;
        }

        if (isInit) {
            if (password.length < 8) {
                showUnlockError('Password must be at least 8 characters');
                return;
            }
            if (password !== unlockConfirm.value) {
                showUnlockError('Passwords do not match');
                return;
            }
        }

        unlockBtn.disabled = true;
        unlockBtn.textContent = isInit ? 'Creating...' : 'Unlocking...';

        try {
            let result;
            if (isInit) {
                result = await window.nterm.vaultInit(password);
            } else {
                result = await window.nterm.vaultUnlock(password, unlockRemember.checked);
            }

            if (result.success) {
                hideUnlockDialog();
                await refreshVaultState();
            } else {
                showUnlockError(result.error || 'Invalid password');
            }
        } catch (err) {
            showUnlockError(err.message || 'Unlock failed');
        } finally {
            unlockBtn.disabled = false;
            unlockBtn.textContent = isInit ? 'Create Vault' : 'Unlock';
        }
    }

    function showUnlockError(msg) {
        unlockError.textContent = msg;
        unlockError.style.display = 'block';
    }

    if (unlockBtn) unlockBtn.addEventListener('click', doUnlock);
    if (unlockCancelBtn) unlockCancelBtn.addEventListener('click', hideUnlockDialog);

    // Enter key triggers unlock
    if (unlockPassword) unlockPassword.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doUnlock();
    });
    if (unlockConfirm) unlockConfirm.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doUnlock();
    });

    // Close on overlay click
    if (unlockDialog) unlockDialog.addEventListener('click', (e) => {
        if (e.target === unlockDialog) hideUnlockDialog();
    });

    // ─── Credential Manager Dialog ───────────────────────────

    async function showManagerDialog() {
        if (!vaultState.unlocked) {
            showUnlockDialog();
            return;
        }

        await refreshCredentialList();
        managerDialog.style.display = 'flex';
    }

    function hideManagerDialog() {
        managerDialog.style.display = 'none';
    }

    async function refreshCredentialList() {
        try {
            const result = await window.nterm.vaultList();
            credentials = result.credentials || [];
        } catch {
            credentials = [];
        }
        renderCredentialTable();
    }

    function renderCredentialTable() {
        managerBody.innerHTML = '';

        if (credentials.length === 0) {
            const row = document.createElement('tr');
            row.innerHTML = `<td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">
                No credentials stored. Click <strong>+ Add</strong> to create one.
            </td>`;
            managerBody.appendChild(row);
            return;
        }

        for (const cred of credentials) {
            const row = document.createElement('tr');
            row.setAttribute('data-name', cred.name);
            row.addEventListener('click', () => selectCredentialRow(cred.name));
            row.addEventListener('dblclick', () => showEditorDialog(cred.name));

            const authParts = [];
            if (cred.hasPassword) authParts.push('🔑');
            if (cred.hasSshKey) authParts.push('🗝️');
            if (authParts.length === 0) authParts.push('Agent');

            const lastUsed = cred.lastUsed
                ? new Date(cred.lastUsed).toLocaleDateString()
                : '—';

            row.innerHTML = `
                <td>${cred.name}</td>
                <td>${cred.username}</td>
                <td style="text-align:center">${authParts.join(' ')}</td>
                <td style="text-align:center">${cred.isDefault ? '✓' : ''}</td>
                <td style="text-align:center">${lastUsed}</td>
            `;
            managerBody.appendChild(row);
        }
    }

    let selectedCredName = null;

    function selectCredentialRow(name) {
        selectedCredName = name;

        managerBody.querySelectorAll('tr').forEach(r => {
            r.classList.toggle('selected', r.getAttribute('data-name') === name);
        });

        managerEditBtn.disabled = false;
        managerDeleteBtn.disabled = false;
    }

    // Manager buttons
    document.getElementById('btn-vault-add')?.addEventListener('click', () => showEditorDialog(null));
    managerEditBtn?.addEventListener('click', () => {
        if (selectedCredName) showEditorDialog(selectedCredName);
    });
    managerDeleteBtn?.addEventListener('click', deleteSelectedCredential);
    document.getElementById('btn-vault-lock')?.addEventListener('click', async () => {
        await window.nterm.vaultLock();
        hideManagerDialog();
        await refreshVaultState();
    });
    document.getElementById('btn-vault-manager-close')?.addEventListener('click', hideManagerDialog);
    document.getElementById('btn-vault-refresh')?.addEventListener('click', refreshCredentialList);

    // Close on overlay click
    if (managerDialog) managerDialog.addEventListener('click', (e) => {
        if (e.target === managerDialog) hideManagerDialog();
    });

    async function deleteSelectedCredential() {
        if (!selectedCredName) return;

        if (!confirm(`Delete credential "${selectedCredName}"?\n\nThis cannot be undone.`)) return;

        try {
            await window.nterm.vaultRemove(selectedCredName);
            selectedCredName = null;
            managerEditBtn.disabled = true;
            managerDeleteBtn.disabled = true;
            await refreshCredentialList();
            await refreshVaultState();
        } catch (err) {
            console.error('[vault] Delete failed:', err);
        }
    }

    // ─── Credential Editor Dialog ────────────────────────────

    let editingCredName = null;

    async function showEditorDialog(name) {
        editingCredName = name;
        editorError.style.display = 'none';

        if (name) {
            editorTitle.textContent = 'Edit Credential';
            // Populate from list (metadata only — we don't send secrets back)
            const cred = credentials.find(c => c.name === name);
            if (cred) {
                edName.value = cred.name;
                edName.disabled = true;
                edUsername.value = cred.username;
                edPassword.value = '';
                edPassword.placeholder = cred.hasPassword ? '(unchanged — enter new to replace)' : '';
                edSshKey.value = '';
                edSshKey.placeholder = cred.hasSshKey ? '(unchanged — browse or paste new to replace)' : 'Paste private key PEM or use Browse...';
                edKeyPassphrase.value = '';
                edJumpHost.value = '';
                edJumpUser.value = '';
                edMatchHosts.value = '';
                edMatchTags.value = '';
                edDefault.checked = cred.isDefault;
            }
        } else {
            editorTitle.textContent = 'Add Credential';
            edName.value = '';
            edName.disabled = false;
            edUsername.value = '';
            edPassword.value = '';
            edPassword.placeholder = '';
            edSshKey.value = '';
            edSshKey.placeholder = 'Paste private key PEM or use Browse...';
            edKeyPassphrase.value = '';
            edJumpHost.value = '';
            edJumpUser.value = '';
            edMatchHosts.value = '';
            edMatchTags.value = '';
            edDefault.checked = false;
        }

        editorDialog.style.display = 'flex';
        if (!name) edName.focus();
        else edPassword.focus();
    }

    function hideEditorDialog() {
        editorDialog.style.display = 'none';
        edPassword.value = '';
        edSshKey.value = '';
        edKeyPassphrase.value = '';
    }

    async function saveCredential() {
        const name = edName.value.trim();
        const username = edUsername.value.trim();

        if (!name) { showEditorError('Name is required'); return; }
        if (!username) { showEditorError('Username is required'); return; }

        // For new credentials, must have at least one auth method
        if (!editingCredName) {
            if (!edPassword.value && !edSshKey.value.trim()) {
                showEditorError('Provide a password or SSH key (or both)');
                return;
            }
        }

        const data = { name, username };

        if (edPassword.value) data.password = edPassword.value;
        if (edSshKey.value.trim()) data.sshKey = edSshKey.value.trim();
        if (edKeyPassphrase.value) data.sshKeyPassphrase = edKeyPassphrase.value;
        if (edJumpHost.value.trim()) data.jumpHost = edJumpHost.value.trim();
        if (edJumpUser.value.trim()) data.jumpUsername = edJumpUser.value.trim();

        if (edMatchHosts.value.trim()) {
            data.matchHosts = edMatchHosts.value.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (edMatchTags.value.trim()) {
            data.matchTags = edMatchTags.value.split(',').map(s => s.trim()).filter(Boolean);
        }

        data.isDefault = edDefault.checked;

        try {
            let result;
            if (editingCredName) {
                result = await window.nterm.vaultUpdate(editingCredName, data);
            } else {
                result = await window.nterm.vaultAdd(data);
            }

            if (result.success) {
                hideEditorDialog();
                await refreshCredentialList();
                await refreshVaultState();
            } else {
                showEditorError(result.error || 'Save failed');
            }
        } catch (err) {
            showEditorError(err.message || 'Save failed');
        }
    }

    function showEditorError(msg) {
        editorError.textContent = msg;
        editorError.style.display = 'block';
    }

    document.getElementById('btn-vault-save')?.addEventListener('click', saveCredential);
    document.getElementById('btn-vault-editor-cancel')?.addEventListener('click', hideEditorDialog);

    if (editorDialog) editorDialog.addEventListener('click', (e) => {
        if (e.target === editorDialog) hideEditorDialog();
    });

    // Browse for SSH key file — reads content and populates textarea
    document.getElementById('btn-vault-browse-key')?.addEventListener('click', async () => {
        try {
            const result = await window.nterm.readKeyFile();
            if (result?.content) {
                edSshKey.value = result.content;
                // Show filename as hint
                const fileName = result.path.split(/[\\/]/).pop();
                edSshKey.placeholder = `Loaded: ${fileName}`;
            } else if (result?.error) {
                showEditorError(`Failed to read key: ${result.error}`);
            }
        } catch (err) {
            console.error('[vault] Key browse failed:', err);
        }
    });

    // ─── Vault State Refresh ─────────────────────────────────

    async function refreshVaultState() {
        try {
            vaultState = await window.nterm.vaultStatus();
        } catch {
            vaultState = { initialized: false, unlocked: false, credentialCount: 0, keychainAvailable: false };
        }
        updateIndicator();
    }

    // Listen for state changes from main process (auto-unlock, etc.)
    if (window.nterm.onVaultStateChanged) {
        window.nterm.onVaultStateChanged((state) => {
            vaultState = { ...vaultState, ...state };
            updateIndicator();
        });
    }

    // ─── Connect Dialog Integration ──────────────────────────

    /**
     * Get credential names for the connect dialog dropdown.
     * Returns [] if vault is locked or empty.
     */
    function getCredentialNames() {
        if (!vaultState.unlocked) return [];
        return credentials.map(c => c.name);
    }

    /**
     * Check if vault can resolve credentials for a host.
     * Returns { matched, credentialName, username } or null.
     */
    async function matchHost(host, port) {
        if (!vaultState.unlocked) return null;
        try {
            const result = await window.nterm.vaultMatch(host, port || 22);
            return result.matched ? result : null;
        } catch {
            return null;
        }
    }

    // ─── Public API ──────────────────────────────────────────

    window.NtermVault = {
        refreshState: refreshVaultState,
        showUnlock: showUnlockDialog,
        showManager: showManagerDialog,
        getCredentialNames,
        matchHost,
        getState: () => vaultState,
    };

    // ─── Initial State ───────────────────────────────────────
    refreshVaultState();

})();