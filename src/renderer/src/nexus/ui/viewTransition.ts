type Doc = { startViewTransition?: (cb: () => void) => unknown };

/** Runs `update` inside a document view transition when the browser supports it
 *  and motion is allowed; otherwise runs it directly. Never blocks the update. */
export function withViewTransition(update: () => void, opts: { reduce?: boolean; doc?: Doc } = {}): void {
  const doc: Doc = opts.doc ?? (typeof document !== 'undefined' ? (document as unknown as Doc) : {});
  const reduce = opts.reduce ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!reduce && typeof doc.startViewTransition === 'function') { doc.startViewTransition(update); return; }
  update();
}
