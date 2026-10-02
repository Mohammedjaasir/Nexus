import type { Landmark } from './sceneGeometry';

/* Landmark drawings, one per workspace. Local coordinates: origin is the
   centre of the island's top surface, up is negative y, roughly ±54 wide and
   up to 74 tall. Colours come from CSS classes driven by the island's hue:
     nx-lm-main  solid hue        nx-lm-light  pale hue
     nx-lm-dark  deep hue         nx-lm-win    windows (lit at night) */

function Tower() {
  return (
    <g>
      <rect className="nx-lm-dark" x={-30} y={-72} width={30} height={72} rx={3} />
      <rect className="nx-lm-main" x={-26} y={-72} width={26} height={72} rx={3} />
      <rect className="nx-lm-light" x={4} y={-46} width={26} height={46} rx={3} />
      <path className="nx-lm-dark" d="M -28 -72 L -13 -84 L 2 -72 Z" />
      <path className="nx-lm-win-stroke" d="M -18 -54 l -5 5 l 5 5 M -8 -54 l 5 5 l -5 5" />
      {[-34, -22, -10].map((y) => <rect key={y} className="nx-lm-win" x={10} y={y} width={14} height={5} rx={1.5} />)}
    </g>
  );
}

function Dome() {
  return (
    <g>
      <rect className="nx-lm-light" x={-40} y={-16} width={80} height={16} rx={3} />
      <path className="nx-lm-main" d="M -34 -16 A 34 34 0 0 1 34 -16 Z" />
      <path className="nx-lm-win-stroke" d="M -18 -26 L 0 -38 L 18 -26 M 0 -38 L 0 -22 M -18 -26 L 0 -22 L 18 -26" />
      {[[-18, -26], [0, -38], [18, -26], [0, -22]].map(([x, y]) => <circle key={`${x}${y}`} className="nx-lm-win" cx={x} cy={y} r={3.5} />)}
      <rect className="nx-lm-dark" x={-6} y={-60} width={12} height={10} rx={2} />
      <circle className="nx-lm-win" cx={0} cy={-62} r={3} />
    </g>
  );
}

function Layers() {
  const slab = (y: number, w: number, cls: string) => (
    <path key={y} className={cls} d={`M ${-w} ${y} L 0 ${y - 10} L ${w} ${y} L 0 ${y + 10} Z`} />
  );
  return (
    <g>
      {slab(-8, 46, 'nx-lm-dark')}
      {slab(-26, 40, 'nx-lm-main')}
      {slab(-44, 32, 'nx-lm-light')}
      {slab(-60, 22, 'nx-lm-main')}
      <circle className="nx-lm-win" cx={0} cy={-60} r={3.5} />
    </g>
  );
}

function Skyline() {
  const bars: [number, number, string][] = [[-40, 26, 'nx-lm-light'], [-22, 46, 'nx-lm-main'], [-4, 34, 'nx-lm-dark'], [14, 60, 'nx-lm-main'], [32, 40, 'nx-lm-light']];
  return (
    <g>
      {bars.map(([x, h, c]) => (
        <g key={x}>
          <rect className={c} x={x} y={-h} width={14} height={h} rx={2} />
          <rect className="nx-lm-win" x={x + 4} y={-h + 6} width={6} height={4} rx={1} />
        </g>
      ))}
      <path className="nx-lm-win-stroke" d="M -33 -36 L -15 -54 L 3 -42 L 21 -68 L 39 -50" />
    </g>
  );
}

function Observatory() {
  return (
    <g>
      <rect className="nx-lm-light" x={-26} y={-34} width={52} height={34} rx={3} />
      <path className="nx-lm-main" d="M -28 -34 A 28 28 0 0 1 28 -34 Z" />
      <path className="nx-lm-dark" d="M -3 -60 L 6 -60 L 6 -34 L -3 -34 Z" />
      <rect className="nx-lm-dark" x={2} y={-74} width={26} height={8} rx={4} transform="rotate(-28 2 -70)" />
      <rect className="nx-lm-win" x={-16} y={-22} width={8} height={10} rx={1.5} />
      <rect className="nx-lm-win" x={8} y={-22} width={8} height={10} rx={1.5} />
    </g>
  );
}

function Gate() {
  return (
    <g>
      <rect className="nx-lm-dark" x={-40} y={-56} width={16} height={56} rx={3} />
      <rect className="nx-lm-dark" x={24} y={-56} width={16} height={56} rx={3} />
      <path className="nx-lm-main" d="M -44 -56 Q 0 -86 44 -56 L 44 -48 Q 0 -76 -44 -48 Z" />
      <circle className="nx-lm-light" cx={0} cy={-34} r={16} />
      <path className="nx-lm-check" d="M -8 -34 L -2 -28 L 9 -40" />
    </g>
  );
}

function Studio() {
  return (
    <g>
      <rect className="nx-lm-light" x={-38} y={-38} width={60} height={38} rx={3} />
      <path className="nx-lm-main" d="M -44 -38 L -8 -62 L 28 -38 Z" />
      <rect className="nx-lm-win" x={-28} y={-26} width={12} height={12} rx={2} />
      <circle className="nx-lm-main" cx={34} cy={-26} r={18} />
      {[[28, -32], [38, -34], [42, -24]].map(([x, y]) => <circle key={`${x}${y}`} className="nx-lm-win" cx={x} cy={y} r={3} />)}
      <circle className="nx-lm-light" cx={30} cy={-20} r={4} />
    </g>
  );
}

function Launchpad() {
  return (
    <g>
      <rect className="nx-lm-dark" x={-42} y={-10} width={84} height={10} rx={3} />
      <rect className="nx-lm-light" x={20} y={-58} width={6} height={48} rx={2} />
      <path className="nx-lm-main" d="M -12 -18 L -12 -56 Q 0 -80 12 -56 L 12 -18 Z" />
      <path className="nx-lm-dark" d="M -12 -30 L -22 -16 L -12 -18 Z M 12 -30 L 22 -16 L 12 -18 Z" />
      <circle className="nx-lm-win" cx={0} cy={-46} r={4.5} />
      <path className="nx-lm-flame" d="M -6 -16 Q 0 -2 6 -16 Z" />
    </g>
  );
}

function Generic() {
  return (
    <g>
      <rect className="nx-lm-main" x={-28} y={-40} width={56} height={40} rx={3} />
      <path className="nx-lm-dark" d="M -34 -40 L 0 -62 L 34 -40 Z" />
      <rect className="nx-lm-win" x={-8} y={-24} width={16} height={24} rx={2} />
    </g>
  );
}

export function LandmarkShape({ kind }: { kind: Landmark }) {
  switch (kind) {
    case 'tower': return <Tower />;
    case 'dome': return <Dome />;
    case 'layers': return <Layers />;
    case 'skyline': return <Skyline />;
    case 'observatory': return <Observatory />;
    case 'gate': return <Gate />;
    case 'studio': return <Studio />;
    case 'launchpad': return <Launchpad />;
    default: return <Generic />;
  }
}
