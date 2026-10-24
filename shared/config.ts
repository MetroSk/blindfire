// All balance data lives here. Tweak numbers in this file only.

export const CELL = 24; // grid cell size in world pixels

export const WORLD = {
  width: 3600,
  height: 1100,
  gravity: 380, // px/s^2
  windAccel: 45, // px/s^2 at wind = 1.0
  baseGroundRow: 32,
  maxBuildHeight: 14, // rows above ground
};

// Build zones in grid columns (inclusive).
export const ZONES: [{ c0: number; c1: number }, { c0: number; c1: number }] = [
  { c0: 4, c1: 28 },
  { c0: 121, c1: 145 },
];

export type DamageType = 'blast' | 'pierce' | 'frag';
export type Resist = Record<DamageType, number>;

export type ItemId =
  | 'wood' | 'stone' | 'steel' | 'armor' | 'concrete' | 'foundation' | 'sandbag' | 'wedge'
  | 'core'
  | 'mortar' | 'hmortar' | 'cannon' | 'howitzer' | 'rocket'
  | 'aa' | 'radar' | 'decoy' | 'repair' | 'crate';

export type Category = 'blocks' | 'weapons' | 'defense' | 'utility';

export type WeaponId = 'mortar' | 'hmortar' | 'cannon' | 'howitzer' | 'rocket';
export type AmmoId = 'he' | 'ap' | 'frag' | 'smoke' | 'recon';

export interface ItemDef {
  id: ItemId;
  name: string;
  category: Category;
  cost: number;
  hp: number;
  desc: string;
  resist: Resist;
  /** Max horizontal cantilever distance from a vertically supported block. -1 = needs block/ground directly below. */
  span: number;
  /** Can other blocks rest on top of this one? */
  supportsAbove: boolean;
  groundOnly?: boolean;
  rotatable?: boolean;
  maxCount?: number;
  /** Requires an empty cell directly above to operate (barrel / antenna). */
  needsClearAbove?: boolean;
  color: string;
  weapon?: WeaponId;
}

const R = (blast: number, pierce: number, frag: number): Resist => ({ blast, pierce, frag });

export const ITEMS: Record<ItemId, ItemDef> = {
  wood: { id: 'wood', name: 'Wooden Block', category: 'blocks', cost: 10, hp: 40, span: 2, supportsAbove: true, resist: R(1.2, 1.0, 1.0), color: '#a0703c', desc: 'Cheap and light. Spans 2 cells sideways but burns through fast.' },
  stone: { id: 'stone', name: 'Stone Block', category: 'blocks', cost: 20, hp: 80, span: 1, supportsAbove: true, resist: R(0.9, 0.9, 0.6), color: '#8a8d91', desc: 'Solid all-rounder. Poor at overhangs (span 1).' },
  steel: { id: 'steel', name: 'Steel Block', category: 'blocks', cost: 35, hp: 115, span: 3, supportsAbove: true, resist: R(0.7, 0.8, 0.3), color: '#5d7a92', desc: 'Strong frame material. Best overhang span (3).' },
  foundation: { id: 'foundation', name: 'Foundation', category: 'blocks', cost: 15, hp: 100, span: 0, supportsAbove: true, groundOnly: true, resist: R(0.6, 0.8, 0.4), color: '#6b5d4f', desc: 'Ground level only. Anchored deep: stays supported even if the ground beneath is blasted away.' },
  armor: { id: 'armor', name: 'Reinforced Armor', category: 'defense', cost: 50, hp: 140, span: 1, supportsAbove: true, resist: R(0.45, 0.95, 0.2), color: '#3f4f3a', desc: 'Shrugs off high-explosive blasts. Armor-piercing rounds still punch through.' },
  concrete: { id: 'concrete', name: 'Concrete Bunker', category: 'defense', cost: 45, hp: 130, span: 1, supportsAbove: true, resist: R(0.4, 1.0, 0.3), color: '#b3ada0', desc: 'Superb blast protection. Heavy: only spans 1.' },
  sandbag: { id: 'sandbag', name: 'Sandbag Wall', category: 'defense', cost: 12, hp: 35, span: -1, supportsAbove: false, resist: R(0.8, 0.7, 0.15), color: '#c2a66b', desc: 'Nearly immune to fragments. Cannot support anything above it.' },
  wedge: { id: 'wedge', name: 'Sloped Armor', category: 'defense', cost: 30, hp: 90, span: 1, supportsAbove: true, rotatable: true, resist: R(0.75, 0.6, 0.4), color: '#556b5a', desc: 'Angled plate (rotate with R). Direct hits on its slope deal 40% less damage.' },
  core: { id: 'core', name: 'Command Core', category: 'utility', cost: 0, hp: 150, span: -1, supportsAbove: true, maxCount: 1, resist: R(0.8, 0.9, 0.8), color: '#e0b030', desc: 'REQUIRED. Your HQ. If it is destroyed you lose. Bury it well.' },
  mortar: { id: 'mortar', name: 'Light Mortar', category: 'weapons', cost: 100, hp: 60, span: -1, supportsAbove: false, needsClearAbove: true, weapon: 'mortar', resist: R(1, 1, 1.2), color: '#7d8b4e', desc: 'Cheap, high-arc indirect fire. Short range: build it forward.' },
  hmortar: { id: 'hmortar', name: 'Heavy Mortar', category: 'weapons', cost: 180, hp: 80, span: -1, supportsAbove: false, needsClearAbove: true, weapon: 'hmortar', resist: R(1, 1, 1.2), color: '#6a7a3c', desc: 'Huge blast radius for clustered targets. Uses 2 rounds, reloads slowly.' },
  cannon: { id: 'cannon', name: 'Field Cannon', category: 'weapons', cost: 150, hp: 70, span: -1, supportsAbove: false, needsClearAbove: true, weapon: 'cannon', resist: R(1, 1, 1.2), color: '#56706e', desc: 'Fast, flat and precise. Small blast. Accepts AP rounds.' },
  howitzer: { id: 'howitzer', name: 'Heavy Howitzer', category: 'weapons', cost: 250, hp: 90, span: -1, supportsAbove: false, needsClearAbove: true, weapon: 'howitzer', resist: R(1, 1, 1.2), color: '#4d5a40', desc: 'Long range, massive damage. Slow and hungry for ammo.' },
  rocket: { id: 'rocket', name: 'Rocket Launcher', category: 'weapons', cost: 200, hp: 65, span: -1, supportsAbove: false, needsClearAbove: true, weapon: 'rocket', resist: R(1, 1, 1.2), color: '#7a4a3a', desc: 'Fires a 3-rocket salvo. Boost-phase flight, wide spread, wind-sensitive.' },
  aa: { id: 'aa', name: 'Anti-Artillery Turret', category: 'defense', cost: 180, hp: 70, span: -1, supportsAbove: false, needsClearAbove: true, resist: R(1, 1, 1.1), color: '#5b6470', desc: 'May shoot down incoming shells passing within 230px (30%, rockets 45%).' },
  radar: { id: 'radar', name: 'Radar Station', category: 'utility', cost: 120, hp: 50, span: -1, supportsAbove: false, needsClearAbove: true, resist: R(1, 1, 1.2), color: '#4f7c8a', desc: 'Exact wind readings and estimated enemy launch sites when they fire.' },
  decoy: { id: 'decoy', name: 'Decoy', category: 'utility', cost: 40, hp: 30, span: -1, supportsAbove: false, resist: R(1.2, 1, 1.2), color: '#8a7f5a', desc: 'Fakes muzzle flashes for enemy radar and looks like artillery to recon.' },
  repair: { id: 'repair', name: 'Repair Station', category: 'utility', cost: 100, hp: 60, span: -1, supportsAbove: false, resist: R(1, 1, 1.1), color: '#4a8a5a', desc: 'Each of your turns, restores 15 HP to up to 3 damaged blocks within 3 cells.' },
  crate: { id: 'crate', name: 'Ammunition Crate', category: 'utility', cost: 50, hp: 40, span: -1, supportsAbove: false, resist: R(1.3, 1.2, 1.3), color: '#8c6d2e', desc: '+12 HE rounds (cheaper than buying). Explodes violently and loses its rounds if destroyed.' },
};

export const ITEM_ORDER: ItemId[] = [
  'wood', 'stone', 'steel', 'foundation',
  'armor', 'concrete', 'sandbag', 'wedge', 'aa',
  'mortar', 'hmortar', 'cannon', 'howitzer', 'rocket',
  'core', 'radar', 'decoy', 'repair', 'crate',
];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  angleMin: number;
  angleMax: number;
  speedMax: number;
  spreadDeg: number;
  powerJitter: number; // fraction
  damage: number;
  radius: number;
  reload: number; // own turns to skip after firing
  ammoUse: number; // rounds consumed per shot
  ammo: AmmoId[];
  projectiles: number;
  thrust?: number; // px/s^2 during boost
  thrustTime?: number;
  windFactor: number;
  includedHE: number;
  trail: string;
  role: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  mortar: { id: 'mortar', name: 'Light Mortar', angleMin: 45, angleMax: 85, speedMax: 960, spreadDeg: 0.9, powerJitter: 0.015, damage: 45, radius: 42, reload: 0, ammoUse: 1, ammo: ['he', 'frag', 'smoke', 'recon'], projectiles: 1, windFactor: 1, includedHE: 4, trail: '#e8d9a0', role: 'High arc, short range, cheap' },
  hmortar: { id: 'hmortar', name: 'Heavy Mortar', angleMin: 50, angleMax: 85, speedMax: 1080, spreadDeg: 1.0, powerJitter: 0.015, damage: 75, radius: 72, reload: 1, ammoUse: 2, ammo: ['he', 'frag', 'smoke'], projectiles: 1, windFactor: 1, includedHE: 6, trail: '#f0c070', role: 'Huge blast, slow reload' },
  cannon: { id: 'cannon', name: 'Field Cannon', angleMin: -5, angleMax: 40, speedMax: 1250, spreadDeg: 0.25, powerJitter: 0.005, damage: 55, radius: 30, reload: 0, ammoUse: 1, ammo: ['he', 'ap', 'frag'], projectiles: 1, windFactor: 0.6, includedHE: 4, trail: '#ffffff', role: 'Flat, precise, small blast' },
  howitzer: { id: 'howitzer', name: 'Heavy Howitzer', angleMin: 15, angleMax: 70, speedMax: 1300, spreadDeg: 0.5, powerJitter: 0.008, damage: 95, radius: 58, reload: 1, ammoUse: 2, ammo: ['he', 'ap', 'smoke', 'recon'], projectiles: 1, windFactor: 0.8, includedHE: 6, trail: '#ffb060', role: 'Long range, heavy damage' },
  rocket: { id: 'rocket', name: 'Rocket Launcher', angleMin: 25, angleMax: 65, speedMax: 700, spreadDeg: 2.2, powerJitter: 0.03, damage: 38, radius: 46, reload: 1, ammoUse: 3, ammo: ['he', 'frag'], projectiles: 3, thrust: 650, thrustTime: 0.6, windFactor: 1.6, includedHE: 6, trail: '#ff7040', role: '3-rocket salvo, boost flight' },
};

export interface AmmoDef {
  id: AmmoId;
  name: string;
  short: string;
  cost: number; // per round
  dmgMul: number;
  radiusMul: number;
  dmgType: DamageType;
  penetration: number; // blocks passed through before detonating
  craterMul: number;
  special?: 'smoke' | 'recon';
  desc: string;
}

export const AMMO: Record<AmmoId, AmmoDef> = {
  he: { id: 'he', name: 'High Explosive', short: 'HE', cost: 4, dmgMul: 1, radiusMul: 1, dmgType: 'blast', penetration: 0, craterMul: 1, desc: 'Standard blast round. Digs craters.' },
  ap: { id: 'ap', name: 'Armor-Piercing', short: 'AP', cost: 7, dmgMul: 1.5, radiusMul: 0.45, dmgType: 'pierce', penetration: 2, craterMul: 0.3, desc: 'Punches through up to 2 blocks before a small detonation.' },
  frag: { id: 'frag', name: 'Fragmentation', short: 'FRAG', cost: 5, dmgMul: 0.6, radiusMul: 1.7, dmgType: 'frag', penetration: 0, craterMul: 0.2, desc: 'Wide shrapnel burst. Shreds weapons and light blocks; useless vs armor.' },
  smoke: { id: 'smoke', name: 'Smoke', short: 'SMK', cost: 5, dmgMul: 0, radiusMul: 0, dmgType: 'blast', penetration: 0, craterMul: 0, special: 'smoke', desc: 'Screens an area for 2 rounds: enemy impacts inside cannot be observed and launches inside hide from radar.' },
  recon: { id: 'recon', name: 'Recon Flare', short: 'RCN', cost: 12, dmgMul: 0, radiusMul: 0, dmgType: 'blast', penetration: 0, craterMul: 0, special: 'recon', desc: 'Reveals enemy structures within 130px of impact (decoys look like guns).' },
};

export const AMMO_ORDER: AmmoId[] = ['he', 'ap', 'frag', 'smoke', 'recon'];

export const RULES = {
  smokeRadius: 170,
  smokeTurns: 4, // turn changes (= 2 rounds)
  reconRadius: 130,
  aaRadius: 230,
  aaChanceShell: 0.3,
  aaChanceRocket: 0.45,
  repairAmount: 15,
  repairTargets: 3,
  repairRange: 3,
  crateRounds: 12,
  crateBlastRadius: 60,
  crateBlastDamage: 60,
  fallDamagePerRow: 12,
  landDamagePerRow: 8,
  directHitBonus: 0.5,
  wedgeReduction: 0.4,
  integrityLoss: 0.35,
  radarErrorPx: 170,
  detectionLifetime: 3,
  maxShotTime: 14,
};

export type VictoryMode = 'core' | 'weapons' | 'integrity';
export type RevealMode = 'none' | 'hit' | 'area';

export interface MatchSettings {
  budget: number;
  victory: VictoryMode;
  revealOnHit: RevealMode;
  scouting: boolean; // radar + recon allowed
  wind: 0 | 1 | 2;
  shotsPerTurn: 1 | 2 | 3;
  turnTime: number; // seconds, 0 = unlimited (online only)
  repairs: boolean;
  openBases: boolean; // casual: bases fully visible
  maxTurns: number;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  budget: 1000,
  victory: 'core',
  revealOnHit: 'hit',
  scouting: true,
  wind: 1,
  shotsPerTurn: 1,
  turnTime: 60,
  repairs: true,
  openBases: false,
  maxTurns: 80,
};

export function sanitizeSettings(s: Partial<MatchSettings> | undefined): MatchSettings {
  const d = DEFAULT_SETTINGS;
  const x = { ...d, ...(s || {}) };
  const num = (v: unknown, lo: number, hi: number, def: number) =>
    typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : def;
  return {
    budget: num(x.budget, 300, 5000, d.budget),
    victory: (['core', 'weapons', 'integrity'] as const).includes(x.victory) ? x.victory : d.victory,
    revealOnHit: (['none', 'hit', 'area'] as const).includes(x.revealOnHit) ? x.revealOnHit : d.revealOnHit,
    scouting: !!x.scouting,
    wind: ([0, 1, 2] as const).includes(x.wind) ? x.wind : d.wind,
    shotsPerTurn: ([1, 2, 3] as const).includes(x.shotsPerTurn) ? x.shotsPerTurn : d.shotsPerTurn,
    turnTime: num(x.turnTime, 0, 600, d.turnTime),
    repairs: !!x.repairs,
    openBases: !!x.openBases,
    maxTurns: num(x.maxTurns, 10, 400, d.maxTurns),
  };
}
