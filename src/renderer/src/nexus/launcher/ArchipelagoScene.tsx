import { memo, useMemo } from 'react';
import { WORKSPACES, LAUNCHER_SHORTCUTS } from '../workspaces/registry';
import { buildScene, ISLAND_LIFT, VIEW } from './sceneGeometry';
import { LandmarkShape } from './landmarks';

/* The launcher's world, drawn in code: floating islands (one per workspace,
   each with its own landmark), arched bridges to a central Nexus core, and
   light pulses telling the model → app → deploy route. Decorative only — the
   interactive cards are HTML laid over it (aria-hidden here). */

// Deterministic star field for the night sky (no randomness at render).
const STARS = Array.from({ length: 34 }, (_, i) => ({
  x: (i * 173 + 41) % VIEW.w,
  y: ((i * 97 + 13) % 260) + 8,
  r: i % 5 === 0 ? 1.8 : 1.1,
  d: (i % 7) * 0.6
}));

const DRIFTERS = [
  { x: 70, y: 110, s: 0.32 },
  { x: 935, y: 128, s: 0.26 },
  { x: 955, y: 470, s: 0.22 },
  { x: 48, y: 420, s: 0.2 }
];

function IslandBase({ rx }: { rx: number }) {
  const r = rx;
  return (
    <g>
      <ellipse className="nx-isl__shadow" cx={0} cy={112} rx={r * 0.4} ry={6} />
      <path className="nx-isl__rock" d={`M ${-r} 4 C ${-r * 0.92} 40 ${-r * 0.5} 66 ${-r * 0.16} 98 Q 0 112 ${r * 0.16} 98 C ${r * 0.5} 66 ${r * 0.92} 40 ${r} 4 Z`} />
      <path className="nx-isl__strata" d={`M ${-r * 0.78} 30 Q 0 48 ${r * 0.78} 30 M ${-r * 0.5} 58 Q 0 72 ${r * 0.5} 58`} />
      <ellipse className="nx-isl__edge" cx={0} cy={6} rx={r} ry={r * 0.26} />
      <ellipse className="nx-isl__top" cx={0} cy={0} rx={r} ry={r * 0.26} />
      <ellipse className="nx-isl__sheen" cx={-r * 0.25} cy={-r * 0.06} rx={r * 0.5} ry={r * 0.1} />
      <g className="nx-isl__trees">
        <circle cx={-r * 0.78} cy={-6} r={9} /><circle cx={-r * 0.66} cy={-10} r={7} />
        <circle cx={r * 0.74} cy={-5} r={8} />
      </g>
    </g>
  );
}

function CoreCrystal() {
  return (
    <g className="nx-core">
      <ellipse className="nx-core__ring" cx={0} cy={-38} rx={46} ry={14} />
      <path className="nx-core__body" d="M 0 -96 L 26 -48 L 0 -10 L -26 -48 Z" />
      <path className="nx-core__facet" d="M 0 -96 L 26 -48 L 0 -42 Z" />
      <path className="nx-core__shine" d="M -8 -78 L -2 -66" />
    </g>
  );
}

export const ArchipelagoScene = memo(function ArchipelagoScene({ active, motion }: { active: string | null; motion: boolean }) {
  const scene = useMemo(() => buildScene(WORKSPACES, LAUNCHER_SHORTCUTS[0]), []);
  const core = scene.core.at;
  return (
    <svg className="nx-scene" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="nx-core-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5B8CFF" />
          <stop offset="100%" stopColor="#7C4DFF" />
        </linearGradient>
        <radialGradient id="nx-sun" cx="50%" cy="50%" r="50%">
          <stop offset="0%" className="nx-sun__core" />
          <stop offset="100%" className="nx-sun__edge" />
        </radialGradient>
        <filter id="nx-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>

      <circle className="nx-sun" cx={905} cy={70} r={120} fill="url(#nx-sun)" />
      <g className="nx-stars">
        {STARS.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} style={{ animationDelay: `${s.d}s` }} />)}
      </g>

      {DRIFTERS.map((d, i) => (
        <g key={i} className="nx-drifter" transform={`translate(${d.x} ${d.y}) scale(${d.s})`} style={{ animationDelay: `${i * -2.3}s` }}>
          <IslandBase rx={70} />
        </g>
      ))}

      <g className="nx-cloudbank">
        {[60, 230, 420, 610, 800, 960].map((x, i) => <ellipse key={x} cx={x} cy={VIEW.h + 8} rx={150} ry={46 + (i % 3) * 8} />)}
      </g>

      {/* Bridges and pulses run between island tops (lifted above the card anchor). */}
      <g transform={`translate(0 ${-ISLAND_LIFT})`}>
        {scene.bridges.map((b) => (
          <g key={b.id} className={`nx-bridge${active === b.id || active === 'projects' ? ' is-active' : ''}`} data-hue={scene.islands.find((i) => i.id === b.id)?.hue}>
            <path className="nx-bridge__glow" d={b.d} />
            <path className="nx-bridge__deck" d={b.d} />
            <path className="nx-bridge__rail" d={b.d} />
          </g>
        ))}
        {motion && scene.flow.map((f) => (
          <g key={f.id} className="nx-pulse">
            <circle r={9} className="nx-pulse__halo" filter="url(#nx-glow)">
              <animateMotion dur="3.3s" begin={`${f.delay}s`} repeatCount="indefinite" path={f.d} />
            </circle>
            <circle r={4.5} className="nx-pulse__dot">
              <animateMotion dur="3.3s" begin={`${f.delay}s`} repeatCount="indefinite" path={f.d} />
            </circle>
          </g>
        ))}
      </g>

      {scene.islands.map((isl, i) => (
        <g key={isl.id} className={`nx-isl${active === isl.id ? ' is-active' : ''}`} data-hue={isl.hue}
          transform={`translate(${isl.at.x} ${isl.at.y - ISLAND_LIFT})`}>
          <g className="nx-isl__bob" style={{ animationDelay: `${(i % 4) * -1.4}s` }}>
            <IslandBase rx={92} />
            <g className="nx-isl__landmark"><LandmarkShape kind={isl.landmark} /></g>
          </g>
        </g>
      ))}

      <g className={`nx-isl nx-isl--core${active === 'projects' ? ' is-active' : ''}`} transform={`translate(${core.x} ${core.y - ISLAND_LIFT})`}>
        <g className="nx-isl__bob">
          <IslandBase rx={108} />
          <CoreCrystal />
        </g>
      </g>
    </svg>
  );
});
