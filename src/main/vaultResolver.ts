// vaultResolver.ts — Credential resolution for SSH connections
// Lives in: src/main/vaultResolver.ts
//
// Matches stored credentials to target devices using:
//   1. Explicit credential name (highest priority)
//   2. Host glob patterns (scored by specificity)
//   3. Tag matching (additive scoring)
//   4. Default credential (lowest priority fallback)
//
// The resolver never returns decrypted secrets to the renderer.
// It returns metadata (credential name, username, auth method) for
// display, and injects actual secrets into the SSH config on the
// main process side before passing to sshManager.
//
// Ports the scoring logic from Python resolver.py.

import log from 'electron-log';
import { VaultStore, StoredCredential } from './vaultStore';

// ─── Types ───────────────────────────────────────────────────

/** Match result returned to the renderer (no secrets) */
export interface CredentialMatch {
    matched: boolean;
    credentialName: string | null;
    username: string | null;
    authMethod: string | null;  // 'password' | 'key' | 'agent'
    hasJumpHost: boolean;
    jumpHost: string | null;
    jumpRequiresTouch: boolean;
}

/** Resolved credential with secrets — stays in main process */
export interface ResolvedCredential {
    username: string;
    password: string | null;
    sshKey: string | null;
    sshKeyPassphrase: string | null;
    jumpHost: string | null;
    jumpUsername: string | null;
    jumpAuthMethod: string;
    jumpRequiresTouch: boolean;
}

// ─── Glob Matching ───────────────────────────────────────────

/**
 * Minimal glob matcher supporting * and ? wildcards.
 *
 * Equivalent to Python's fnmatch.fnmatch(). Supports:
 *   *  — matches any sequence of characters (including empty)
 *   ?  — matches exactly one character
 *
 * Matching is case-insensitive (hostnames are case-insensitive).
 *
 * Examples:
 *   globMatch('10.0.1.5', '10.0.*')           → true
 *   globMatch('sw-lab-01.example.com', '*.example.com') → true
 *   globMatch('rtr-01', 'rtr-??')              → true
 */
function globMatch(text: string, pattern: string): boolean {
    const t = text.toLowerCase();
    const p = pattern.toLowerCase();

    let ti = 0;
    let pi = 0;
    let starTi = -1;
    let starPi = -1;

    while (ti < t.length) {
        if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
            // Exact match or single-char wildcard
            ti++;
            pi++;
        } else if (pi < p.length && p[pi] === '*') {
            // Star: save position and advance pattern
            starPi = pi;
            starTi = ti;
            pi++;
        } else if (starPi !== -1) {
            // Backtrack: try consuming one more char with the star
            pi = starPi + 1;
            starTi++;
            ti = starTi;
        } else {
            return false;
        }
    }

    // Consume trailing stars in pattern
    while (pi < p.length && p[pi] === '*') {
        pi++;
    }

    return pi === p.length;
}

/**
 * Calculate pattern specificity — more specific patterns score higher.
 *
 * Specificity = total chars minus wildcard chars.
 * '192.168.1.101' (exact IP) → 13
 * '192.168.1.*'              → 10
 * '*.example.com'            → 11
 * '*'                        → 0
 */
function patternSpecificity(pattern: string): number {
    let wildcards = 0;
    for (const ch of pattern) {
        if (ch === '*' || ch === '?') wildcards++;
    }
    return pattern.length - wildcards;
}

// ─── Resolver ────────────────────────────────────────────────

export class VaultResolver {
    constructor(private store: VaultStore) {}

    /**
     * Find the best credential match for a host.
     *
     * Returns metadata only (no secrets) — safe for IPC to renderer.
     */
    matchForHost(
        hostname: string,
        port: number = 22,
        tags: string[] = [],
    ): CredentialMatch {
        const noMatch: CredentialMatch = {
            matched: false,
            credentialName: null,
            username: null,
            authMethod: null,
            hasJumpHost: false,
            jumpHost: null,
            jumpRequiresTouch: false,
        };

        if (!this.store.isUnlocked) return noMatch;

        const cred = this.findBestMatch(hostname, tags);
        if (!cred) return noMatch;

        // Determine auth method
        let authMethod: string = 'password';
        if (cred.sshKey) authMethod = 'key';
        else if (!cred.password) authMethod = 'agent';

        return {
            matched: true,
            credentialName: cred.name,
            username: cred.username,
            authMethod,
            hasJumpHost: Boolean(cred.jumpHost),
            jumpHost: cred.jumpHost,
            jumpRequiresTouch: cred.jumpRequiresTouch,
        };
    }

    /**
     * Resolve full credentials for a host — secrets included.
     *
     * Stays in main process. Never sent over IPC.
     * Returns null if no match found.
     */
    resolveForHost(
        hostname: string,
        port: number = 22,
        tags: string[] = [],
    ): ResolvedCredential | null {
        if (!this.store.isUnlocked) return null;

        const cred = this.findBestMatch(hostname, tags);
        if (!cred) return null;

        this.store.updateLastUsed(cred.name);

        return {
            username: cred.username,
            password: cred.password,
            sshKey: cred.sshKey,
            sshKeyPassphrase: cred.sshKeyPassphrase,
            jumpHost: cred.jumpHost,
            jumpUsername: cred.jumpUsername,
            jumpAuthMethod: cred.jumpAuthMethod,
            jumpRequiresTouch: cred.jumpRequiresTouch,
        };
    }

    /**
     * Resolve a specific named credential — secrets included.
     *
     * Used when the connect dialog has a credential dropdown selection.
     */
    resolveByName(credentialName: string): ResolvedCredential | null {
        if (!this.store.isUnlocked) return null;

        const cred = this.store.getCredential(credentialName);
        if (!cred) return null;

        this.store.updateLastUsed(cred.name);

        return {
            username: cred.username,
            password: cred.password,
            sshKey: cred.sshKey,
            sshKeyPassphrase: cred.sshKeyPassphrase,
            jumpHost: cred.jumpHost,
            jumpUsername: cred.jumpUsername,
            jumpAuthMethod: cred.jumpAuthMethod,
            jumpRequiresTouch: cred.jumpRequiresTouch,
        };
    }

    // ─── Scoring Engine ──────────────────────────────────────

    /**
     * Find the best matching credential for a hostname.
     *
     * Scoring (from Python resolver.py):
     *   - Host pattern match: 10 + specificity
     *   - Tag match: 5 × matching_tag_count
     *   - Default fallback: 1 (only if nothing else matched)
     *
     * Highest score wins. Returns null if no match.
     */
    private findBestMatch(
        hostname: string,
        tags: string[] = [],
    ): StoredCredential | null {
        let allCreds: StoredCredential[];
        try {
            allCreds = this.store.listCredentialsFull();
        } catch (err) {
            log.error('Failed to list credentials for matching:', err);
            return null;
        }

        let bestScore = 0;
        let bestCred: StoredCredential | null = null;

        for (const cred of allCreds) {
            const score = this.scoreCredential(cred, hostname, tags);
            if (score > bestScore) {
                bestScore = score;
                bestCred = cred;
            }
        }

        if (bestCred) {
            log.info(
                `Resolved credential '${bestCred.name}' for ${hostname} (score: ${bestScore})`
            );
        }

        return bestCred;
    }

    /**
     * Score how well a credential matches a device.
     */
    private scoreCredential(
        cred: StoredCredential,
        hostname: string,
        tags: string[],
    ): number {
        let score = 0;

        // Check host patterns
        for (const pattern of cred.matchHosts) {
            if (globMatch(hostname, pattern)) {
                score += 10 + patternSpecificity(pattern);
                break; // Best single pattern match
            }
        }

        // Check tags
        if (tags.length > 0 && cred.matchTags.length > 0) {
            const credTagSet = new Set(cred.matchTags.map(t => t.toLowerCase()));
            let matchCount = 0;
            for (const tag of tags) {
                if (credTagSet.has(tag.toLowerCase())) matchCount++;
            }
            score += matchCount * 5;
        }

        // Default credential gets lowest priority
        if (cred.isDefault && score === 0) {
            score = 1;
        }

        return score;
    }
}
