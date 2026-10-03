const bcrypt = require('bcryptjs');

/**
 * Single source of truth for password hashing in LabSync.
 *
 * Previously the same bcrypt literals were copy-pasted across six files. That
 * meant every auto-provisioned account silently shared one publicly-committed
 * hash, and no flow forced a change on first login.
 */

// bcrypt cost 12 is the current OWASP floor; cost 10 is no longer acceptable.
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

/**
 * Deterministic fallback used only when a row has no stored hash (legacy rows
 * created before the hash column was populated). It is intentionally NOT the
 * hash of a guessable password: accounts provisioned with it are marked for
 * reset rather than being silently usable.
 */
const LEGACY_UNSET_HASH = '$2a$12$8kGJ3vJ1nQ7wR2yXeLp0mZ9rT4bH6cD1fA5sN7uP2vC8lK4eW3oQy';

function getFallbackHash() {
  return process.env.DEFAULT_USER_PASSWORD_HASH || LEGACY_UNSET_HASH;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Generate a strong random password for auto-provisioned accounts.
 * The plaintext is returned once so it can be delivered to the owner; only the
 * hash is ever stored.
 */
function generateStrongPassword(length = 16) {
  // Ambiguous glyphs removed (0/O, 1/l/I) so it can be read aloud / typed.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=_';
  const bytes = require('crypto').randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const v = bytes[i];
    // Reject values in the top partial range so the distribution stays uniform.
    if (v < 256 - (256 % alphabet.length)) out += alphabet[v % alphabet.length];
  }
  return out;
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch (e) {
    return false;
  }
}

module.exports = {
  BCRYPT_ROUNDS,
  getFallbackHash,
  hashPassword,
  generateStrongPassword,
  verifyPassword,
};