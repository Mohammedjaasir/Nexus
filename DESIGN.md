# Design — interim neutral foundation

The previous visual identity (warm "cream paper", pixel display font, hard offset
shadows, stepped motion) has been retired. What remains is a deliberately neutral
foundation that keeps every existing screen working until the new visual system
is defined.

## Where things live

- `src/renderer/src/design/tokens.css` holds all colour, type, spacing and elevation tokens, plus the dark theme.
- `src/renderer/src/design/tokens.ts` mirrors the colour values for the Pixi canvas. Update both together.
- `src/renderer/src/design/global.css` holds the reset, focus ring, scrollbars, keyframes and markdown preview styles.
- `src/renderer/src/design/theme.ts` handles the light/dark switch (`data-cth-theme` on `<html>`).

## Rules while this is interim

- **Token names are legacy.** `--cth-cream-*`, `--cth-paper-*` and `--cth-ink-*` describe the old palette, not the current values. The mapping to roles (surface, text, border) is documented at the top of `tokens.css`. Do not add new tokens to the legacy set. The new system will introduce a semantic layer.
- **Contrast floors** apply in both themes:
  - body text: 4.5:1 or better
  - structural borders (`ink-300`): 3.0:1 or better
  - text on a full accent fill (`--cth-on-accent`): 4.5:1 or better
- **No new pixel-art styling.** The office floor (`scene/office/*`) is an isolated legacy view and keeps its sprite art until it is replaced.
- **The legacy label shim** at the end of `global.css` lifts old 7–10px display labels to 11px. Delete it once nothing uses `--cth-font-display`.
- **Fonts:** Inter (UI) and JetBrains Mono (code and terminals).
- **Motion:** 120–200ms ease. Honour `prefers-reduced-motion`; `global.css` already zeroes durations.
