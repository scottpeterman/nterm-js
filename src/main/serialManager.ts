// serialManager.ts — Serial transport (RS-232 / USB-to-serial / console cables).
//
// Built for network gear consoles (Cisco / Juniper / Arista / generic ROMMON),
// which is the primary use case. scripts/serial-cli.js in this repo was the
// reference implementation for port enumeration, break handling, and error
// classification.
//
// Behavior notes:
//
//  - Line endings: xterm.js emits bare \r on Enter. Network console firmware
//    is unanimously happy with bare CR and sometimes unhappy with CRLF
//    (double-newlines on older IOS). Default is 'cr' — user can switch to
//    crlf / lf / raw in the quick-connect dialog if needed.
//
//  - Local echo: off by default. Some devices (raw UARTs, bootloaders in
//    early stages) don't echo; local echo mirrors each write back to xterm
//    after line-ending normalization, so display matches the wire.
//
//  - Break signal: Cisco ROMMON / password recovery workflows need a serial
//    BREAK. Two flavors:
//      sendBreak(1)  — one 1.5s pulse (the standard)
//      sendBreak(5)  — five 500ms pulses with 100ms gaps, for stubborn USB-
//                      serial adapters (CH340, some FTDI clones) that silently
//                      drop short BREAKs.
//    Break sequences guard against concurrent disconnect — if the port goes
//    away mid-sequence the chain aborts cleanly.
//
//  - Resize: serial has no equivalent of NAWS / SSH window-change. The base
//    class's no-op performResize is correct.
//
//  - TransportConfig.host / .port don't apply; we use .path (/dev/ttyUSB0,
//    /dev/cu.usbserial-XXXX, COM3) and .baudRate.
//
// Use cases: console cables to switches / routers, USB-serial into lab gear,
// crash carts, ROMMON / bootloader recovery, serial-over-ethernet devices
// that expose a /dev/tty.

import { SerialPort } from 'serialport';
import * as fs from 'fs';
import * as os from 'os';
import log from 'electron-log';
import { BrowserWindow } from 'electron';
import { TransportManager, TransportConfig } from './transportManager';

// ─── Config ────────────────────────────────────────────────────

export type SerialLineEnding = 'cr' | 'crlf' | 'lf' | 'raw';

export interface SerialConnectionConfig extends TransportConfig {
    path: string;                     // /dev/ttyUSB0, /dev/cu.usbserial-XXX, COM3
    baudRate?: number;                // default 9600
    dataBits?: 5 | 6 | 7 | 8;         // default 8
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';  // default 'none'
    stopBits?: 1 | 1.5 | 2;           // default 1
    rtscts?: boolean;                 // default false
    xon?: boolean;                    // default false (toggles both xon/xoff)
    localEcho?: boolean;              // default false
    lineEnding?: SerialLineEnding;    // default 'cr' (network gear convention)
}

export interface SerialPortInfo {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    vendorId?: string;
    productId?: string;
    pnpId?: string;
    locationId?: string;
}

// ─── SerialManager ─────────────────────────────────────────────

export class SerialManager extends TransportManager {
    private port: SerialPort | null = null;
    private lastConfig: SerialConnectionConfig | null = null;
    private localEcho: boolean = false;
    private lineEnding: SerialLineEnding = 'cr';
    private breakActive: boolean = false;  // guards concurrent break sequences

    constructor(window: BrowserWindow, connectionId: string, sessionId: string) {
        super(window, connectionId, sessionId);
    }

    /** Public entry for parity with SSHManager / TelnetManager. */
    public connectToHost(config: SerialConnectionConfig): void {
        this.performConnect(config);
    }

    // ─── TransportManager hooks ────────────────────────────────

    protected performConnect(config: SerialConnectionConfig): void {
        try {
            this.lastConfig = { ...config };
            this.localEcho = !!config.localEcho;
            this.lineEnding = config.lineEnding || 'cr';
            this.status = 'connecting';
            this.breakActive = false;

            const baud     = config.baudRate || 9600;
            const dataBits = (config.dataBits || 8) as 5 | 6 | 7 | 8;
            const parity   = config.parity || 'none';
            const stopBits = (config.stopBits || 1) as 1 | 1.5 | 2;
            const frame    = `${dataBits}${parity[0].toUpperCase()}${stopBits}`;

            log.info(`SerialManager [${this.connectionId}]: opening ${config.path} @ ${baud} ${frame}`);
            this.sendMessage('connectionStatus', {
                status: 'connecting',
                message: `Opening ${config.path} @ ${baud}`,
            });
            this.sendMessage('output', {
                data:
                    `Opening ${config.path} @ ${baud} ${frame}` +
                    `${config.rtscts ? ' rtscts' : ''}${config.xon ? ' xonxoff' : ''}` +
                    `${config.localEcho ? ' [local-echo]' : ''}` +
                    ` [line=${this.lineEnding}]...\r\n`,
            });

            this.port = new SerialPort({
                path: config.path,
                baudRate: baud,
                dataBits,
                parity,
                stopBits,
                rtscts: !!config.rtscts,
                xon: !!config.xon,
                xoff: !!config.xon,   // CLI toggles both when --xon is set
                autoOpen: false,
            });

            // Attach listeners BEFORE open() so we don't miss early events.

            this.port.on('data', (chunk: Buffer) => {
                this.dataReceived += chunk.length;
                this.sendMessage('output', { data: chunk.toString('utf8') });
            });

            this.port.on('error', (err: Error) => {
                // serialport emits 'error' then 'close' for most failures, so
                // we don't flip status here — 'close' handles the state change.
                log.error(`SerialManager [${this.connectionId}]: ${err.message}`);
                this.sendMessage('output', { data: `\r\n[Serial error] ${err.message}\r\n` });
            });

            this.port.on('close', (err: any) => {
                log.info(`SerialManager [${this.connectionId}]: port closed${err ? ` (${err.message || err})` : ''}`);
                if (this.status !== 'error') {
                    this.status = 'disconnected';
                    this.sendMessage('connectionStatus', {
                        status: 'disconnected',
                        message: `Port closed${err ? ` (${err.message || err})` : ''}`,
                    });
                    this.sendMessage('output', {
                        data: `\r\nPort closed${err ? ` (${err.message || err})` : ''}.\r\n`,
                    });
                }
                this.port = null;
                this.breakActive = false;
            });

            this.port.open((err: Error | null) => {
                if (err) {
                    log.error(`SerialManager [${this.connectionId}]: open failed: ${err.message}`);
                    this.status = 'error';
                    const hint = this.classifyOpenError(err.message);
                    this.sendMessage('connectionStatus', {
                        status: 'error',
                        message: `Open failed: ${err.message}`,
                    });
                    this.sendMessage('output', {
                        data: `\r\nError opening ${config.path}: ${err.message}\r\n${hint ? hint + '\r\n' : ''}`,
                    });
                    this.port = null;
                    return;
                }
                this.status = 'connected';
                this.sendMessage('connectionStatus', { status: 'connected', message: 'Serial port open' });
                this.sendMessage('output', { data: '\r\nConnected.\r\n' });
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            log.error(`SerialManager [${this.connectionId}]: constructor failed: ${msg}`);
            this.status = 'error';
            this.sendMessage('connectionStatus', { status: 'error', message: `Connection failed: ${msg}` });
            this.sendMessage('output', { data: `\r\nError initiating connection: ${msg}\r\n` });
        }
    }

    protected performWrite(data: string): void {
        if (!this.port || this.status !== 'connected') {
            log.warn(`SerialManager [${this.connectionId}]: performWrite without open port`);
            return;
        }
        const normalized = this.normalizeLineEnding(data);

        if (this.localEcho) {
            // Mirror what we're sending — matches what appears on the wire.
            this.sendMessage('output', { data: normalized });
        }

        this.port.write(Buffer.from(normalized, 'utf8'), (err) => {
            if (err) {
                log.error(`SerialManager [${this.connectionId}]: write error: ${err.message}`);
            }
        });
    }

    protected performDisconnect(): void {
        this.breakActive = false;  // cancel any in-flight break sequence
        if (this.port) {
            try {
                if (this.port.isOpen) this.port.close();
            } catch (err) {
                log.warn(`SerialManager [${this.connectionId}]: error closing port: ${err}`);
            }
        }
    }

    // ─── Line Ending Normalization ──────────────────────────────
    // xterm sends bare \r on Enter. Network gear consoles default to CR.
    // Telnet uses CRLF (RFC 854). Some UARTs want LF only. 'raw' passes
    // through unchanged for device-level debugging.

    private normalizeLineEnding(data: string): string {
        switch (this.lineEnding) {
            case 'raw':  return data;
            case 'cr':   return data.replace(/\r\n|\n/g, '\r');
            case 'lf':   return data.replace(/\r\n|\r/g, '\n');
            case 'crlf': return data.replace(/\r\n|\r|\n/g, '\r\n');
            default:     return data;
        }
    }

    // ─── Break Signal ──────────────────────────────────────────
    // count=1 → one 1500ms pulse (standard ROMMON drop on real gear)
    // count>1 → burst of N × 500ms pulses with 100ms gaps (for USB-serial
    //           adapters that drop short BREAKs — CH340, some FTDI clones)

    public sendBreak(count: number = 1): void {
        if (!this.port || this.status !== 'connected') {
            this.sendMessage('output', { data: '\r\n[break] No open port.\r\n' });
            return;
        }
        if (this.breakActive) {
            this.sendMessage('output', { data: '\r\n[break] Break already in progress — ignoring.\r\n' });
            return;
        }

        const pulseMs = count <= 1 ? 1500 : 500;
        const gapMs = 100;
        let i = 0;

        this.breakActive = true;
        this.sendMessage('output', {
            data: count <= 1
                ? `\r\n[break] Sending break (${pulseMs}ms)...\r\n`
                : `\r\n[break] Sending break burst (${count}× ${pulseMs}ms)...\r\n`,
        });

        const tick = () => {
            // Abort if the port was torn down or break was cancelled
            if (!this.breakActive || !this.port || this.status !== 'connected') {
                this.breakActive = false;
                return;
            }
            if (i >= count) {
                this.breakActive = false;
                this.sendMessage('output', { data: '[break] Complete.\r\n' });
                return;
            }
            i++;
            this.port.set({ brk: true }, (err) => {
                if (err || !this.breakActive || !this.port) {
                    this.breakActive = false;
                    if (err) this.sendMessage('output', { data: `[break] Error: ${err.message}\r\n` });
                    return;
                }
                setTimeout(() => {
                    if (!this.breakActive || !this.port) {
                        this.breakActive = false;
                        return;
                    }
                    this.port.set({ brk: false }, () => {
                        setTimeout(tick, gapMs);
                    });
                }, pulseMs);
            });
        };
        tick();
    }

    // ─── Custom Message Hook (break via IPC) ───────────────────
    // Reserved type: 'serial:break' with payload { burst?: boolean }.
    // Kept alongside the dedicated IPC handler in main.ts so either path
    // reaches the same code.

    protected handleCustomMessage(message: any): boolean {
        if (message.type === 'serial:break') {
            this.sendBreak(message.payload?.burst ? 5 : 1);
            return true;
        }
        return false;
    }

    // ─── Error Classification ──────────────────────────────────
    // Translate common OS errors into actionable hints. Echoed into the
    // terminal alongside the raw error so the user gets both the truth and
    // a next step.

    private classifyOpenError(msg: string): string | null {
        const lower = msg.toLowerCase();
        if (lower.includes('permission denied') || lower.includes('eacces')) {
            if (process.platform === 'linux') {
                return '  → Linux: add your user to the dialout group:\r\n' +
                       '    sudo usermod -a -G dialout $USER   (then log out and back in)\r\n' +
                       '    On Arch/Fedora the group is "uucp" instead.';
            }
            if (process.platform === 'darwin') {
                return '  → macOS: another app (screen, minicom, Arduino IDE) may hold the port.';
            }
            return '  → Check port permissions / that no other app is using the port.';
        }
        if (lower.includes('no such file') || lower.includes('enoent') || lower.includes('cannot find')) {
            return '  → Port not found. It may have been unplugged — refresh the port list.';
        }
        if (lower.includes('busy') || lower.includes('locked') || lower.includes('resource busy')) {
            return '  → Port in use by another process (screen, minicom, PuTTY, etc).';
        }
        if (lower.includes('access is denied')) {
            return '  → Windows: port may be claimed by another app. Check Device Manager.';
        }
        return null;
    }

    // ─── Access Precheck (Linux dialout / uucp) ────────────────
    // Linux serial devices live in /dev/tty* with group ownership dialout
    // (Debian/Ubuntu) or uucp (Arch/Fedora). Users who aren't in the group
    // hit EACCES on port.open(). Rather than wait for the failure and echo
    // the hint inside the terminal, we surface the situation at dialog-open
    // time so the user sees it before attempting to connect.
    //
    // Three possible states:
    //   hasAccess=true                    — process has the group, all good
    //   hasAccess=false, needsRelogin=true — user was added to the group
    //     (via usermod) but their current session hasn't picked it up yet
    //   hasAccess=false, needsRelogin=false — user isn't in the group at all,
    //     run usermod first
    //
    // Fail-open: if /etc/group can't be read or the APIs aren't available,
    // we return hasAccess=true rather than showing a false warning.

    public static checkLinuxSerialAccess(): {
        hasAccess: boolean;
        missingGroup: string | null;
        needsRelogin: boolean;
    } {
        if (process.platform !== 'linux') {
            return { hasAccess: true, missingGroup: null, needsRelogin: false };
        }
        if (typeof process.getgroups !== 'function') {
            return { hasAccess: true, missingGroup: null, needsRelogin: false };
        }

        try {
            const processGids = new Set<number>(process.getgroups());
            const egid = typeof process.getegid === 'function' ? process.getegid() : undefined;
            if (egid !== undefined) processGids.add(egid);

            const username = os.userInfo().username;
            const groupFile = fs.readFileSync('/etc/group', 'utf8');
            const candidates = ['dialout', 'uucp'];

            // First pass: scan the candidate groups and resolve state
            for (const line of groupFile.split('\n')) {
                const parts = line.split(':');
                if (parts.length < 4) continue;
                const [name, , gidStr, membersStr] = parts;
                if (!candidates.includes(name)) continue;

                const gid = parseInt(gidStr, 10);
                const members = (membersStr || '').split(',').filter(Boolean);

                // The process is a current member — authoritative.
                if (processGids.has(gid)) {
                    return { hasAccess: true, missingGroup: null, needsRelogin: false };
                }

                // User is listed in /etc/group but the running process
                // doesn't have it yet — usermod ran, no re-login yet.
                if (members.includes(username)) {
                    return { hasAccess: false, missingGroup: name, needsRelogin: true };
                }
            }

            // Second pass: the user isn't in any candidate group at all.
            // Point at whichever group exists on this distro.
            const existingGroups = new Set<string>();
            for (const line of groupFile.split('\n')) {
                const name = line.split(':')[0];
                if (name) existingGroups.add(name);
            }
            for (const candidate of candidates) {
                if (existingGroups.has(candidate)) {
                    return { hasAccess: false, missingGroup: candidate, needsRelogin: false };
                }
            }
            return { hasAccess: false, missingGroup: 'dialout', needsRelogin: false };
        } catch (err) {
            log.warn(`SerialManager: group check failed: ${err instanceof Error ? err.message : err}`);
            return { hasAccess: true, missingGroup: null, needsRelogin: false };  // fail-open
        }
    }

    // ─── Port Enumeration (static) ─────────────────────────────
    // Platform-aware noise filtering. What counts as "noise" varies:
    //
    //   macOS  — Bluetooth audio devices, debug console, paired headphones.
    //            Also maps /dev/tty.* → /dev/cu.* (cu is the correct "calling
    //            unit" for outgoing/interactive use; tty blocks on DCD).
    //
    //   Linux  — The kernel enumerates /dev/ttyS0..ttyS31 as serial devices
    //            whether real UART hardware is behind them or not. On modern
    //            laptops these are all stubs; on servers with actual 16550
    //            UARTs, udev populates manufacturer / vendorId. We hide
    //            ttyS* entries that have no udev metadata — real hardware
    //            survives, phantom stubs get filtered out.
    //
    //   Windows — COM ports only exist when there's a driver behind them,
    //             so no filtering is needed.
    //
    // showAll=true bypasses all of this, which is the escape hatch for
    // edge cases (e.g. a real ttyS without populated udev metadata).

    public static async listPorts(showAll: boolean = false): Promise<SerialPortInfo[]> {
        let raw: any[];
        try {
            raw = await SerialPort.list();
        } catch (err) {
            log.error(`SerialManager: port enumeration failed: ${err instanceof Error ? err.message : err}`);
            return [];
        }

        // macOS path rewrite runs regardless of showAll — it's a correction,
        // not a filter.
        if (process.platform === 'darwin') {
            raw = raw.map(p => ({ ...p, path: p.path.replace('/dev/tty.', '/dev/cu.') }));
        }

        if (showAll) return raw;

        if (process.platform === 'darwin') {
            const macNoise = [
                /debug-console/i,
                /Bluetooth-Incoming/i,
                /Jabra/i,
                /AirPods/i,
                /Beats/i,
            ];
            return raw.filter(p => !macNoise.some(rx => rx.test(p.path)));
        }

        if (process.platform === 'linux') {
            return raw.filter(p => {
                const isLegacyTtyS = /^\/dev\/ttyS\d+$/.test(p.path);
                if (!isLegacyTtyS) return true;
                // Keep ttyS* only if udev has identifying info — a real
                // hardware port will have at least one of these populated.
                return !!(p.manufacturer || p.vendorId || p.pnpId);
            });
        }

        // Windows / other — return as-is.
        return raw;
    }

    // ─── Diagnostics ───────────────────────────────────────────

    public getDebugInfo(): any {
        return {
            ...super.getDebugInfo(),
            protocol: 'serial',
            path:      this.lastConfig?.path,
            baudRate:  this.lastConfig?.baudRate,
            dataBits:  this.lastConfig?.dataBits,
            parity:    this.lastConfig?.parity,
            stopBits:  this.lastConfig?.stopBits,
            rtscts:    this.lastConfig?.rtscts,
            xon:       this.lastConfig?.xon,
            localEcho: this.localEcho,
            lineEnding: this.lineEnding,
            portOpen:  this.port?.isOpen ?? false,
            breakActive: this.breakActive,
        };
    }

    public sendDiagnostics(): void {
        const info = this.getDebugInfo();
        this.sendMessage('diagnostic', info);
        const parityLetter = (info.parity || 'none')[0].toUpperCase();
        const flow =
            (info.rtscts ? 'RTS/CTS ' : '') +
            (info.xon ? 'XON/XOFF' : '') ||
            'none';
        this.sendMessage('output', {
            data:
                '\r\n----- SERIAL DIAGNOSTICS -----\r\n' +
                `Connection ID: ${this.connectionId}\r\n` +
                `Session ID: ${this.sessionId}\r\n` +
                `Status: ${this.status}\r\n` +
                `Port: ${info.path || '(unknown)'}\r\n` +
                `Baud: ${info.baudRate}\r\n` +
                `Frame: ${info.dataBits}${parityLetter}${info.stopBits}\r\n` +
                `Flow control: ${flow}\r\n` +
                `Local echo: ${this.localEcho}\r\n` +
                `Line ending: ${this.lineEnding}\r\n` +
                `Port open: ${info.portOpen}\r\n` +
                `Bytes sent: ${this.dataSent}\r\n` +
                `Bytes received: ${this.dataReceived}\r\n` +
                '------------------------------\r\n',
        });
    }
}