/**
 * A bare program name that may be handed to `where.exe` (O.9 #17): letters,
 * digits and `. _ + -` only. No path separators, spaces, quotes or shell
 * metacharacters. Names that fail this skip the `where` probe and fall through
 * to the fixed-location candidates, as a name with a space always did.
 */
export function isSafeCommandName(name: string): boolean {
  return typeof name === 'string' && /^[A-Za-z0-9._+-]+$/.test(name);
}
