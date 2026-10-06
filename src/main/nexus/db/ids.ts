import { randomBytes } from 'node:crypto';

// Crockford base32 (no I, L, O, U), as used by ULID.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 26-character ULID: 10 characters of millisecond time (48 bits, so ids sort
 * by creation time) followed by 16 characters of randomness (80 bits).
 * `at` exists for tests; callers normally omit it.
 */
export function newId(at: number = Date.now()): string {
  let t = Math.max(0, Math.floor(at));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] & 31];
  return time + rand;
}
