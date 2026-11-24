/**
 * Generates the ADMIN_PASSWORD_HASH value used by the Worker.
 *
 *   npm run admin:hash -- "a long passphrase"
 *
 * The output is safe to paste into .dev.vars (local) or Sites → Secrets (hosted).
 * The password itself is never stored anywhere.
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const password = process.argv.slice(2).join(' ');

if (!password) {
  console.error('Usage: npm run admin:hash -- "<password>"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('Choose a password of at least 12 characters.');
  process.exit(1);
}

const iterations = 210_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

console.log(`pbkdf2$sha256$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`);
