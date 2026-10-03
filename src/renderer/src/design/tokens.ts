// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  // SRGB equivalents of the light-theme Nexus roles (tokens.css points the legacy names at var(--nx-*)).
  cream: {
    50: 0xfbfdfd,
    100: 0xf3f7f7,
    200: 0xe9eff0,
    300: 0xd5dadb
  },
  paper: {
    100: 0xfbfdfd,
    200: 0xe9eff0
  },
  ink: {
    900: 0x161e22,
    700: 0x40494d,
    500: 0x5a6266,
    300: 0x868e90,
    100: 0xd5dadb
  },
  accent: {
    coral: 0xb6322b,
    coralLight: 0xf3e5e4,
    mint: 0x14764a,
    mintLight: 0xdfede8,
    sky: 0x161e22,
    skyLight: 0xe0e2e3,
    lemon: 0x9b5f00,
    lemonLight: 0xefeadf,
    lilac: 0x161e22,
    lilacLight: 0xe0e2e3,
    peach: 0x161e22,
    peachLight: 0xe0e2e3
  },
  status: {
    idle: 0x868e90,
    thinking: 0x161e22,
    working: 0x9b5f00,
    blocked: 0xb6322b,
    success: 0x14764a,
    ghost: 0xd5dadb
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
  display: '"Instrument Sans Variable", "Segoe UI", system-ui, sans-serif',
  ui: '"Instrument Sans Variable", "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, Consolas, monospace'
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
