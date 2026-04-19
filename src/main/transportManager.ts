// transportManager.ts — Base class for SSH / telnet / serial transports.
//
// Owns the transport-agnostic plumbing:
//   - IPC message send (with burst throttling + debug filtering)
//   - IPC message routing (init / input / resize / disconnect / ping / diagnostic)
//   - Connection status state machine
//   - Dimension tracking + byte counters
//   - Diagnostics emission
//
// Subclasses implement four hooks:
//   - performConnect(config)   — open the transport
//   - performWrite(data)       — send user input
//   - performResize(cols, rows)— optional; default is no-op
//   - performDisconnect()      — close the transport
//
// The IPC channel name stays 'ssh:message' for back-compat with the renderer.
// Semantically it's now "transport:message"; rename is future work.

import log from 'electron-log';
import { BrowserWindow } from 'electron';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

export type TransportMessageType =
    | 'init' | 'connect' | 'input' | 'resize' | 'disconnect' | 'ping'
    | 'output' | 'connectionStatus' | 'error' | 'metadata' | 'diagnostic' | 'pong';

export interface TransportConfig {
    host: string;
    port: number;
    protocol?: 'ssh' | 'telnet' | 'serial';
    // Subclasses extend with their own fields (username, baud, etc.)
    [key: string]: any;
}

export abstract class TransportManager {
    protected window: BrowserWindow;
    protected connectionId: string;
    protected sessionId: string;
    protected status: ConnectionStatus = 'disconnected';
    protected dimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };
    protected dataReceived: number = 0;
    protected dataSent: number = 0;
    private lastSentTime: number = 0;

    constructor(window: BrowserWindow, connectionId: string, sessionId: string) {
        this.window = window;
        this.connectionId = connectionId;
        this.sessionId = sessionId;

        log.info(`TransportManager [${this.connectionId}]: Initialized for session ${this.sessionId}`);
        this.sendMessage('output', { data: 'Terminal initialized. Waiting for connection...\r\n' });
        this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Terminal ready, waiting to connect' });
    }

    // ─── Abstract hooks — subclasses implement ───────────────

    protected abstract performConnect(config: TransportConfig): void;
    protected abstract performWrite(data: string): void;
    protected abstract performDisconnect(): void;

    /** Optional — default is no-op. Serial ignores resize; telnet uses NAWS if negotiated. */
    protected performResize(_cols: number, _rows: number): void { /* no-op */ }

    // ─── Message Transport ───────────────────────────────────
    // Shared 'ssh:message' IPC channel for back-compat with the renderer.

    public sendMessage(type: TransportMessageType | string, payload: any): void {
        try {
            const message = {
                connectionId: this.connectionId,
                sessionId: this.sessionId,
                type,
                payload,
                timestamp: Date.now(),
            };

            // Filter debug output from terminal display.
            // Direct substring check on payload.data — avoids JSON.stringify on
            // large bulk output, which was a hot path in the previous impl.
            if (type === 'output' && typeof payload?.data === 'string') {
                if (payload.data.includes('[DEBUG') || payload.data.includes('[AUTH-DEBUG')) {
                    return;
                }
            }

            // Throttle large output bursts (>5KB) to at most one per 100ms.
            if (type === 'output' && payload?.data && payload.data.length > 5000) {
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

            if (!this.window.isDestroyed()) {
                this.window.webContents.send('ssh:message', message);
            }
            this.lastSentTime = Date.now();
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log.error(`TransportManager [${this.connectionId}]: Error sending message: ${errorMessage}`);
        }
    }

    // ─── Message Router ──────────────────────────────────────

    public handleMessage(message: any): void {
        if (!message || !message.type) {
            if (message && message.command) {
                this.handleLegacyMessage(message);
                return;
            }
            log.warn(`TransportManager [${this.connectionId}]: Received invalid message`);
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
                        this.performConnect(message.payload.connectionConfig);
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

                default:
                    // Subclass hook — return true if the custom type was handled.
                    if (!this.handleCustomMessage(message)) {
                        log.warn(`TransportManager [${this.connectionId}]: Unhandled message type: ${message.type}`);
                    }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log.error(`TransportManager [${this.connectionId}]: Error handling message: ${errorMessage}`);
            this.sendMessage('error', { message: `Failed to process command: ${errorMessage}` });
        }
    }

    /** Subclasses override to handle transport-specific message types. Return true if handled. */
    protected handleCustomMessage(_message: any): boolean {
        return false;
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
                if (message.config) this.performConnect(message.config);
                break;
            case 'disconnect':
                this.disconnect();
                break;
        }
    }

    // ─── Data I/O ────────────────────────────────────────────

    public writeData(data: string): void {
        if (this.status === 'connected') {
            this.dataSent += data.length;
            this.performWrite(data);
        } else {
            const msg = `Cannot send data — status: ${this.status}`;
            log.warn(`TransportManager [${this.connectionId}]: ${msg}`);
            this.sendMessage('output', { data: `\r\n[Warning] ${msg}\r\n` });
        }
    }

    public setDimensions(cols: number, rows: number): void {
        if (!cols || !rows || cols <= 0 || rows <= 0) return;
        this.dimensions = { cols, rows };
        if (this.status === 'connected') {
            try {
                this.performResize(cols, rows);
            } catch (err) {
                log.error(`TransportManager [${this.connectionId}]: Failed to resize: ${err}`);
            }
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────

    public disconnect(): void {
        if (this.status !== 'disconnected') {
            log.info(`TransportManager [${this.connectionId}]: Disconnecting`);
            this.sendMessage('output', { data: '\r\nDisconnecting...\r\n' });
            try {
                this.performDisconnect();
            } catch (err) {
                log.error(`TransportManager [${this.connectionId}]: Error in performDisconnect: ${err}`);
            }
            this.status = 'disconnected';
            this.sendMessage('connectionStatus', { status: 'disconnected', message: 'Disconnected' });
        }
    }

    public getStatus(): ConnectionStatus {
        return this.status;
    }

    public isConnected(): boolean {
        return this.status === 'connected';
    }

    // ─── Diagnostics ─────────────────────────────────────────
    // Subclasses override getDebugInfo() to add transport-specific fields.

    public getDebugInfo(): any {
        return {
            connectionId: this.connectionId,
            sessionId: this.sessionId,
            status: this.status,
            dimensions: this.dimensions,
            bytesReceived: this.dataReceived,
            bytesSent: this.dataSent,
        };
    }

    public sendDiagnostics(): void {
        const info = this.getDebugInfo();
        this.sendMessage('diagnostic', info);
        this.sendMessage('output', {
            data:
                '\r\n----- DIAGNOSTICS -----\r\n' +
                `Connection ID: ${this.connectionId}\r\n` +
                `Session ID: ${this.sessionId}\r\n` +
                `Status: ${this.status}\r\n` +
                `Dimensions: ${this.dimensions.cols}x${this.dimensions.rows}\r\n` +
                `Bytes sent: ${this.dataSent}\r\n` +
                `Bytes received: ${this.dataReceived}\r\n` +
                '----------------------------\r\n',
        });
    }
}