// test-vault-crypto.ts — Validate encryption primitives
// Run with: npx ts-node src/main/test-vault-crypto.ts
// Or compile first and run with node
//
// Tests the vaultCrypto module in isolation (no Electron needed).

import {
    deriveKey,
    generateSalt,
    encrypt,
    decrypt,
    generateVerifyToken,
    verifyKey,
    PBKDF2_ITERATIONS,
    SALT_LENGTH,
    VERIFY_TOKEN_LENGTH,
} from './vaultCrypto';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message}`);
        failed++;
    }
}

// ─── Test: Salt Generation ───────────────────────────────────

console.log('\n[Salt Generation]');

const salt1 = generateSalt();
const salt2 = generateSalt();

assert(salt1.length === SALT_LENGTH, `Salt is ${SALT_LENGTH} bytes`);
assert(!salt1.equals(salt2), 'Two salts are different');

// ─── Test: Key Derivation ────────────────────────────────────

console.log('\n[Key Derivation]');

const password = 'test-master-password-2024';
const salt = generateSalt();

const startTime = Date.now();
const key = deriveKey(password, salt);
const elapsed = Date.now() - startTime;

assert(key.length === 32, 'Derived key is 32 bytes (256 bits)');
assert(elapsed > 50, `PBKDF2 took ${elapsed}ms (should be slow)`);
console.log(`  ℹ PBKDF2 ${PBKDF2_ITERATIONS.toLocaleString()} iterations: ${elapsed}ms`);

// Same password + salt = same key
const key2 = deriveKey(password, salt);
assert(key.equals(key2), 'Same password + salt = same key');

// Different password = different key
const key3 = deriveKey('wrong-password', salt);
assert(!key.equals(key3), 'Different password = different key');

// Different salt = different key
const key4 = deriveKey(password, generateSalt());
assert(!key.equals(key4), 'Different salt = different key');

// ─── Test: Encrypt / Decrypt Roundtrip ───────────────────────

console.log('\n[Encrypt/Decrypt Roundtrip]');

const plaintext = 'ssh-rsa AAAAB3NzaC1yc2EAAA... test@nterm';
const ciphertext = encrypt(plaintext, key);

assert(ciphertext.length > plaintext.length, 'Ciphertext is longer than plaintext');
assert(!ciphertext.toString().includes(plaintext), 'Plaintext not visible in ciphertext');

const decrypted = decrypt(ciphertext, key);
assert(decrypted === plaintext, 'Decrypt recovers original plaintext');

// Different key fails
try {
    decrypt(ciphertext, key3);
    assert(false, 'Decrypt with wrong key should throw');
} catch (err: any) {
    assert(err.message.includes('Decryption failed'), 'Wrong key throws expected error');
}

// Tampered ciphertext fails (GCM authentication)
const tampered = Buffer.from(ciphertext);
tampered[tampered.length - 1] ^= 0xff; // flip last byte
try {
    decrypt(tampered, key);
    assert(false, 'Tampered ciphertext should throw');
} catch (err: any) {
    assert(err.message.includes('Decryption failed'), 'Tampered data throws expected error');
}

// ─── Test: Each Encryption Is Unique (Random IV) ─────────────

console.log('\n[Random IV — Unique Ciphertexts]');

const ct1 = encrypt('same plaintext', key);
const ct2 = encrypt('same plaintext', key);

assert(!ct1.equals(ct2), 'Same plaintext encrypts to different ciphertext (random IV)');

const d1 = decrypt(ct1, key);
const d2 = decrypt(ct2, key);
assert(d1 === d2, 'Both decrypt to same plaintext');

// ─── Test: Verification Token ────────────────────────────────

console.log('\n[Verification Token]');

const { token, encrypted: encToken } = generateVerifyToken(key);

assert(token.length === VERIFY_TOKEN_LENGTH, `Token is ${VERIFY_TOKEN_LENGTH} bytes`);
assert(encToken.length > token.length, 'Encrypted token is larger');

// Correct key verifies
assert(verifyKey(key, encToken, token), 'Correct key verifies token');

// Wrong key fails
assert(!verifyKey(key3, encToken, token), 'Wrong key fails verification');

// ─── Test: Edge Cases ────────────────────────────────────────

console.log('\n[Edge Cases]');

// Empty string
const ctEmpty = encrypt('', key);
assert(decrypt(ctEmpty, key) === '', 'Empty string roundtrip');

// Unicode
const unicode = '日本語のパスワード 🔐';
const ctUnicode = encrypt(unicode, key);
assert(decrypt(ctUnicode, key) === unicode, 'Unicode roundtrip');

// Long string (SSH private key sized)
const longKey = 'BEGIN RSA PRIVATE KEY\n' + 'A'.repeat(4096) + '\nEND RSA PRIVATE KEY';
const ctLong = encrypt(longKey, key);
assert(decrypt(ctLong, key) === longKey, 'Large payload roundtrip (4K+ chars)');

// Short ciphertext rejection
try {
    decrypt(Buffer.from([1, 2, 3]), key);
    assert(false, 'Too-short ciphertext should throw');
} catch (err: any) {
    assert(err.message.includes('too short'), 'Short ciphertext throws expected error');
}

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(48)}\n`);

process.exit(failed > 0 ? 1 : 0);
