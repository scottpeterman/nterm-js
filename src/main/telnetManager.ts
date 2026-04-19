// telnetManager.ts — Telnet transport over TCP socket.
//
// Minimum-viable IAC (Interpret As Command) negotiation:
//   - WILL NAWS    — advertised on connect; send window size updates
//   - WILL ECHO    — accepted (let server handle character echo)
//   - WILL SGA     — accepted (suppress go-ahead / char-at-a-time mode)
//   - Everything else — refused (WONT / DONT)
//
// Line mode: RFC 854 specifies CR LF as the telnet EOL. xterm.js emits a
// bare \r on Enter; we normalize both \r and \n to \r\n on write. Most
// network devices and reverse-telnet console servers expect this.
//
// Escape handling: 0xFF bytes in user data or NAWS size fields must be
// doubled on the wire per RFC 854 §3.
//
// Use cases this covers: legacy telnet-only gear, GNS3 / dynamips console
// ports (reverse telnet to 127.0.0.1:500x), and terminal-server lines.

import * as net from 'net';
import log from 'electron-log';
import { BrowserWindow } from 'electron';
import { TransportManager, TransportConfig } from './transportManager';

// ─── IAC codes (RFC 854) ────────────────────────────────────

const IAC  = 0xFF;
const DONT = 0xFE;
const DO   = 0xFD;
const WONT = 0xFC;
const WILL = 0xFB;
const SB   = 0xFA;
const SE   = 0xF0;

const OPT_ECHO  = 0x01;
const OPT_SGA   = 0x03;
const OPT_TTYPE = 0x18;
const OPT_NAWS  = 0x1F;

// ─── TelnetManager ──────────────────────────────────────────

export class TelnetManager extends TransportManager {
    private socket: net.Socket | null = null;
    private nawsNegotiated: boolean = false;
    private lastConfig: TransportConfig | null = null;

    constructor(window: BrowserWindow, connectionId: string, sessionId: string) {
        super(window, connectionId, sessionId);
    }

    /** Public entry for parity with SSHManager — called from main.ts. */
    public connectToHost(config: TransportConfig): void {
        this.performConnect(config);
    }

    // ─── TransportManager hooks ─────────────────────────────

    protected performConnect(config: TransportConfig): void {
        try {
            this.lastConfig = { ...config };
            this.status = 'connecting';
            this.nawsNegotiated = false;

            log.info(`TelnetManager [${this.connectionId}]: Connecting to ${config.host}:${config.port}`);
            this.sendMessage('connectionStatus', {
                status: 'connecting',
                message: `Connecting to ${config.host}:${config.port}`,
            });
            this.sendMessage('output', {
                data: `Connecting to ${config.host}:${config.port} via telnet...\r\n`,
            });

            this.socket = net.createConnection({ host: config.host, port: config.port }, () => {
                log.info(`TelnetManager [${this.connectionId}]: TCP connection established`);
                this.status = 'connected';
                this.sendMessage('connectionStatus', { status: 'connected', message: 'Telnet connection established' });
                this.sendMessage('output', { data: '\r\nTelnet connection established.\r\n' });

                // Advertise NAWS — server will DO or DONT
                this.sendIAC([WILL, OPT_NAWS]);
            });

            this.socket.setNoDelay(true);

            this.socket.on('data', (chunk: Buffer) => this.handleIncoming(chunk));

            this.socket.on('error', (err: Error) => {
                log.error(`TelnetManager [${this.connectionId}]: Socket error: ${err.message}`);
                this.status = 'error';
                this.sendMessage('connectionStatus', { status: 'error', message: `Telnet error: ${err.message}` });
                this.sendMessage('output', { data: `\r\nError: ${err.message}\r\n` });
            });

            this.socket.on('close', (hadError: boolean) => {
                log.info(`TelnetManager [${this.connectionId}]: Socket closed (hadError=${hadError})`);
                // Only report disconnected if we weren't already errored (avoids double-emit)
                if (this.status !== 'error') {
                    this.status = 'disconnected';
                    this.sendMessage('connectionStatus', {
                        status: 'disconnected',
                        message: `Connection closed${hadError ? ' with error' : ''}`,
                    });
                    this.sendMessage('output', {
                        data: `\r\nConnection closed${hadError ? ' with error' : ''}.\r\n`,
                    });
                }
                this.socket = null;
            });

        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            log.error(`TelnetManager [${this.connectionId}]: Error initiating connection: ${errorMessage}`);
            this.status = 'error';
            this.sendMessage('connectionStatus', { status: 'error', message: `Connection failed: ${errorMessage}` });
            this.sendMessage('output', { data: `\r\nError initiating connection: ${errorMessage}\r\n` });
        }
    }

    protected performWrite(data: string): void {
        if (!this.socket || this.status !== 'connected') {
            log.warn(`TelnetManager [${this.connectionId}]: performWrite without socket`);
            return;
        }

        // Per RFC 854, the telnet EOL is CR LF. xterm.js emits bare \r on Enter;
        // normalize both \r and \n to \r\n on the wire. Existing \r\n pairs pass
        // through unchanged.
        const normalized = this.normalizeLineEndings(data);

        // 0xFF (IAC) in user data must be escaped by doubling.
        const buf = Buffer.from(normalized, 'utf8');
        if (buf.includes(IAC)) {
            const escaped: number[] = [];
            for (const b of buf) {
                escaped.push(b);
                if (b === IAC) escaped.push(IAC);
            }
            this.socket.write(Buffer.from(escaped));
        } else {
            this.socket.write(buf);
        }
    }

    protected performResize(_cols: number, _rows: number): void {
        if (this.nawsNegotiated) {
            this.sendNAWS();
        }
    }

    protected performDisconnect(): void {
        if (this.socket) {
            try { this.socket.destroy(); } catch { /* ignore */ }
        }
        this.socket = null;
        this.nawsNegotiated = false;
    }

    // ─── Line Ending Normalization ──────────────────────────

    private normalizeLineEndings(data: string): string {
        // \r\n → \r\n, bare \r → \r\n, bare \n → \r\n
        return data.replace(/\r\n|\r|\n/g, '\r\n');
    }

    // ─── IAC State Machine ─────────────────────────────────

    private handleIncoming(chunk: Buffer): void {
        const out: number[] = [];
        let i = 0;

        while (i < chunk.length) {
            const b = chunk[i];

            if (b === IAC && i + 1 < chunk.length) {
                const cmd = chunk[i + 1];

                // Escaped 0xFF in data stream — emit a single 0xFF.
                if (cmd === IAC) {
                    out.push(IAC);
                    i += 2;
                    continue;
                }

                // Option negotiation: WILL / WONT / DO / DONT + option byte
                if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
                    if (i + 2 < chunk.length) {
                        this.handleNegotiation(cmd, chunk[i + 2]);
                        i += 3;
                        continue;
                    }
                    // Incomplete sequence at end of buffer — MVP accepts this
                    // as lossy. A cross-packet buffer could catch it, but in
                    // practice negotiation sequences land in a single packet.
                    i = chunk.length;
                    continue;
                }

                // Subnegotiation: IAC SB ... IAC SE — skip contents.
                if (cmd === SB) {
                    const seIdx = chunk.indexOf(Buffer.from([IAC, SE]), i + 2);
                    i = seIdx === -1 ? chunk.length : seIdx + 2;
                    continue;
                }

                // Other IAC commands (NOP, DM, BRK, AYT, etc.) — skip 2 bytes.
                i += 2;
                continue;
            }

            // Regular data byte
            out.push(b);
            i++;
        }

        if (out.length > 0) {
            this.dataReceived += out.length;
            this.sendMessage('output', { data: Buffer.from(out).toString('utf8') });
        }
    }

    private handleNegotiation(cmd: number, opt: number): void {
        if (!this.socket) return;
        log.debug(`TelnetManager [${this.connectionId}]: IAC ${cmdName(cmd)} ${optName(opt)}`);

        // Server declares intent (WILL / WONT)
        if (cmd === WILL) {
            // Accept ECHO (server handles echo) and SGA (char-at-a-time mode)
            const accept = (opt === OPT_ECHO || opt === OPT_SGA);
            this.sendIAC([accept ? DO : DONT, opt]);
            return;
        }
        if (cmd === WONT) {
            // Server refusing — acknowledge with DONT
            this.sendIAC([DONT, opt]);
            return;
        }

        // Server asks us (DO / DONT)
        if (cmd === DO) {
            if (opt === OPT_NAWS) {
                this.nawsNegotiated = true;
                this.sendIAC([WILL, OPT_NAWS]);
                this.sendNAWS();
            } else {
                this.sendIAC([WONT, opt]);
            }
            return;
        }
        if (cmd === DONT) {
            if (opt === OPT_NAWS) this.nawsNegotiated = false;
            this.sendIAC([WONT, opt]);
            return;
        }
    }

    private sendIAC(bytes: number[]): void {
        if (!this.socket) return;
        const buf = Buffer.concat([Buffer.from([IAC]), Buffer.from(bytes)]);
        this.socket.write(buf);
    }

    private sendNAWS(): void {
        if (!this.socket) return;
        const { cols, rows } = this.dimensions;

        // RFC 1073: IAC SB NAWS WIDTH[hi] WIDTH[lo] HEIGHT[hi] HEIGHT[lo] IAC SE
        // Any 0xFF byte in size fields must be doubled.
        const sizeBytes: number[] = [];
        const pushEscaped = (n: number) => {
            sizeBytes.push(n);
            if (n === 0xFF) sizeBytes.push(0xFF);
        };
        pushEscaped((cols >> 8) & 0xFF);
        pushEscaped(cols & 0xFF);
        pushEscaped((rows >> 8) & 0xFF);
        pushEscaped(rows & 0xFF);

        const packet = Buffer.from([IAC, SB, OPT_NAWS, ...sizeBytes, IAC, SE]);
        this.socket.write(packet);
        log.debug(`TelnetManager [${this.connectionId}]: NAWS ${cols}x${rows}`);
    }

    // ─── Diagnostics Override ──────────────────────────────

    public getDebugInfo(): any {
        return {
            ...super.getDebugInfo(),
            protocol: 'telnet',
            nawsNegotiated: this.nawsNegotiated,
            lastConfig: this.lastConfig ? {
                host: this.lastConfig.host,
                port: this.lastConfig.port,
            } : null,
        };
    }

    public sendDiagnostics(): void {
        this.sendMessage('diagnostic', this.getDebugInfo());
        this.sendMessage('output', {
            data:
                '\r\n----- TELNET DIAGNOSTICS -----\r\n' +
                `Connection ID: ${this.connectionId}\r\n` +
                `Session ID: ${this.sessionId}\r\n` +
                `Status: ${this.status}\r\n` +
                `Dimensions: ${this.dimensions.cols}x${this.dimensions.rows}\r\n` +
                `NAWS negotiated: ${this.nawsNegotiated}\r\n` +
                `Bytes sent: ${this.dataSent}\r\n` +
                `Bytes received: ${this.dataReceived}\r\n` +
                '----------------------------\r\n',
        });
    }
}

// ─── Helpers (debug logging) ───────────────────────────────

function cmdName(cmd: number): string {
    if (cmd === WILL) return 'WILL';
    if (cmd === WONT) return 'WONT';
    if (cmd === DO)   return 'DO';
    if (cmd === DONT) return 'DONT';
    return `0x${cmd.toString(16)}`;
}

function optName(opt: number): string {
    if (opt === OPT_ECHO)  return 'ECHO';
    if (opt === OPT_SGA)   return 'SGA';
    if (opt === OPT_NAWS)  return 'NAWS';
    if (opt === OPT_TTYPE) return 'TTYPE';
    return `0x${opt.toString(16)}`;
}