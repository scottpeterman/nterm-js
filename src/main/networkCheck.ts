// networkCheck.ts — macOS Local Network permission detection
// Detects when Electron is blocked from reaching LAN hosts by macOS Sequoia+
// privacy controls, and provides actionable error messages instead of
// the misleading EHOSTUNREACH that the kernel surfaces.

import * as net from 'net';
import * as os from 'os';
import log from 'electron-log';

// ─── RFC1918 / Link-Local Detection ─────────────────────────

const PRIVATE_RANGES = [
    { prefix: '10.', mask: null },           // 10.0.0.0/8
    { prefix: '172.', mask: [16, 31] },      // 172.16.0.0/12
    { prefix: '192.168.', mask: null },       // 192.168.0.0/16
    { prefix: '169.254.', mask: null },       // Link-local
    { prefix: 'fd', mask: null },             // IPv6 ULA (fd00::/8)
    { prefix: 'fe80:', mask: null },          // IPv6 link-local
];

export function isPrivateAddress(host: string): boolean {
    const lower = host.toLowerCase();

    // Simple prefix check for most ranges
    if (lower.startsWith('10.') || lower.startsWith('192.168.') ||
        lower.startsWith('169.254.') || lower.startsWith('fd') ||
        lower.startsWith('fe80:')) {
        return true;
    }

    // 172.16.0.0/12 — second octet 16–31
    if (lower.startsWith('172.')) {
        const secondOctet = parseInt(lower.split('.')[1], 10);
        if (secondOctet >= 16 && secondOctet <= 31) return true;
    }

    return false;
}

// ─── Error Classification ───────────────────────────────────

export interface NetworkPermissionResult {
    isPermissionIssue: boolean;
    originalError: string;
    friendlyMessage: string;
    remediation: string;
}

/**
 * Determines if an SSH connection error to a private IP is likely caused
 * by macOS Local Network permission denial.
 *
 * macOS Sequoia+ blocks unsigned/unrecognized apps from reaching LAN hosts.
 * The kernel reports this as EHOSTUNREACH or ENETUNREACH — completely
 * misleading when the host is actually reachable from Terminal.app.
 */
export function classifyConnectionError(host: string, errorMessage: string): NetworkPermissionResult {
    const isMac = process.platform === 'darwin';
    const isPrivate = isPrivateAddress(host);
    const isUnreachable = /EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(errorMessage);

    if (isMac && isPrivate && isUnreachable) {
        return {
            isPermissionIssue: true,
            originalError: errorMessage,
            friendlyMessage:
                `Connection to ${host} was blocked — this is likely a macOS Local Network permission issue, not a network problem.`,
            remediation:
                'Go to System Settings → Privacy & Security → Local Network and enable access for nterm-js (or Electron during development). ' +
                'If the toggle is missing, try: tccutil reset LocalNetwork com.github.Electron',
        };
    }

    return {
        isPermissionIssue: false,
        originalError: errorMessage,
        friendlyMessage: errorMessage,
        remediation: '',
    };
}

// ─── Proactive LAN Probe ────────────────────────────────────

/**
 * Proactive check: attempts a TCP connection to the host's default gateway
 * or a known LAN address. Used at startup or before first LAN connection
 * to detect the permission block early.
 *
 * Returns true if LAN access appears to work, false if blocked.
 * Returns null if the check is not applicable (not macOS, no LAN interfaces).
 */
export async function probeLanAccess(timeoutMs: number = 3000): Promise<{
    lanAccessible: boolean | null;
    probeHost: string | null;
    error: string | null;
}> {
    if (process.platform !== 'darwin') {
        return { lanAccessible: null, probeHost: null, error: null };
    }

    // Find this machine's own LAN address to derive a probe target.
    // We probe the .1 gateway on the first private interface found.
    const probeHost = findGatewayCandidate();
    if (!probeHost) {
        return { lanAccessible: null, probeHost: null, error: 'No private network interface found' };
    }

    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;

        const finish = (accessible: boolean, error: string | null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ lanAccessible: accessible, probeHost, error });
        };

        socket.setTimeout(timeoutMs);

        socket.on('connect', () => finish(true, null));
        socket.on('error', (err) => {
            if (/EHOSTUNREACH|ENETUNREACH/.test(err.message)) {
                finish(false, err.message);
            } else {
                // ECONNREFUSED = host reachable, port closed. That's fine — LAN works.
                finish(true, null);
            }
        });
        socket.on('timeout', () => finish(false, 'Probe timed out'));

        // Probe port 1 — we don't care if it's open, just if the TCP SYN leaves the machine.
        // ECONNREFUSED means the packet reached the host. EHOSTUNREACH means macOS blocked it.
        socket.connect(1, probeHost);
    });
}

/**
 * Finds a probable default gateway address (.1) from the machine's
 * private network interfaces.
 */
function findGatewayCandidate(): string | null {
    const interfaces = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal && isPrivateAddress(addr.address)) {
                // Derive .1 gateway from the interface address
                const octets = addr.address.split('.');
                octets[3] = '1';
                return octets.join('.');
            }
        }
    }

    return null;
}