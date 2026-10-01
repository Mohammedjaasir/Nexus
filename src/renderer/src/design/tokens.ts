// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  // Interim neutral values (see tokens.css for the legacy-name mapping).
  cream: {
    50: 0xffffff,
    100: 0xf6f6f7,
    200: 0xececee,
    300: 0xe0e0e3
  },
  paper: {
    100: 0xffffff,
    200: 0xf3f3f5
  },
  ink: {
    900: 0x18181b,
    700: 0x3f3f46,
    500: 0x5f5f68,
    300: 0x82828b,
    100: 0xdcdce0
  },
  accent: {
    coral: 0xc8423e,
    coralLight: 0xf8e1e0,
    mint: 0x2a7f4e,
    mintLight: 0xddefe3,
    sky: 0x2d72b0,
    skyLight: 0xdce8f4,
    lemon: 0x8f6305,
    lemonLight: 0xf5ead0,
    lilac: 0x6e5cc0,
    lilacLight: 0xe7e3f5,
    peach: 0xb05a22,
    peachLight: 0xf6e3d5
  },
  status: {
    idle: 0x9a9aa2,
    thinking: 0x2d72b0,
    working: 0x8f6305,
    blocked: 0xc8423e,
    success: 0x2a7f4e,
    ghost: 0xd4d4d9
  },
  // Legacy office-floor scene colours (the floor is an isolated legacy view).
  world: {
    grassLight: 0xd4eab0,
    grassDark: 0xb5d589,
    woodLight: 0xe5c896,
    woodDark: 0xc9a66b,
    path: 0xe8d8b0,
    wall: 0x8b6f47
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

export const type = {
  // No separate display face any more; kept as a name for existing callers.
  display: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  ui: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
} as const;

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
