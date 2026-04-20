#!/usr/bin/env node
/**
 * serial-cli.js — Minimal serial port CLI harness
 * 
 * Usage:
 *   node serial-cli.js list                          # enumerate ports
 *   node serial-cli.js connect /dev/ttyUSB0          # 9600 8N1 default
 *   node serial-cli.js connect /dev/ttyUSB0 -b 115200
 *   node serial-cli.js connect COM3 -b 9600 -d 8 -p none -s 1
 * 
 * In-session:
 *   ~.    disconnect (must follow a newline, like SSH)
 *   ~?    show escape help
 *   ~b    send break signal
 * 
 * Purpose: validate node-serialport behavior before integrating
 * into nterm-js Electron main process.
 */

const { SerialPort } = require('serialport');
const { ReadlineParser, ByteLengthParser } = require('serialport');

// ── CLI argument parsing (no deps) ──────────────────────────────
function parseArgs(argv) {
    const args = argv.slice(2);
    const cmd = args[0] || 'help';

    if (cmd === 'list') return { command: 'list', showAll: args.includes('--all') };
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { command: 'help' };

    if (cmd === 'connect') {
        const path = args[1];
        if (!path) {
            console.error('Error: serial port path required');
            console.error('  node serial-cli.js connect /dev/ttyUSB0');
            process.exit(1);
        }

        const opts = {
            command: 'connect',
            path,
            baudRate: 9600,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            flowControl: false,  // rtscts
            xon: false,          // software flow control
            raw: false,          // raw byte mode (no line parser)
        };

        for (let i = 2; i < args.length; i++) {
            switch (args[i]) {
                case '-b': case '--baud':
                    opts.baudRate = parseInt(args[++i], 10); break;
                case '-d': case '--databits':
                    opts.dataBits = parseInt(args[++i], 10); break;
                case '-p': case '--parity':
                    opts.parity = args[++i]; break;  // none, even, odd, mark, space
                case '-s': case '--stopbits':
                    opts.stopBits = parseInt(args[++i], 10); break;
                case '--rtscts':
                    opts.flowControl = true; break;
                case '--xon':
                    opts.xon = true; break;
                case '--raw':
                    opts.raw = true; break;
                default:
                    console.error(`Unknown option: ${args[i]}`);
                    process.exit(1);
            }
        }
        return opts;
    }

    // Treat bare path as connect shorthand: node serial-cli.js /dev/ttyUSB0
    if (cmd.startsWith('/') || cmd.startsWith('COM') || cmd.startsWith('\\\\.\\')) {
        return { ...parseArgs(['', '', 'connect', cmd, ...args.slice(1)]) };
    }

    return { command: 'help' };
}

// ── List ports ──────────────────────────────────────────────────
async function listPorts(showAll = false) {
    let ports;
    try {
        ports = await SerialPort.list();
    } catch (err) {
        console.error(`  Error enumerating ports: ${err.message}`);
        console.error('  (This can happen in containers or without udev/COM support)');
        return;
    }
    if (ports.length === 0) {
        console.log('No serial ports found.');
        return;
    }

    // On macOS, map tty.* to cu.* (cu = calling unit, correct for outgoing)
    const isMac = process.platform === 'darwin';
    if (isMac) {
        ports = ports.map(p => ({
            ...p,
            path: p.path.replace('/dev/tty.', '/dev/cu.'),
        }));
    }

    // Filter out non-useful ports (debug console, bluetooth)
    const noise = ['debug-console', 'Bluetooth-Incoming', 'Jabra', 'AirPods', 'Beats'];
    const usable = showAll ? ports : ports.filter(p => !noise.some(n => p.path.includes(n)));
    const filtered = ports.length - usable.length;

    console.log(`\n  Found ${usable.length} serial port(s)${filtered ? ` (${filtered} hidden, use --all to show)` : ''}:\n`);

    const col = (str, width) => (str || '').padEnd(width);

    console.log(`  ${col('PATH', 30)} ${col('VID:PID', 12)} ${col('SERIAL', 12)} MANUFACTURER`);
    console.log('  ' + '─'.repeat(70));

    for (const p of usable) {
        const vid = p.vendorId ? `${p.vendorId}:${p.productId || '????'}` : '—';
        console.log(`  ${col(p.path, 30)} ${col(vid, 12)} ${col(p.serialNumber || '—', 12)} ${p.manufacturer || '—'}`);
    }
    console.log();
}

// ── Connect ─────────────────────────────────────────────────────
async function connect(opts) {
    const config = {
        path: opts.path,
        baudRate: opts.baudRate,
        dataBits: opts.dataBits,
        parity: opts.parity,
        stopBits: opts.stopBits,
        rtscts: opts.flowControl,
        xon: opts.xon,
        xoff: opts.xon,
        autoOpen: false,
    };

    console.log(`\n  Connecting to ${opts.path} @ ${opts.baudRate} ${opts.dataBits}${opts.parity[0].toUpperCase()}${opts.stopBits}`);
    if (opts.flowControl) console.log('  Flow control: RTS/CTS');
    if (opts.xon) console.log('  Flow control: XON/XOFF');
    console.log('  Escape: ~. to disconnect, ~? for help, ~b/~B to send break\n');

    const port = new SerialPort(config);

    // ── Open ──
    return new Promise((resolve, reject) => {
        port.open((err) => {
            if (err) {
                console.error(`  Error opening ${opts.path}: ${err.message}`);
                
                // Common troubleshooting
                if (err.message.includes('Permission denied')) {
                    console.error('  → Try: sudo usermod -a -G dialout $USER  (then re-login)');
                } else if (err.message.includes('No such file')) {
                    console.error('  → Port not found. Run "list" to see available ports.');
                } else if (err.message.includes('busy') || err.message.includes('locked')) {
                    console.error('  → Port in use by another process.');
                }
                process.exit(1);
            }

            console.log(`  Connected. Session active.\n`);

            // ── Device → stdout ──
            port.on('data', (data) => {
                process.stdout.write(data);
            });

            // ── Port events ──
            port.on('error', (err) => {
                console.error(`\n  [serial error] ${err.message}`);
            });

            port.on('close', () => {
                console.log('\n  [serial] Port closed.');
                cleanup();
                resolve();
            });

            // ── stdin → device (with escape sequence detection) ──
            let lastWasNewline = true;  // start true so first char can be ~
            let escapeState = 0;        // 0=normal, 1=saw ~

            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.resume();

            process.stdin.on('data', (chunk) => {
                for (let i = 0; i < chunk.length; i++) {
                    const byte = chunk[i];
                    const char = String.fromCharCode(byte);

                    if (escapeState === 1) {
                        escapeState = 0;
                        switch (char) {
                            case '.':
                                // disconnect
                                console.log('\n  [~.] Disconnecting...');
                                port.close();
                                return;
                            case '?':
                                // help
                                console.log('\n  Escape sequences:');
                                console.log('    ~.  Disconnect');
                                console.log('    ~b  Send break (1.5s — ROMMON)');
                                console.log('    ~B  Break burst (5x — stubborn adapters)');
                                console.log('    ~?  This help');
                                console.log('    ~~  Send literal ~\n');
                                continue;
                            case 'b':
                                // break signal (useful for ROMMON, password recovery)
                                // Longer duration + burst for USB-serial adapters
                                console.log('\n  [~b] Sending break signal (1.5s)...');
                                port.set({ brk: true }, () => {
                                    setTimeout(() => {
                                        port.set({ brk: false }, () => {
                                            console.log('  [~b] Break released.');
                                        });
                                    }, 1500);
                                });
                                continue;
                            case 'B':
                                // Aggressive break burst — 5x 500ms for stubborn adapters
                                console.log('\n  [~B] Sending break burst (5x)...');
                                let count = 0;
                                const burstBreak = () => {
                                    if (count >= 5) {
                                        console.log('  [~B] Break burst complete.');
                                        return;
                                    }
                                    count++;
                                    port.set({ brk: true }, () => {
                                        setTimeout(() => {
                                            port.set({ brk: false }, () => {
                                                setTimeout(burstBreak, 100);
                                            });
                                        }, 500);
                                    });
                                };
                                burstBreak();
                                continue;
                            case '~':
                                // literal ~
                                port.write(Buffer.from([0x7e]));
                                lastWasNewline = false;
                                continue;
                            default:
                                // not a valid escape, send both chars
                                port.write(Buffer.from([0x7e, byte]));
                                lastWasNewline = false;
                                continue;
                        }
                    }

                    // Check for escape start
                    if (char === '~' && lastWasNewline) {
                        escapeState = 1;
                        continue;
                    }

                    // Track newlines (CR or LF)
                    lastWasNewline = (byte === 0x0d || byte === 0x0a);

                    // Send byte to device
                    port.write(Buffer.from([byte]));
                }
            });

            // ── Cleanup on signals ──
            function cleanup() {
                if (process.stdin.isTTY) {
                    try { process.stdin.setRawMode(false); } catch (e) {}
                }
                process.stdin.pause();
            }

            process.on('SIGINT', () => {
                console.log('\n  [SIGINT] Closing port...');
                port.close();
            });

            process.on('SIGTERM', () => {
                port.close();
            });
        });
    });
}

// ── Help ────────────────────────────────────────────────────────
function showHelp() {
    console.log(`
  serial-cli — Node.js serial port test harness

  Usage:
    node serial-cli.js list                              List available ports
    node serial-cli.js list --all                          Include system/BT ports
    node serial-cli.js connect <path> [options]          Open serial session
    node serial-cli.js <path> [options]                  Shorthand for connect

  Options:
    -b, --baud <rate>      Baud rate (default: 9600)
    -d, --databits <5-8>   Data bits (default: 8)
    -p, --parity <type>    none, even, odd, mark, space (default: none)
    -s, --stopbits <1|2>   Stop bits (default: 1)
    --rtscts               Enable RTS/CTS hardware flow control
    --xon                  Enable XON/XOFF software flow control

  In-session escapes (after newline):
    ~.                     Disconnect
    ~b                     Send break signal 1.5s (ROMMON, password recovery)
    ~B                     Break burst 5x (for stubborn USB-serial adapters)
    ~?                     Show escape help
    ~~                     Send literal ~

  Examples:
    node serial-cli.js list
    node serial-cli.js /dev/ttyUSB0
    node serial-cli.js connect COM3 -b 115200
    node serial-cli.js connect /dev/ttyS0 -b 9600 --rtscts
`);
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv);

    switch (opts.command) {
        case 'list':
            await listPorts(opts.showAll);
            break;
        case 'connect':
            await connect(opts);
            break;
        default:
            showHelp();
    }
}

main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});