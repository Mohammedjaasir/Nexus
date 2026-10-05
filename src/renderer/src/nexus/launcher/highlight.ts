export interface Segment { text: string; hit: boolean }

/** Split a name into segments, marking the typed query as a prefix of each
 *  word it starts (case-insensitive). Mirrors how indexModel matches words,
 *  so what lights up is what made the row match. */
export function highlightSegments(name: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text: name, hit: false }];
  const out: Segment[] = [];
  let plain = '';
  const re = /[A-Za-z0-9]+|[^A-Za-z0-9]+/g;
  for (const m of name.match(re) ?? []) {
    const isWord = /^[A-Za-z0-9]/.test(m);
    if (isWord && m.toLowerCase().startsWith(q)) {
      if (plain) { out.push({ text: plain, hit: false }); plain = ''; }
      out.push({ text: m.slice(0, q.length), hit: true });
      plain = m.slice(q.length);
    } else {
      plain += m;
    }
  }
  if (plain) out.push({ text: plain, hit: false });
  return out;
}
