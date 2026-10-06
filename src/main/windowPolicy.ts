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
 * Permission REQUEST decision. Deny by default. While a mic feature is live
 * (Free Flow dictation or a realtime voice session) the microphone (`media`,
 * audio only; any request that includes video is refused) and
 * `speaker-selection` (setSinkId for the realtime output-device picker) are
 * granted.
 */
export function decidePermission(i: { permission: string; mediaTypes?: readonly string[]; micLive: boolean }): boolean {
  if (ALWAYS_ALLOWED.has(i.permission)) return true;
  if (i.permission === 'media') return i.micLive && audioOnly(i.mediaTypes);
  if (i.permission === 'speaker-selection') return i.micLive;
  return false;
}

/** Permission CHECK decision (synchronous queries such as
 *  `navigator.permissions`). Same table as the request handler. `mediaType` is
 *  Electron's check detail: `video` is refused; `audio`, an absent value and
 *  Chromium's `unknown` (it cannot tell) are allowed only while the mic is live. */
export function decidePermissionCheck(permission: string, micLive: boolean, mediaType?: string): boolean {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (permission === 'media') {
    if (!micLive) return false;
    return mediaType === undefined || mediaType === 'audio' || mediaType === 'unknown';
  }
  if (permission === 'speaker-selection') return micLive;
  return false;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** URLs that may leave the app for the OS default handler: https links, http
 *  links to this machine's loopback (local dev servers), and macOS System
 *  Settings deep links. URLs carrying a username or password are refused, and
 *  the host is matched on the PARSED hostname, so `http://localhost@evil.com`
 *  and `http://localhost.evil.com` are refused. `file:`, `javascript:`, custom
 *  schemes and UNC paths are refused. */
export function isAllowedExternalUrl(url: string): boolean {
  if (typeof url !== 'string' || !url) return false;
  if (/^x-apple\.systempreferences:/.test(url)) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return /^https:\/\//i.test(url) && !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK_HOSTS.has(u.hostname);
  return false;
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
