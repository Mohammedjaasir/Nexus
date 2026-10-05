import type { CSSProperties } from 'react';
import { sceneFor, type SceneKind } from './sceneKinds';

/* Small looping scenes, one per environment, drawn in a 200×120 box.
   Colours come from the tile's --tc (its provenance hue); motion lives in
   styles/launcher.css under prefers-reduced-motion: no-preference, so with
   reduced motion each scene rests in a readable still frame. */

const d = (s: number): CSSProperties => ({ animationDelay: `${s}s` });
const MONO = { fontFamily: 'var(--nx-font-id)', fontSize: 8.5 } as const;

function Code() {
  return (
    <>
      {[30, 52, 74, 96].map((y, i) => <text key={y} x={14} y={y} className="nx-sc-text" style={MONO}>{i + 1}</text>)}
      <rect x={30} y={23} height={9} rx={2} width={96} className="nx-sc-fill nx-sc-type" />
      <rect x={42} y={45} height={9} rx={2} width={70} className="nx-sc-soft nx-sc-type" style={d(0.6)} />
      <rect x={42} y={67} height={9} rx={2} width={110} className="nx-sc-fill nx-sc-type nx-sc-dim" style={d(1.2)} />
      <rect x={30} y={89} width={30} height={9} rx={2} className="nx-sc-soft" />
      <rect x={64} y={88} width={3} height={11} className="nx-sc-fill nx-sc-caret" />
    </>
  );
}

function Network() {
  const ins = [[40, 30], [40, 60], [40, 90]], hid = [[100, 40], [100, 80]];
  return (
    <>
      {ins.flatMap(([x, y]) => hid.map(([a, b]) => <line key={`${x}${y}${a}${b}`} x1={x} y1={y} x2={a} y2={b} className="nx-sc-line nx-sc-flow" />))}
      {hid.map(([x, y]) => <line key={`o${y}`} x1={x} y1={y} x2={160} y2={60} className="nx-sc-line nx-sc-flow" />)}
      {[[40, 30], [40, 60], [40, 90], [100, 40], [100, 80], [160, 60]].map(([x, y], i) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={6} className="nx-sc-fill nx-sc-pulse" style={d(i * 0.3)} />
      ))}
    </>
  );
}

function Loss() {
  return (
    <>
      <line x1={20} y1={100} x2={186} y2={100} className="nx-sc-line" />
      <line x1={20} y1={14} x2={20} y2={100} className="nx-sc-line" />
      <path d="M22 22 C 50 70, 70 78, 100 86 S 160 92, 184 93" className="nx-sc-stroke nx-sc-draw" />
      <path d="M22 30 C 50 80, 80 84, 110 90 S 160 94, 184 95" className="nx-sc-stroke nx-sc-draw nx-sc-faint" style={d(0.3)} />
      <text x={150} y={26} className="nx-sc-text" style={MONO}>loss ↓</text>
    </>
  );
}

function Bars() {
  return (
    <>
      {[26, 52, 78, 104, 130, 156].map((x, i) => {
        const top = 30 + ((i * 37) % 40);
        return <rect key={x} x={x} y={top} width={18} height={100 - top} rx={3} className={`${i % 2 ? 'nx-sc-soft' : 'nx-sc-fill'} nx-sc-grow`} style={d(i * 0.25)} />;
      })}
      <line x1={18} y1={100} x2={184} y2={100} className="nx-sc-line" />
    </>
  );
}

function Lens() {
  return (
    <>
      {[24, 40, 56, 72, 88].map((y, i) => <rect key={y} x={24} y={y} width={150 - ((i * 17) % 60)} height={6} rx={3} className="nx-sc-soft" />)}
      <g className="nx-sc-scan">
        <circle cx={50} cy={44} r={20} className="nx-sc-stroke nx-sc-glass" />
        <line x1={64} y1={58} x2={78} y2={72} className="nx-sc-stroke nx-sc-thick" />
      </g>
    </>
  );
}

function Checks() {
  return (
    <>
      {[26, 52, 78].map((y, i) => (
        <g key={y}>
          <rect x={30} y={y - 9} width={18} height={18} rx={5} className="nx-sc-line nx-sc-box" />
          <path d={`M34 ${y} l4 4 l8 -9`} className="nx-sc-stroke nx-sc-tick" style={d(i * 0.8)} />
          <rect x={58} y={y - 3} width={100 - i * 18} height={6} rx={3} className="nx-sc-soft" />
        </g>
      ))}
    </>
  );
}

function Canvas() {
  return (
    <>
      <rect x={40} y={30} width={110} height={56} rx={10} className="nx-sc-stroke nx-sc-frame" />
      {[0, 1, 2].map((i) => <circle key={i} cx={166} cy={26 + i * 16} r={6} className="nx-sc-fill" style={{ opacity: 1 - i * 0.3 }} />)}
      <path className="nx-sc-fill nx-sc-cursor" d="M0 0 L0 14 L4 10 L7 17 L9 16 L6 9 L11 9 Z" />
    </>
  );
}

function Pipeline() {
  return (
    <>
      <line x1={22} y1={72} x2={150} y2={72} className="nx-sc-line" />
      {[22, 58, 94, 130].map((x, i) => <circle key={x} cx={x} cy={72} r={9} className="nx-sc-fill nx-sc-stage" style={d(i * 0.35)} />)}
      {['build', 'test', 'scan', 'ship'].map((w, i) => <text key={w} x={22 + i * 36} y={98} textAnchor="middle" className="nx-sc-text" style={MONO}>{w}</text>)}
      <g className="nx-sc-rocket">
        <path d="M172 80 L172 58 Q178 44 184 58 L184 80 Z" className="nx-sc-fill" />
        <path d="M174 82 Q178 94 182 82 Z" className="nx-sc-flame" />
      </g>
    </>
  );
}

function Generic() {
  return (
    <>
      {[0, 1, 2].map((i) => <rect key={i} x={40 + i * 44} y={34} width={34} height={52} rx={8} className={i === 1 ? 'nx-sc-fill nx-sc-grow' : 'nx-sc-soft'} />)}
    </>
  );
}

const SCENES: Record<SceneKind, () => JSX.Element> = {
  code: Code, network: Network, loss: Loss, bars: Bars, lens: Lens, checks: Checks, canvas: Canvas, pipeline: Pipeline, generic: Generic
};

export function TileScene({ id }: { id: string }) {
  const Scene = SCENES[sceneFor(id)];
  return (
    <svg viewBox="0 0 200 120" className="nx-scene" aria-hidden="true" focusable="false">
      <Scene />
    </svg>
  );
}
