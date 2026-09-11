export interface Theme {
  title?: string;
  logo?: string;
  logoDark?: string;
  favicon?: string;
  primary?: string;
  accent?: string;
  font?: string;
  radius?: 'none' | 'sm' | 'md' | 'lg';
  density?: 'compact' | 'comfortable';
  mode?: 'light' | 'dark' | 'system';
  preset?: Preset;
  customCss?: string;
  loginHeadline?: string;
  loginDescription?: string;
}

export type Preset =
  | 'default'
  | 'graphite'
  | 'nocturne'
  | 'fjord'
  | 'phosphor'
  | 'paper'
  | 'contrast'
  | 'blossom'
  | 'cloud'
  | 'mint';

/** Presets in menu order: id, display name, and the color scheme it paints (null = follows the mode toggle). */
export const PRESETS: ReadonlyArray<readonly [Preset, string, 'light' | 'dark' | null]> = [
  ['default', '', null],
  ['graphite', 'Graphite', 'dark'],
  ['nocturne', 'Nocturne', 'dark'],
  ['fjord', 'Fjord', 'dark'],
  ['phosphor', 'Phosphor', 'dark'],
  ['contrast', 'Contrast', 'dark'],
  ['paper', 'Paper', 'light'],
  ['blossom', 'Blossom', 'light'],
  ['cloud', 'Cloud', 'light'],
  ['mint', 'Mint', 'light'],
];

export interface Boot {
  basePath: string;
  authEnabled: boolean;
  theme: Theme;
  /** The configured HTML page, if any – label for the button, url for the frame. */
  readme?: { label: string; url: string } | null;
  version?: string;
}

declare global {
  interface Window {
    __LUDIN__: Boot;
  }
}

export const boot: Boot = window.__LUDIN__;

/**
 * The operator's colour/font/radius overrides ride on top of the preset they
 * were configured with (`theme.preset`, or the default scheme). When a viewer
 * switches to another preset those overrides come off, so a brand colour never
 * lands on a palette it was not picked for.
 */
function applyBrandOverrides(on: boolean) {
  const t = boot.theme ?? {};
  const root = document.documentElement;
  const set = (name: string, value: string | undefined) => {
    if (on && value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  };
  set('--primary', t.primary);
  set('--accent', t.accent);
  set('--font', t.font);
  set('--radius', t.radius && { none: '0px', sm: '4px', md: '8px', lg: '14px' }[t.radius]);
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  applyBrandOverrides(true);
  root.dataset.density = t.density ?? 'comfortable';
  if (t.title) document.title = t.title;
  if (t.favicon) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = t.favicon;
    document.head.appendChild(link);
  }
  if (t.customCss) {
    const style = document.createElement('style');
    style.textContent = t.customCss;
    document.head.appendChild(style);
  }
}

export type Mode = 'light' | 'dark' | 'system';

export function getMode(): Mode {
  try {
    return (localStorage.getItem('ludin.mode') as Mode) || boot.theme.mode || 'system';
  } catch {
    return boot.theme.mode || 'system';
  }
}

export function setMode(mode: Mode) {
  try {
    localStorage.setItem('ludin.mode', mode);
  } catch {
    /* ignore */
  }
  applyMode(mode);
}

export function applyMode(mode: Mode) {
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
}

function isPreset(v: unknown): v is Preset {
  return PRESETS.some(([id]) => id === v);
}

/** The active preset: the viewer's saved pick → `theme.preset` from the config → default. */
export function getPreset(): Preset {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('ludin.preset');
  } catch {
    /* ignore */
  }
  if (isPreset(saved)) return saved;
  const configured = boot.theme?.preset;
  return isPreset(configured) ? configured : 'default';
}

export function setPreset(preset: Preset) {
  try {
    localStorage.setItem('ludin.preset', preset);
  } catch {
    /* ignore */
  }
  applyPreset(preset);
}

export function applyPreset(preset: Preset) {
  const root = document.documentElement;
  if (preset === 'default') delete root.dataset.preset;
  else root.dataset.preset = preset;
  const configured = isPreset(boot.theme?.preset) ? boot.theme.preset : 'default';
  applyBrandOverrides(preset === configured);
}

/** Whether the page is painting a dark scheme right now (preset first, then the mode toggle). */
export function isDark(): boolean {
  const scheme = PRESETS.find(([id]) => id === getPreset())?.[2];
  if (scheme) return scheme === 'dark';
  const mode = getMode();
  return mode === 'dark' || (mode === 'system' && !!matchMedia?.('(prefers-color-scheme: dark)').matches);
}
