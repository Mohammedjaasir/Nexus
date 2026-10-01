/**
 * Deterministic Code Summarizer & Signature Extractor.
 *
 * Extracts compact representations of source files across context tiers:
 * - Tier 2: SIGNATURE (exports, interfaces, type definitions, function & class signatures)
 * - Tier 3: SUMMARY (high-level structural summary, module overview)
 * - Tier 4: METADATA (1-line path, kind, and relationship overview)
 */

import { extname } from 'node:path';

export function extractTier2Signature(content: string, filePath: string): string {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '');
  const lines = content.split('\n');
  const signatureLines: string[] = [];

  let inDocstring = false;
  let docstringDelimiter = '';

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (!line) continue;

    // TypeScript / JavaScript
    if (['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'].includes(ext)) {
      // Preserve imports for context
      if (line.startsWith('import ') || line.startsWith('export ') || line.includes('require(')) {
        if (line.startsWith('export class ') || line.startsWith('class ')) {
          signatureLines.push(rawLine.replace(/\{.*$/, '{ … }'));
        } else if (line.startsWith('export function ') || line.startsWith('function ')) {
          signatureLines.push(rawLine.replace(/\{.*$/, '{ … }'));
        } else if (line.startsWith('export const ') && (line.includes('=>') || line.includes('function'))) {
          signatureLines.push(rawLine.replace(/\{.*$/, '{ … }'));
        } else if (line.startsWith('export interface ') || line.startsWith('interface ') || line.startsWith('export type ') || line.startsWith('type ')) {
          signatureLines.push(rawLine);
        } else if (line.startsWith('import ') || line.startsWith('export ')) {
          signatureLines.push(rawLine);
        }
      }
      // Top-level JSDoc
      if (line.startsWith('/**') || line.startsWith('*') || line.startsWith('*/')) {
        signatureLines.push(rawLine);
      }
    }
    // Python
    else if (ext === 'py') {
      if (line.startsWith('import ') || line.startsWith('from ')) {
        signatureLines.push(rawLine);
      } else if (line.startsWith('class ')) {
        signatureLines.push(rawLine);
      } else if (line.startsWith('def ') || line.startsWith('async def ')) {
        signatureLines.push(rawLine.replace(/:.*$/, ': …'));
      } else if (line.startsWith('@')) {
        signatureLines.push(rawLine);
      } else if (line.startsWith('"""') || line.startsWith("'''")) {
        signatureLines.push(rawLine);
      }
    }
    // Generic fallback
    else {
      if (signatureLines.length < 30) {
        signatureLines.push(rawLine);
      }
    }
  }

  if (signatureLines.length === 0) {
    return `// [Signature for ${filePath}]\n${lines.slice(0, 15).join('\n')}\n// …`;
  }

  return `// --- SIGNATURE: ${filePath} ---\n` + signatureLines.join('\n');
}

export function extractTier3Summary(content: string, filePath: string, symbols: string[] = []): string {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const byteCount = content.length;

  let docHeader = '';
  for (const line of lines.slice(0, 8)) {
    const l = line.trim();
    if (l.startsWith('//') || l.startsWith('#') || l.startsWith('*') || l.startsWith('/*')) {
      docHeader += line + '\n';
    }
  }

  const symbolList = symbols.length > 0 ? symbols.slice(0, 8).join(', ') : 'None extracted';

  return (
    `// --- SUMMARY: ${filePath} (${lineCount} lines, ${byteCount} bytes) ---\n` +
    (docHeader ? `${docHeader.trim()}\n` : '') +
    `// Exported/Key Symbols: ${symbolList}`
  );
}

export function extractTier4Metadata(
  filePath: string,
  kind: string,
  reason: string,
  relInfo?: string
): string {
  return `[METADATA] ${kind.toUpperCase()} | path: "${filePath}" | reason: ${reason}${relInfo ? ` | ${relInfo}` : ''}`;
}
