// A small, pure detector for secret-shaped text, usable from shared code (the
// main-side redactor cannot be imported here). It errs towards "secret": a
// false positive refuses a container, a false negative could leak a key.

const PREFIXED = [
  /\bsk-[A-Za-z0-9_-]{16,}/,                    // common model-provider API keys
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, // payment provider keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,               // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,                 // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,             // Slack
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,              // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}/,                    // Google API keys
  /\bnpm_[A-Za-z0-9]{36}/,                      // npm
  /\bpypi-[A-Za-z0-9_-]{50,}/,                  // PyPI
  /\bhf_[A-Za-z0-9]{30,}/,                      // model hub tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i  // credentials in a URL
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/**
 * True when the text contains a known key prefix, or a long run of token
 * characters (32+) with high entropy that mixes letters and digits. Plain hex
 * digests stay below the entropy bound (at most 4 bits per character).
 */
export function looksSecret(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (PREFIXED.some((re) => re.test(text))) return true;
  for (const run of text.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? []) {
    if (/[A-Za-z]/.test(run) && /[0-9]/.test(run) && entropy(run) > 4.3) return true;
  }
  return false;
}
