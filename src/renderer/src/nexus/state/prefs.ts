type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PREFIX = 'nx.';

export function readPref(storage: KV | null, key: string): string | null {
  try { return storage ? storage.getItem(PREFIX + key) : null; } catch { return null; }
}

export function writePref(storage: KV | null, key: string, value: string | null): void {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(PREFIX + key);
    else storage.setItem(PREFIX + key, value);
  } catch { /* storage unavailable: preference simply isn't remembered */ }
}

export function browserStorage(): KV | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}
