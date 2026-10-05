/** Which animated scene a launcher tile plays. Each scene shows what that
 *  kind of work looks like (code being typed, a loss curve falling, a
 *  pipeline firing). A workspace added to the registry later gets the
 *  generic scene until it is given its own. */
export const SCENE_KINDS = ['code', 'network', 'loss', 'bars', 'lens', 'checks', 'canvas', 'pipeline', 'generic'] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];

const BY_ID: Record<string, SceneKind> = {
  sde: 'code', ml: 'network', dl: 'loss', data: 'bars', research: 'lens', qa: 'checks', uiux: 'canvas', devops: 'pipeline'
};

export function sceneFor(id: string): SceneKind {
  return BY_ID[id] ?? 'generic';
}
