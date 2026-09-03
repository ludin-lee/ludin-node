export interface Theme {
  title?: string;
  logo?: string;
  favicon?: string;
  primary?: string;
  accent?: string;
  font?: string;
  radius?: 'none' | 'sm' | 'md' | 'lg';
  density?: 'compact' | 'comfortable';
  mode?: 'light' | 'dark' | 'system';
  customCss?: string;
  loginHeadline?: string;
  loginDescription?: string;
}

export interface Boot {
  basePath: string;
  authEnabled: boolean;
  theme: Theme;
  readonly: boolean;
  capabilities?: {
    users: boolean;
    invites: boolean;
    ipRules: boolean;
    sessions: boolean;
    auditQuery: boolean;
  };
  version?: string;
}

declare global {
  interface Window {
    __LUDIN__: Boot;
  }
}

export const boot: Boot = window.__LUDIN__;

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t.primary) root.style.setProperty('--primary', t.primary);
  if (t.accent) root.style.setProperty('--accent', t.accent);
  if (t.font) root.style.setProperty('--font', t.font);
  const radius = { none: '0px', sm: '4px', md: '8px', lg: '14px' }[t.radius ?? 'md'];
  root.style.setProperty('--radius', radius);
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
