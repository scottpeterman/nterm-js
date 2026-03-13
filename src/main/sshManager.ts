// sshManager.ts — Ported from VS Code extension to Electron
// Changes from original:
//   - vscode.Webview.postMessage → BrowserWindow.webContents.send
//   - getLogger() → electron-log
//   - Removed vscode.window.showErrorMessage (errors go through IPC)
//   - Everything else: untouched. Battle-tested SSH logic stays as-is.

import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log';
import { BrowserWindow } from 'electron';

// ─── Interfaces ──────────────────────────────────────────────

export interface SSHConnectionConfig {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    privateKeyPath?: string;
    passphrase?: string;
    useAgent?: boolean;
    agentPath?: string;
    tryKeyboard?: boolean;
    algorithms?: SSHAlgorithms;
    authMethods?: string[];
    retryCount?: number;
    legacyMode?: boolean;
}

export interface SSHAlgorithms {
    kex?: ssh2.KexAlgorithm[];
    serverHostKey?: ssh2.ServerHostKeyAlgorithm[];
    cipher?: ssh2.CipherAlgorithm[];
    hmac?: ssh2.MacAlgorithm[];
    compress?: ssh2.CompressionAlgorithm[];
}

export type SSHConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export type SSHMessageType =
    | 'init' | 'connect' | 'input' | 'resize' | 'disconnect' | 'ping'
    | 'output' | 'connectionStatus' | 'error' | 'metadata' | 'diagnostic' | 'pong';

// ─── SSHManager ──────────────────────────────────────────────

export class SSHManager {
    private client: ssh2.Client;
    private channel: ssh2.ClientChannel | null = null;
    private window: BrowserWindow;
    private status: SSHConnectionStatus = 'disconnected';
    private dimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };
    private outputBuffer: string[] = [];
    private lastSentTime: number = 0;
    private dataReceived: number = 0;
    private dataSent: number = 0;
    private connectionId: string;
    private sessionId: string;
    private lastConfig: SSHConnectionConfig | null = null;
    private useExecChannel: boolean = false;

    constructor(window: BrowserWindow, connectionId: string, sessionId: string) {
        this.window = window;
        this.connectionId = connectionId;
        this.sessionId = sessionId;
        this.useExecChannel = false;
        this.client = new ssh2.Client();

        // Unified keyboard-interactive handler
        this.client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
            log.debug(`SSHManager [${this.connectionId}]: keyboard-interactive auth received`);
            const responses = prompts.map(() => this.lastConfig?.password || '');
            finish(responses);
        });

        this.client.on('ready', () => {
            log.info(`SSHManager [${this.connectionId}]: 'ready' event received. Authentication succeeded.`);
            this.status = 'connected';
            this.sendMessage('connectionStatus', { status: 'connected', message: 'Connection established' });
            this.sendMessage('output', { data: '\r\nConnection established. Opening terminal...\r\n' });
            this.openShell();
        });

        this.client.on('error', (err) => {
            log.error(`SSHManager [${this.connectionId}]: Connection error: ${err.message}`);
            this.status = 'error';
            this.sendMessage('connectionStatus', { status: 'error', message: `Connection error: ${err.message}` });
            this.sendMessage('output', { data: `\r\nError: ${err.message}\r\n` });
        });

        this.client.on('close', () => {
            log.info(`SSHManager [${this.connectionId}]: Connection closed.`);
            this.status = 'disconnected';
            this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Connection closed' });
            this.sendMessage('output', { data: '\r\nConnection closed.\r\n' });
        });

        this.client.on('banner', (msg) => {
            log.debug(`SSHManager [${this.connectionId}]: SSH banner: ${msg}`);
        });

        log.info(`SSHManager [${this.connectionId}]: Initialized for session ${this.sessionId}`);
        this.sendMessage('output', { data: 'SSH Terminal initialized. Waiting for connection...\r\n' });
        this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Terminal ready, waiting to connect' });
    }

    // ─── Message Transport ───────────────────────────────────
    // This is the ONE method that changed from VS Code → Electron.
    // vscode: this.webview.postMessage(message)
    // electron: this.window.webContents.send(channel, payload)

    public sendMessage(type: SSHMessageType, payload: any): void {
        try {
            const message = {
                connectionId: this.connectionId,
                sessionId: this.sessionId,
                type,
                payload,
                timestamp: Date.now(),
            };

            // Throttle large output bursts
            if (type === 'output' && payload.data && payload.data.length > 5000) {
                const timeSinceLastSend = Date.now() - this.lastSentTime;
                if (timeSinceLastSend < 100) {
                    setTimeout(() => {
                        if (!this.window.isDestroyed()) {
                            this.window.webContents.send('ssh:message', message);
                        }
                        this.lastSentTime = Date.now();
                    }, 10);
                    return;
                }
            }

            // Filter debug output from terminal display
            if (!JSON.stringify(message).includes('[DEBUG') &&
                !JSON.stringify(message).includes('[AUTH-DEBUG')) {
                if (!this.window.isDestroyed()) {
                    this.window.webContents.send('ssh:message', message);
                }
                this.lastSentTime = Date.now();
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log.error(`SSHManager [${this.connectionId}]: Error sending message: ${errorMessage}`);
        }
    }

    // ─── Message Router ──────────────────────────────────────
    // Called from main.ts IPC handler. Same protocol as VS Code extension.

    public handleMessage(message: any): void {
        if (!message || !message.type) {
            if (message && message.command) {
                this.handleLegacyMessage(message);
                return;
            }
            log.warn(`SSHManager [${this.connectionId}]: Received invalid message`);
            return;
        }

        if (message.connectionId && message.connectionId !== this.connectionId) {
            return;
        }

        try {
            switch (message.type) {
                case 'init':
                    if (message.payload?.terminalDimensions) {
                        this.setDimensions(
                            message.payload.terminalDimensions.cols,
                            message.payload.terminalDimensions.rows
                        );
                    }
                    this.sendMessage('connectionStatus', {
                        status: this.status,
                        message: 'Terminal ready, waiting to connect',
                    });
                    break;

                case 'connect':
                    if (message.payload?.connectionConfig) {
                        this.connectToHost(message.payload.connectionConfig);
                    } else {
                        this.sendMessage('error', { message: 'Missing connection parameters' });
                    }
                    break;

                case 'input':
                    if (message.payload?.data) {
                        this.writeData(message.payload.data);
                    }
                    break;

                case 'resize':
                    if (message.payload) {
                        this.setDimensions(message.payload.cols, message.payload.rows);
                    }
                    break;

                case 'disconnect':
                    this.disconnect();
                    break;

                case 'ping':
                    this.sendMessage('pong', { time: Date.now(), status: this.status });
                    break;

                case 'diagnostic':
                    this.sendDiagnostics();
                    break;

                case 'retry-with-legacy':
                    if (this.lastConfig) {
                        this.retryWithLegacyAlgorithms();
                    } else {
                        this.sendMessage('error', { message: 'No previous connection to retry' });
                    }
                    break;

                default:
                    log.warn(`SSHManager [${this.connectionId}]: Unhandled message type: ${message.type}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log.error(`SSHManager [${this.connectionId}]: Error handling message: ${errorMessage}`);
            this.sendMessage('error', { message: `Failed to process command: ${errorMessage}` });
        }
    }

    private handleLegacyMessage(message: any): void {
        switch (message.command) {
            case 'input':
                if (message.data) this.writeData(message.data);
                break;
            case 'resize':
                if (message.cols && message.rows) this.setDimensions(message.cols, message.rows);
                break;
            case 'connect':
                if (message.config) this.connectToHost(message.config);
                break;
            case 'disconnect':
                this.disconnect();
                break;
        }
    }

    // ─── Shell / Exec Channel ────────────────────────────────

    private openShell(): void {
        log.info(`SSHManager [${this.connectionId}]: Opening shell`);
        this.sendMessage('output', { data: '\r\nOpening shell session...\r\n' });

        const shellOptions: ssh2.PseudoTtyOptions = {
            term: 'xterm',
            cols: this.dimensions.cols,
            rows: this.dimensions.rows,
        };

        this.client.shell(shellOptions, (err: Error | undefined, stream: ssh2.ClientChannel) => {
            if (err) {
                // Detect network devices that don't support shell
                if (err.message.includes('expected packet type 5, got 90') ||
                    err.message.includes('Protocol error')) {
                    log.info(`SSHManager [${this.connectionId}]: Device doesn't support shell. Switching to exec channel.`);
                    this.sendMessage('output', {
                        data: '\r\nDevice doesn\'t support interactive shell.\r\nSwitching to alternative connection method...\r\n',
                    });
                    this.useExecChannel = true;
                    this.openExecTerminal();
                    return;
                }

                log.error(`SSHManager [${this.connectionId}]: Failed to open shell: ${err.message}`);
                this.sendMessage('output', { data: `\r\nFailed to open shell: ${err.message}\r\n` });
                return;
            }

            this.channel = stream;
            log.info(`SSHManager [${this.connectionId}]: Shell opened (${this.dimensions.cols}x${this.dimensions.rows})`);
            this.sendMessage('output', {
                data: `\r\nShell session opened (${this.dimensions.cols}x${this.dimensions.rows})\r\n`,
            });
            this.sendMessage('connectionStatus', { status: 'connected', message: 'Connected (shell)' });
            this.setupStreamHandlers(stream);
        });
    }

    private openExecTerminal(): void {
        if (!this.client) {
            log.error(`SSHManager [${this.connectionId}]: Cannot open exec terminal, client not connected`);
            return;
        }

        const terminalCmd = 'terminal length 0';
        log.info(`SSHManager [${this.connectionId}]: Opening exec terminal with: ${terminalCmd}`);

        this.client.exec(terminalCmd,
            { pty: { term: 'vt100', cols: this.dimensions.cols, rows: this.dimensions.rows } },
            (err: Error | undefined, stream: ssh2.ClientChannel) => {
                if (err) {
                    log.error(`SSHManager [${this.connectionId}]: Failed to open exec terminal: ${err.message}`);
                    this.sendMessage('output', { data: `\r\nFailed to open exec terminal: ${err.message}\r\n` });
                    return;
                }

                this.channel = stream;
                this.setupStreamHandlers(stream);
                log.info(`SSHManager [${this.connectionId}]: Exec terminal opened (${this.dimensions.cols}x${this.dimensions.rows})`);
                this.sendMessage('connectionStatus', { status: 'connected', message: 'Connected (exec terminal)' });
                this.sendMessage('output', { data: '\r\nTerminal session opened using exec channel\r\n' });
            });
    }

    private setupStreamHandlers(stream: ssh2.ClientChannel): void {
        stream.on('data', (data: Buffer) => {
            this.dataReceived += data.length;
            this.sendMessage('output', { data: data.toString('utf8') });
        });

        stream.stderr.on('data', (data: Buffer) => {
            this.dataReceived += data.length;
            this.sendMessage('output', { data: data.toString('utf8') });
        });

        stream.on('close', () => {
            log.info(`SSHManager [${this.connectionId}]: Stream closed`);
            this.sendMessage('output', { data: '\r\nConnection closed\r\n' });
            this.status = 'disconnected';
            this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Disconnected' });
        });
    }

    // ─── Connect ─────────────────────────────────────────────

    public connectToHost(config: SSHConnectionConfig): void {
        try {
            this.lastConfig = { ...config };
            this.lastConfig.tryKeyboard = config.tryKeyboard !== undefined ? config.tryKeyboard : true;
            this.useExecChannel = false;
            this.status = 'connecting';

            log.info(`SSHManager [${this.connectionId}]: Connecting to ${config.host}:${config.port} as ${config.username}`);

            this.sendMessage('connectionStatus', {
                status: 'connecting',
                message: `Connecting to ${config.host}:${config.port}`,
            });
            this.sendMessage('output', {
                data: `Connecting to ${config.host}:${config.port} as ${config.username}...\r\n`,
            });

            // Fresh client for each connection
            this.client = new ssh2.Client();
            this.setupKeyboardInteractiveHandler();

            (this.client as any).on('banner', (message: string) => {
                this.sendMessage('output', { data: `\r\n${message}\r\n` });
            });

            (this.client as any).on('ready', () => {
                log.info(`SSHManager [${this.connectionId}]: Connection established`);
                this.sendMessage('output', { data: '\r\nConnection established. Opening terminal...\r\n' });
                this.status = 'connected';
                this.openShell();
            });

            (this.client as any).on('error', (err: Error) => {
                log.error(`SSHManager [${this.connectionId}]: Connection error: ${err.message}`);
                this.status = 'error';
                this.sendMessage('connectionStatus', { status: 'error', message: `Connection error: ${err.message}` });
                this.sendMessage('output', { data: `\r\nConnection error: ${err.message}\r\n` });

                if (err.message.includes('authentication') || err.message.includes('auth')) {
                    log.warn(`SSHManager [${this.connectionId}]: Auth failed. Password: ${!!this.lastConfig?.password}, Key: ${!!(this.lastConfig?.privateKey || this.lastConfig?.privateKeyPath)}`);
                }
            });

            (this.client as any).on('close', (hadError: boolean) => {
                this.status = 'disconnected';
                this.sendMessage('connectionStatus', {
                    status: 'disconnected',
                    message: `Connection closed${hadError ? ' with error' : ''}`,
                });
                this.sendMessage('output', {
                    data: `\r\nConnection closed${hadError ? ' with error' : ''}.\r\n`,
                });
            });

            (this.client as any).on('end', () => {
                log.debug(`SSHManager [${this.connectionId}]: Connection ended`);
            });

            // Build ssh2 connect config
            const connectConfig: ssh2.ConnectConfig = {
                host: config.host,
                port: config.port,
                username: config.username,
                readyTimeout: 30000,
                keepaliveInterval: 15000,
                keepaliveCountMax: 3,
                tryKeyboard: true,
            };

            // ── Auth: Password ──────────────────────────────
            if (config.password) {
                connectConfig.password = config.password;
                log.info(`SSHManager [${this.connectionId}]: Password auth enabled`);
            }

            // ── Auth: Key file ──────────────────────────────
            if (config.privateKey) {
                // Raw key buffer/string provided directly
                connectConfig.privateKey = config.privateKey;
                if (config.passphrase) {
                    connectConfig.passphrase = config.passphrase;
                }
                log.info(`SSHManager [${this.connectionId}]: Private key auth enabled (direct)`);
                this.sendMessage('output', { data: 'Using provided SSH key...\r\n' });
            } else if (config.privateKeyPath) {
                // Key file path provided — read it
                try {
                    const resolvedPath = config.privateKeyPath.startsWith('~')
                        ? path.join(os.homedir(), config.privateKeyPath.slice(1))
                        : config.privateKeyPath;

                    if (fs.existsSync(resolvedPath)) {
                        connectConfig.privateKey = fs.readFileSync(resolvedPath);
                        if (config.passphrase) {
                            connectConfig.passphrase = config.passphrase;
                        }
                        log.info(`SSHManager [${this.connectionId}]: Private key auth enabled from ${resolvedPath}`);
                        this.sendMessage('output', { data: `Using SSH key from ${resolvedPath}...\r\n` });
                    } else {
                        log.warn(`SSHManager [${this.connectionId}]: Key file not found: ${resolvedPath}`);
                        this.sendMessage('output', { data: `Warning: Key file not found: ${resolvedPath}\r\n` });
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    log.error(`SSHManager [${this.connectionId}]: Failed to read key file: ${msg}`);
                    this.sendMessage('output', { data: `Warning: Failed to read key file: ${msg}\r\n` });
                }
            } else if (!config.password) {
                // No password, no explicit key — try default key locations
                this.tryLoadDefaultKeys(connectConfig);
            }

            // ── Auth: SSH Agent ─────────────────────────────
            if (config.useAgent) {
                connectConfig.agent = config.agentPath ||
                    (process.platform === 'win32'
                        ? 'pageant'
                        : process.env.SSH_AUTH_SOCK || '');
                log.info(`SSHManager [${this.connectionId}]: Agent auth enabled: ${connectConfig.agent}`);
                this.sendMessage('output', { data: `Using SSH agent: ${connectConfig.agent}...\r\n` });
            }

            // ── Algorithms ──────────────────────────────────
            if (config.legacyMode) {
                this.applyLegacyAlgorithms(connectConfig);
            } else {
                this.applyDefaultAlgorithms(connectConfig, config);
            }

            // ── Connect ─────────────────────────────────────
            log.info(`SSHManager [${this.connectionId}]: Initiating SSH2 connection...`);
            this.client.connect(connectConfig);

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            log.error(`SSHManager [${this.connectionId}]: Error initiating connection: ${errorMessage}`);
            this.status = 'error';
            this.sendMessage('connectionStatus', { status: 'error', message: `Connection failed: ${errorMessage}` });
            this.sendMessage('output', { data: `\r\nError initiating connection: ${errorMessage}\r\n` });
        }
    }

    // ─── Keyboard Interactive ────────────────────────────────

    private setupKeyboardInteractiveHandler(): void {
        (this.client as any).on('keyboard-interactive',
            (name: string, instructions: string, lang: string,
             prompts: Array<{ prompt: string; echo: boolean }>,
             finish: (responses: string[]) => void) => {

                log.debug(`SSHManager [${this.connectionId}]: keyboard-interactive: ${prompts.length} prompt(s)`);

                const responses: string[] = [];
                for (const prompt of prompts) {
                    const promptText = prompt.prompt.toLowerCase();
                    const isPasswordPrompt =
                        promptText.includes('password') ||
                        !prompt.echo ||
                        promptText.includes('認証') ||
                        promptText.includes('密码') ||
                        promptText.includes('contraseña');

                    if (isPasswordPrompt && this.lastConfig?.password) {
                        responses.push(this.lastConfig.password);
                    } else {
                        responses.push('');
                    }
                }

                try {
                    finish(responses);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    log.error(`SSHManager [${this.connectionId}]: keyboard-interactive finish() error: ${msg}`);
                }
            });
    }

    // ─── Algorithm Configuration ─────────────────────────────

    private applyDefaultAlgorithms(connectConfig: ssh2.ConnectConfig, userConfig: SSHConnectionConfig): void {
        if (userConfig.algorithms) {
            connectConfig.algorithms = { ...userConfig.algorithms };
            return;
        }

        // Conservative defaults — modern first, legacy fallback
        connectConfig.algorithms = {
            kex: [
                'ecdh-sha2-nistp256',
                'ecdh-sha2-nistp384',
                'ecdh-sha2-nistp521',
                'diffie-hellman-group-exchange-sha256',
                'diffie-hellman-group14-sha256',
                'diffie-hellman-group14-sha1',
                'diffie-hellman-group-exchange-sha1',
                'diffie-hellman-group1-sha1',
            ] as ssh2.KexAlgorithm[],
            serverHostKey: [
                'ssh-ed25519',
                'ecdsa-sha2-nistp256',
                'ecdsa-sha2-nistp384',
                'ecdsa-sha2-nistp521',
                'rsa-sha2-512',
                'rsa-sha2-256',
                'ssh-rsa',
                'ssh-dss',
            ] as ssh2.ServerHostKeyAlgorithm[],
            cipher: [
                'aes128-ctr',
                'aes192-ctr',
                'aes256-ctr',
                'aes128-gcm@openssh.com',
                'aes256-gcm@openssh.com',
                'aes128-cbc',
                'aes192-cbc',
                'aes256-cbc',
                '3des-cbc',
            ] as ssh2.CipherAlgorithm[],
            hmac: [
                'hmac-sha2-256-etm@openssh.com',
                'hmac-sha2-512-etm@openssh.com',
                'hmac-sha2-256',
                'hmac-sha2-512',
                'hmac-sha1',
                'hmac-md5',
            ] as ssh2.MacAlgorithm[],
            compress: [
                'none',
                'zlib@openssh.com',
                'zlib',
            ] as ssh2.CompressionAlgorithm[],
        };
    }

    private applyLegacyAlgorithms(connectConfig: ssh2.ConnectConfig): void {
        log.info(`SSHManager [${this.connectionId}]: Applying legacy algorithms for older network devices`);
        this.sendMessage('output', { data: 'Using legacy algorithms for older device compatibility...\r\n' });

        connectConfig.algorithms = {
            kex: [
                'diffie-hellman-group1-sha1',
                'diffie-hellman-group14-sha1',
                'diffie-hellman-group-exchange-sha1',
                'diffie-hellman-group-exchange-sha256',
                'diffie-hellman-group14-sha256',
                'ecdh-sha2-nistp256',
            ] as ssh2.KexAlgorithm[],
            serverHostKey: [
                'ssh-rsa',
                'ssh-dss',
                'ecdsa-sha2-nistp256',
                'rsa-sha2-256',
            ] as ssh2.ServerHostKeyAlgorithm[],
            cipher: [
                '3des-cbc',
                'aes128-cbc',
                'aes192-cbc',
                'aes256-cbc',
                'aes128-ctr',
                'aes192-ctr',
                'aes256-ctr',
            ] as ssh2.CipherAlgorithm[],
            hmac: [
                'hmac-sha1',
                'hmac-md5',
                'hmac-sha1-96',
                'hmac-md5-96',
                'hmac-sha2-256',
                'hmac-sha2-512',
            ] as ssh2.MacAlgorithm[],
            compress: [
                'none',
                'zlib@openssh.com',
                'zlib',
            ] as ssh2.CompressionAlgorithm[],
        };
    }

    private retryWithLegacyAlgorithms(): void {
        if (!this.lastConfig) {
            this.sendMessage('output', { data: '\r\nError: No previous connection to retry.\r\n' });
            return;
        }

        log.info(`SSHManager [${this.connectionId}]: Retrying with legacy algorithms`);
        this.sendMessage('output', { data: '\r\nRetrying connection with legacy algorithms...\r\n' });

        const legacyConfig: SSHConnectionConfig = {
            ...this.lastConfig,
            legacyMode: true,
            tryKeyboard: true,
            authMethods: ['keyboard-interactive', 'password'],
        };

        this.connectToHost(legacyConfig);
    }

    // ─── Default Key Discovery ───────────────────────────────

    private tryLoadDefaultKeys(connectConfig: ssh2.ConnectConfig): void {
        const keyTypes = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];

        for (const keyType of keyTypes) {
            const keyPath = path.join(os.homedir(), '.ssh', keyType);
            if (fs.existsSync(keyPath)) {
                try {
                    connectConfig.privateKey = fs.readFileSync(keyPath);
                    log.info(`SSHManager [${this.connectionId}]: Using key from ${keyPath}`);
                    this.sendMessage('output', { data: `Using SSH key from ${keyPath}...\r\n` });
                    return;
                } catch (err) {
                    log.error(`SSHManager [${this.connectionId}]: Failed to read key: ${keyPath}`);
                }
            }
        }

        log.warn(`SSHManager [${this.connectionId}]: No SSH keys found in ~/.ssh/`);
        this.sendMessage('output', { data: 'No SSH keys found in ~/.ssh/ directory\r\n' });
    }

    // ─── Data I/O ────────────────────────────────────────────

    public writeData(data: string): void {
        if (this.channel && this.status === 'connected') {
            this.dataSent += data.length;
            this.channel.write(data);
        } else {
            const msg = `Cannot send data — channel ${this.channel ? 'exists' : 'missing'}, status: ${this.status}`;
            log.warn(`SSHManager [${this.connectionId}]: ${msg}`);
            this.sendMessage('output', { data: `\r\n[Warning] ${msg}\r\n` });
        }
    }

    public setDimensions(cols: number, rows: number): void {
        if (!cols || !rows || cols <= 0 || rows <= 0) return;

        this.dimensions = { cols, rows };

        if (this.channel && this.status === 'connected') {
            try {
                this.channel.setWindow(rows, cols, 0, 0);
            } catch (err) {
                log.error(`SSHManager [${this.connectionId}]: Failed to set window dimensions`);
            }
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────

    public disconnect(): void {
        if (this.status !== 'disconnected') {
            log.info(`SSHManager [${this.connectionId}]: Disconnecting`);
            this.sendMessage('output', { data: '\r\nDisconnecting from SSH session...\r\n' });
            this.client.end();
            this.status = 'disconnected';
            this.channel = null;
            this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Disconnected' });
        }
    }

    public getStatus(): SSHConnectionStatus {
        return this.status;
    }

    public isConnected(): boolean {
        return this.status === 'connected';
    }

    // ─── Diagnostics ─────────────────────────────────────────

    public getDebugInfo(): any {
        return {
            connectionId: this.connectionId,
            sessionId: this.sessionId,
            status: this.status,
            dimensions: this.dimensions,
            bytesReceived: this.dataReceived,
            bytesSent: this.dataSent,
            lastConfig: this.lastConfig ? {
                host: this.lastConfig.host,
                port: this.lastConfig.port,
                username: this.lastConfig.username,
                authMethods: this.lastConfig.authMethods || ['keyboard-interactive', 'password'],
                useAgent: this.lastConfig.useAgent || false,
                tryKeyboard: this.lastConfig.tryKeyboard || false,
                passwordProvided: !!this.lastConfig.password,
                privateKeyProvided: !!(this.lastConfig.privateKey || this.lastConfig.privateKeyPath),
                legacyMode: this.lastConfig.legacyMode || false,
            } : null,
        };
    }

    public sendDiagnostics(): void {
        const info = this.getDebugInfo();
        this.sendMessage('diagnostic', info);
        this.sendMessage('output', {
            data:
                '\r\n----- SSH DIAGNOSTICS -----\r\n' +
                `Connection ID: ${this.connectionId}\r\n` +
                `Session ID: ${this.sessionId}\r\n` +
                `Status: ${this.status}\r\n` +
                `Dimensions: ${this.dimensions.cols}x${this.dimensions.rows}\r\n` +
                `Bytes sent: ${this.dataSent}\r\n` +
                `Bytes received: ${this.dataReceived}\r\n` +
                `Auth: password=${!!this.lastConfig?.password}, key=${!!(this.lastConfig?.privateKey || this.lastConfig?.privateKeyPath)}, agent=${!!this.lastConfig?.useAgent}\r\n` +
                `Legacy mode: ${this.lastConfig?.legacyMode || false}\r\n` +
                '----------------------------\r\n',
        });
    }
}
