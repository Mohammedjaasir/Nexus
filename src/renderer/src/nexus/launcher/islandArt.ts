/** Optional launcher art. Drop `launcher-islands.webp` (or .png/.jpg) into
 *  nexus/assets/ and it is picked up at build time; absent → null and the CSS
 *  placeholder renders. No import of a missing file can break the build. */
const found = import.meta.glob('../assets/launcher-islands.{webp,png,jpg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const ISLAND_ART_URL: string | null = Object.values(found)[0] ?? null;
