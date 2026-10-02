// Pure geometry for the launcher's archipelago scene. The scene's SVG uses a
// 16:10 viewBox and the stage box is held at exactly 16:10, so a registry
// `island` point (percent of the stage) lands on the same spot in both the
// SVG and the HTML card layer.

export const VIEW = { w: 1000, h: 625 } as const;

export interface Pt { x: number; y: number }

const round = (n: number) => Math.round(n * 10) / 10;

export function toView(p: Pt): Pt {
  return { x: round((p.x / 100) * VIEW.w), y: round((p.y / 100) * VIEW.h) };
}

/** An arched bridge: a quadratic curve whose control point sits above the
 *  midpoint, lifted in proportion to the span. */
export function bridgePath(a: Pt, b: Pt): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const lift = Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
  return `M ${round(a.x)} ${round(a.y)} Q ${round(mx)} ${round(my - lift)} ${round(b.x)} ${round(b.y)}`;
}

/** The model-to-app-to-deploy route the pulses tell. Workspaces missing from
 *  the registry are skipped, so the route degrades instead of breaking. */
export const FLOW_ROUTE = ['ml', 'sde', 'uiux', 'devops'] as const;

export const LANDMARKS = ['tower', 'dome', 'layers', 'skyline', 'observatory', 'gate', 'studio', 'launchpad', 'generic'] as const;
export type Landmark = (typeof LANDMARKS)[number];

const LANDMARK_BY_ID: Record<string, Landmark> = {
  sde: 'tower', ml: 'dome', dl: 'layers', data: 'skyline', research: 'observatory',
  qa: 'gate', uiux: 'studio', devops: 'launchpad'
};

/** A workspace added to the registry later gets a generic landmark until it
 *  is given its own — the scene never breaks on an unknown id. */
export function landmarkFor(id: string): Landmark {
  return LANDMARK_BY_ID[id] ?? 'generic';
}

/** Where the island's top surface sits relative to its registry point: the
 *  card hangs over the island's cliff, so the island is drawn above it. */
export const ISLAND_LIFT = 46;

export interface SceneIsland { id: string; hue: string; landmark: Landmark; at: Pt }
export interface SceneBridge { id: string; d: string }
export interface SceneFlow { id: string; d: string; delay: number }
export interface Scene { core: { at: Pt }; islands: SceneIsland[]; bridges: SceneBridge[]; flow: SceneFlow[] }

export function buildScene(
  workspaces: { id: string; hue: string; island: Pt }[],
  core: { island: Pt }
): Scene {
  const coreAt = toView(core.island);
  const islands = workspaces.map((w) => ({ id: w.id, hue: w.hue, landmark: landmarkFor(w.id), at: toView(w.island) }));
  const bridges = islands.map((i) => ({ id: i.id, d: bridgePath(coreAt, i.at) }));
  const STEP = 1.1;
  const flow = FLOW_ROUTE
    .map((id) => islands.find((i) => i.id === id))
    .filter((i): i is SceneIsland => !!i)
    .map((i, n) => ({
      id: i.id,
      // The first stop sends its output in to the core; every later stop
      // receives work going out from the core.
      d: n === 0 ? bridgePath(i.at, coreAt) : bridgePath(coreAt, i.at),
      delay: round(n * STEP)
    }));
  return { core: { at: coreAt }, islands, bridges, flow };
}
