/**
 * O.9 #10: new installs start with auto mode off, but an EXISTING install that
 * has it on is never switched silently. It sees the "Auto mode is on" banner
 * (Agents page and Settings → Autonomy) until the user answers it once.
 */
export function autoModeNeedsReview(cfg: { autoMode?: boolean; autoModeReviewedV1?: boolean }): boolean {
  return cfg.autoMode === true && cfg.autoModeReviewedV1 !== true;
}

/** Banner copy (shared by both surfaces). */
export const AUTO_MODE_BANNER = {
  title: 'Auto mode is on',
  body: 'Agents skip their CLI approval prompts, so they can run commands and change files without asking. New installs now start with auto mode off.',
  turnOff: 'Turn auto mode off',
  keep: 'Keep auto mode on'
} as const;
