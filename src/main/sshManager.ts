// sshManager.ts — SSH transport.
//
// Now extends TransportManager for shared IPC plumbing, state, and diagnostics.
// All ssh2-specific logic stays here: legacy algorithms, exec-channel fallback,
// keyboard-interactive, agent auth, default key discovery, retry-with-legacy.
//
// Public API preserved for main.ts:
//   connectToHost(config) · writeData(data) · setDimensions(cols, rows)
//   disconnect() · handleMessage(msg) · getDebugInfo()
//
// Cleanup from previous version:
//   - Constructor no longer creates a throwaway ssh2.Client. The earlier
//     implementation built a client + attached event handlers in the ctor,
//     then immediately replaced it with a fresh client in connectToHost,
//     so the initial handlers were dead code. Client is now created only
//     inside performConnect().
//   - Duplicate keyboard-interactive handler (ctor vs. setupKeyboardInteractive)
//     collapsed into the one real path.

import * as ssh2 from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import log from 'electron-log';
import { BrowserWindow } from 'electron';
import { classifyConnectionError } from './networkCheck';
import { TransportManager, TransportConfig } from './transportManager';

// ─── Interfaces ──────────────────────────────────────────────

export interface SSHConnectionConfig extends TransportConfig {
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

// Back-compat aliases — external code imports these names.
export type SSHConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';
export type SSHMessageType =
    | 'init' | 'connect' | 'input' | 'resize' | 'disconnect' | 'ping'
    | 'output' | 'connectionStatus' | 'error' | 'metadata' | 'diagnostic' | 'pong'
    | 'retry-with-legacy';

// ─── SSHManager ──────────────────────────────────────────────

export class SSHManager extends TransportManager {
    private client: ssh2.Client | null = null;
    private channel: ssh2.ClientChannel | null = null;
    private lastConfig: SSHConnectionConfig | null = null;
    private useExecChannel: boolean = false;

    constructor(window: BrowserWindow, connectionId: string, sessionId: string) {
        super(window, connectionId, sessionId);
        // Client is created fresh on each performConnect() — nothing to do here.
    }

    // ─── Public API — called from main.ts IPC handler ────────

    public connectToHost(config: SSHConnectionConfig): void {
        this.performConnect(config);
    }

    // ─── TransportManager hooks ──────────────────────────────

    protected performConnect(config: SSHConnectionConfig): void {
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

            // Fresh client per connection.
            this.client = new ssh2.Client();
            this.attachClientHandlers(config);

            // ── Build ssh2 connect config ───────────────────
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
                connectConfig.privateKey = config.privateKey;
                if (config.passphrase) {
                    connectConfig.passphrase = config.passphrase;
                }
                log.info(`SSHManager [${this.connectionId}]: Private key auth enabled (direct)`);
                this.sendMessage('output', { data: 'Using provided SSH key...\r\n' });
            } else if (config.privateKeyPath) {
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

    protected performWrite(data: string): void {
        if (this.channel) {
            this.channel.write(data);
        } else {
            log.warn(`SSHManager [${this.connectionId}]: performWrite called with no channel`);
        }
    }

    protected performResize(cols: number, rows: number): void {
        if (this.channel) {
            this.channel.setWindow(rows, cols, 0, 0);
        }
    }

    protected performDisconnect(): void {
        if (this.client) {
            try { this.client.end(); } catch { /* ignore */ }
        }
        this.channel = null;
        this.client = null;
    }

    /** Handle SSH-specific message types the base doesn't know about. */
    protected handleCustomMessage(message: any): boolean {
        if (message.type === 'retry-with-legacy') {
            if (this.lastConfig) {
                this.retryWithLegacyAlgorithms();
            } else {
                this.sendMessage('error', { message: 'No previous connection to retry' });
            }
            return true;
        }
        return false;
    }

    // ─── Client Event Handlers ───────────────────────────────
    // Attached after each fresh ssh2.Client construction in performConnect.

    private attachClientHandlers(config: SSHConnectionConfig): void {
        if (!this.client) return;
        const client = this.client;

        this.setupKeyboardInteractiveHandler();

        (client as any).on('banner', (message: string) => {
            this.sendMessage('output', { data: `\r\n${message}\r\n` });
        });

        (client as any).on('ready', () => {
            log.info(`SSHManager [${this.connectionId}]: Connection established`);
            this.sendMessage('output', { data: '\r\nConnection established. Opening terminal...\r\n' });
            this.status = 'connected';
            this.openShell();
        });

        (client as any).on('error', (err: Error) => {
            log.error(`SSHManager [${this.connectionId}]: Connection error: ${err.message}`);
            this.status = 'error';

            // Detect macOS Local Network permission block on private IPs
            const classification = classifyConnectionError(config.host, err.message);

            if (classification.isPermissionIssue) {
                log.warn(`SSHManager [${this.connectionId}]: Probable macOS Local Network permission denial for ${config.host}`);
                this.sendMessage('connectionStatus', {
                    status: 'error',
                    message: classification.friendlyMessage,
                });
                this.sendMessage('output', {
                    data:
                        `\r\n\x1b[1;33m⚠ ${classification.friendlyMessage}\x1b[0m\r\n` +
                        `\r\n\x1b[36m${classification.remediation}\x1b[0m\r\n`,
                });
            } else {
                this.sendMessage('connectionStatus', { status: 'error', message: `Connection error: ${err.message}` });
                this.sendMessage('output', { data: `\r\nConnection error: ${err.message}\r\n` });
            }

            if (err.message.includes('authentication') || err.message.includes('auth')) {
                log.warn(`SSHManager [${this.connectionId}]: Auth failed. Password: ${!!this.lastConfig?.password}, Key: ${!!(this.lastConfig?.privateKey || this.lastConfig?.privateKeyPath)}`);
            }
        });

        (client as any).on('close', (hadError: boolean) => {
            this.status = 'disconnected';
            this.sendMessage('connectionStatus', {
                status: 'disconnected',
                message: `Connection closed${hadError ? ' with error' : ''}`,
            });
            this.sendMessage('output', {
                data: `\r\nConnection closed${hadError ? ' with error' : ''}.\r\n`,
            });
        });

        (client as any).on('end', () => {
            log.debug(`SSHManager [${this.connectionId}]: Connection ended`);
        });
    }

    // ─── Shell / Exec Channel ────────────────────────────────

    private openShell(): void {
        if (!this.client) return;
        log.info(`SSHManager [${this.connectionId}]: Opening shell`);
        this.sendMessage('output', { data: '\r\nOpening shell session...\r\n' });

        const shellOptions: ssh2.PseudoTtyOptions = {
            term: 'xterm',
            cols: this.dimensions.cols,
            rows: this.dimensions.rows,
        };

        this.client.shell(shellOptions, (err: Error | undefined, stream: ssh2.ClientChannel) => {
            if (err) {
                // Detect network devices that don't support shell.
                // Magic-string heuristic: ssh2 surfaces these errors when a device
                // (e.g. Cisco ASA) rejects the shell request at the SSH layer.
                // Load-bearing for exec-channel fallback across vendors.
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

    // ─── Keyboard Interactive ────────────────────────────────

    private setupKeyboardInteractiveHandler(): void {
        if (!this.client) return;
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

        this.performConnect(legacyConfig);
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

    // ─── Diagnostics Override — adds SSH-specific fields ─────

    public getDebugInfo(): any {
        return {
            ...super.getDebugInfo(),
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