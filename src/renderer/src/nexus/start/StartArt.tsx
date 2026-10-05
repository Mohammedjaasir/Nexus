/* The Start page's scenery, drawn in code: layered flowing waves, a laptop
   with a glowing screen, and frosted glass tiles holding the kinds of work
   (code, charts, docs, graphs, models) floating around it. Decorative only;
   motion lives in styles/start.css under prefers-reduced-motion:
   no-preference. */

function Glyph({ kind }: { kind: 'code' | 'bars' | 'doc' | 'graph' | 'cube' }) {
  switch (kind) {
    case 'code': return <path d="M14 10 L7 18 L14 26 M26 10 L33 18 L26 26 M22 8 L18 28" />;
    case 'bars': return <><rect x="9" y="18" width="5" height="10" rx="1.5" /><rect x="17" y="12" width="5" height="16" rx="1.5" /><rect x="25" y="7" width="5" height="21" rx="1.5" /></>;
    case 'doc': return <path d="M9 10 H31 M9 16 H27 M9 22 H31 M9 28 H22" />;
    case 'graph': return <><circle cx="12" cy="26" r="3.5" /><circle cx="20" cy="10" r="3.5" /><circle cx="30" cy="22" r="3.5" /><path d="M13.6 23 L18.4 13 M22.8 12.4 L27.6 19.6" /></>;
    case 'cube': return <path d="M20 7 L31 13 L31 25 L20 31 L9 25 L9 13 Z M9 13 L20 19 L31 13 M20 19 L20 31" />;
  }
}

const TILES: { kind: 'code' | 'bars' | 'doc' | 'graph' | 'cube'; x: number; y: number; r: number; d: number; s: number }[] = [
  { kind: 'code', x: 21, y: 18, r: -8, d: 0, s: 1 },
  { kind: 'bars', x: 36, y: 40, r: 7, d: -1.6, s: 0.86 },
  { kind: 'doc', x: 70, y: 26, r: 9, d: -3.1, s: 1 },
  { kind: 'graph', x: 86, y: 44, r: -10, d: -2.2, s: 0.86 },
  { kind: 'cube', x: 64, y: 72, r: -6, d: -0.8, s: 0.9 }
];

export function StartArt() {
  return (
    <div className="nx-start__art" aria-hidden="true">
      <svg className="nx-waves" viewBox="0 0 1440 460" preserveAspectRatio="none">
        <defs>
          <linearGradient id="nx-wave-a" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="nx-wave-stop-a1" /><stop offset="100%" className="nx-wave-stop-a2" /></linearGradient>
          <linearGradient id="nx-wave-b" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" className="nx-wave-stop-b1" /><stop offset="100%" className="nx-wave-stop-b2" /></linearGradient>
          <linearGradient id="nx-wave-c" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" className="nx-wave-stop-c1" /><stop offset="100%" className="nx-wave-stop-c2" /></linearGradient>
        </defs>
        <g className="nx-wave nx-wave--a"><path d="M0 110 C 240 40, 420 240, 720 170 S 1200 40, 1440 110 L 1440 460 L 0 460 Z M1440 110 C 1680 40, 1860 240, 2160 170 S 2640 40, 2880 110 L 2880 460 L 1440 460 Z" fill="url(#nx-wave-a)" /></g>
        <g className="nx-wave nx-wave--b"><path d="M0 240 C 300 150, 520 330, 820 250 S 1260 170, 1440 240 L 1440 460 L 0 460 Z M1440 240 C 1740 150, 1960 330, 2260 250 S 2700 170, 2880 240 L 2880 460 L 1440 460 Z" fill="url(#nx-wave-b)" /></g>
        <g className="nx-wave nx-wave--c"><path d="M0 330 C 260 280, 560 400, 900 340 S 1300 290, 1440 330 L 1440 460 L 0 460 Z M1440 330 C 1700 280, 2000 400, 2340 340 S 2740 290, 2880 330 L 2880 460 L 1440 460 Z" fill="url(#nx-wave-c)" /></g>
        <path className="nx-wave-line" d="M0 200 C 280 120, 520 300, 820 230 S 1260 140, 1440 200" />
      </svg>

      <svg className="nx-laptop" viewBox="0 0 360 250">
        <defs>
          <linearGradient id="nx-screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" className="nx-screen-stop-1" /><stop offset="100%" className="nx-screen-stop-2" /></linearGradient>
          <linearGradient id="nx-glare" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#fff" stopOpacity="0.55" /><stop offset="45%" stopColor="#fff" stopOpacity="0" /></linearGradient>
        </defs>
        <ellipse className="nx-laptop__shadow" cx="182" cy="232" rx="150" ry="12" />
        <path className="nx-laptop__lid" d="M92 18 L300 8 Q308 8 306 16 L276 168 L74 172 Z" />
        <path d="M100 26 L294 17 L268 160 L82 164 Z" fill="url(#nx-screen)" />
        <path d="M100 26 L294 17 L268 160 L82 164 Z" fill="url(#nx-glare)" />
        <g className="nx-laptop__code">
          <rect x="112" y="44" width="70" height="7" rx="3.5" /><rect x="120" y="60" width="104" height="7" rx="3.5" /><rect x="120" y="76" width="82" height="7" rx="3.5" />
          <rect x="112" y="92" width="58" height="7" rx="3.5" /><rect x="128" y="108" width="96" height="7" rx="3.5" />
        </g>
        <path className="nx-laptop__base" d="M44 178 L292 172 Q302 172 304 180 L310 198 Q312 206 302 206 L36 212 Q26 212 28 204 L34 186 Q36 178 44 178 Z" />
        <path className="nx-laptop__keys" d="M70 186 L276 181 M64 194 L282 189" />
        <rect className="nx-laptop__pad" x="140" y="198" width="70" height="6" rx="3" />
      </svg>

      {TILES.map((t) => (
        <span key={t.kind} className="nx-glass" style={{ left: `${t.x}%`, top: `${t.y}%`, ['--r' as string]: `${t.r}deg`, ['--s' as string]: t.s, animationDelay: `${t.d}s` }}>
          <svg viewBox="0 0 40 36"><Glyph kind={t.kind} /></svg>
        </span>
      ))}
    </div>
  );
}
