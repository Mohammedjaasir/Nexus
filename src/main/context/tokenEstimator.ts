/**
 * Deterministic Token Estimator.
 *
 * Provides fast, offline token estimation for source code, markdown, and structured metadata.
 * Uses calibrated character and token boundary heuristics (averaging ~3.6 chars per token for code).
 */

export function estimateTokens(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const len = text.length;
  if (len === 0) return 0;

  // Split by whitespace and common code punctuation boundaries
  const words = text.trim().split(/[\s,;{}()\[\]<>="'`]+/);
  const wordCount = words.length;

  // Blended heuristic: chars / 3.6 with word floor
  const charEstimate = Math.ceil(len / 3.6);
  const wordEstimate = Math.ceil(wordCount * 1.3);

  return Math.max(1, Math.round((charEstimate + wordEstimate) / 2));
}

export function estimateFileTokens(content: string): number {
  return estimateTokens(content);
}
