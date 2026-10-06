/** Pure decisions for the team restore, kept free of React and the store so they can be tested. */

export interface AutoRestoreInput {
  autoRestoreEnabled: boolean;
  autoStarted: boolean;
  restoring: boolean;
  onboardingComplete: boolean;
  restorableCount: number;
}

/** True when the app shell should schedule the one-time boot restore. */
export function shouldScheduleAutoRestore(i: AutoRestoreInput): boolean {
  return i.autoRestoreEnabled && i.onboardingComplete && !i.autoStarted && !i.restoring && i.restorableCount > 0;
}

export type RestoreStatus =
  | { kind: 'idle' }
  | { kind: 'pending'; count: number }
  | { kind: 'running'; auto: boolean }
  | { kind: 'done'; note: string };

export function restoreStatusLine(s: RestoreStatus): string | null {
  switch (s.kind) {
    case 'pending':
      return `Restoring ${s.count} ${s.count === 1 ? 'agent' : 'agents'} from your last session in a moment.`;
    case 'running':
      return s.auto ? 'Restoring agents from your last session…' : 'Restoring agents…';
    case 'done':
      return s.note === 'nothing to restore' ? null : `Last session: ${s.note}`;
    default:
      return null;
  }
}
