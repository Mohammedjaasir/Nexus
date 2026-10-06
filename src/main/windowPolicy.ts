/**
 * Window security policy (O.9 #2 and #3): pure decisions, no Electron imports,
 * so the tables are unit-tested directly (test/nexus-window-policy.test.cjs).
 *
 * index.ts wires these into the session permission handlers, the window-open
 * handler, the `will-navigate` guard and `app:openExternal`.
 */

/** Permissions the renderer may hold regardless of feature flags.
 *  `clipboard-sanitized-write` backs `navigator.clipboard.writeText` (copy path,
 *  copy code). Clipboard READS go through IPC (`clipboard:*`), so
 *  `clipboard-read` is deliberately not here. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['clipboard-sanitized-write']);

/** True when every requested media type is audio. An absent or empty list is
 *  treated as audio-only: the gate is still `micLive`. */
function audioOnly(mediaTypes: readonly string[] | undefined): boolean {
  if (!mediaTypes || mediaTypes.length === 0) return true;
  return mediaTypes.every((t) => t === 'audio');
}

/**
 * Permission REQUEST decision. Deny by default. The microphone (`media`, audio
 * only) is granted only while a mic feature is live (Free Flow dictation or a
 * realtime voice session); any request that includes video is refused.
 */
export function decidePermission(i: { permission: string; mediaTypes?: readonly string[]; micLive: boolean }): boolean {
  if (ALWAYS_ALLOWED.has(i.permission)) return true;
  if (i.permission === 'media') return i.micLive && audioOnly(i.mediaTypes);
  return false;
}

/** Permission CHECK decision (synchronous queries such as
 *  `navigator.permissions`). Same table as the request handler. */
export function decidePermissionCheck(permission: string, micLive: boolean): boolean {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (permission === 'media') return micLive;
  return false;
}

/** URLs that may leave the app for the OS default handler: https links and
 *  macOS System Settings deep links. `http:`, `file:`, `javascript:`, custom
 *  schemes and UNC paths are refused. */
export function isAllowedExternalUrl(url: string): boolean {
  return typeof url === 'string' && /^(x-apple\.systempreferences:|https:\/\/)/.test(url);
}

function filePathKey(pathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  // Windows drive paths (`/C:/...`) compare case-insensitively.
  return /^\/[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/**
 * Whether a main-frame navigation stays inside the app. For the dev server
 * (`http:`/`https:`) the origin must match exactly (scheme, host and port). For
 * the packaged `file:` build the target must be the same file; hash and query
 * are ignored so in-app routes still work. Anything else is refused.
 */
export function isInAppNavigation(url: string, appUrl: string): boolean {
  let target: URL;
  let app: URL;
  try { target = new URL(url); app = new URL(appUrl); } catch { return false; }
  if (app.protocol === 'http:' || app.protocol === 'https:') {
    return target.protocol === app.protocol && target.origin === app.origin;
  }
  if (app.protocol === 'file:') {
    if (target.protocol !== 'file:') return false;
    if ((target.host || '') !== (app.host || '')) return false;
    const a = filePathKey(app.pathname);
    const t = filePathKey(target.pathname);
    return a !== null && t !== null && a === t;
  }
  return false;
}
