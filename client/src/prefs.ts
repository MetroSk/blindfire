// Local, per-browser preferences and tutorial progress.

export interface Prefs {
  name: string;
  volume: number; // 0..1
  followShells: boolean;
  showGrid: boolean;
  reducedMotion: boolean;
  serverUrl: string; // empty = auto
  tutorialDone: boolean;
}

const KEY = 'blindfire.prefs.v1';

const defaults: Prefs = {
  name: '',
  volume: 0.6,
  followShells: true,
  showGrid: true,
  reducedMotion: false,
  serverUrl: '',
  tutorialDone: false,
};

let cache: Prefs | null = null;

export function getPrefs(): Prefs {
  if (cache) return cache;
  try {
    cache = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export function setPrefs(p: Partial<Prefs>) {
  cache = { ...getPrefs(), ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable */
  }
}

/** Where the multiplayer server lives. */
export function resolveServerUrl(): string {
  const p = getPrefs();
  if (p.serverUrl.trim()) return p.serverUrl.trim().replace(/\/$/, '');
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env.replace(/\/$/, '');
  if (location.port === '5173') return `${location.protocol}//${location.hostname}:3001`;
  if (location.hostname.endsWith('github.io')) return ''; // static hosting: no server unless configured
  return location.origin; // served by the game server itself
}
