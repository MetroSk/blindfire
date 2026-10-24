import type { AmmoId, ItemId, MatchSettings, DamageType } from './config';

export type Seat = 0 | 1;

export interface Block {
  id: number;
  owner: Seat;
  item: ItemId;
  c: number;
  r: number;
  hp: number;
  maxHp: number;
  rot: 0 | 1 | 2 | 3;
  cooldown: number; // weapons: own turns until ready
}

export interface Stats {
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  damageTaken: number;
  structuresDestroyed: number;
  structuresLost: number;
  pointsSpent: number;
  ammoUsed: number;
  /** Point value of enemy hardware destroyed (partial damage counts proportionally). */
  score: number;
}

export type KnownKind = 'structure' | 'weapon' | 'core' | 'destroyed';

export interface KnownCell {
  c: number;
  r: number;
  kind: KnownKind;
  turn: number;
}

export interface Detection {
  x: number;
  y: number;
  turn: number;
}

export interface Smoke {
  x: number;
  y: number;
  r: number;
  owner: Seat;
  ttl: number;
}

export type ImpactKind = 'terrain' | 'structure' | 'intercepted' | 'lost' | 'obscured';

export interface ShotRecord {
  turn: number;
  weaponItem: ItemId;
  weaponId: number;
  ammo: AmmoId;
  angle: number;
  power: number;
  launch: { x: number; y: number };
  ends: { x: number; y: number; kind: ImpactKind }[];
  wind: number;
  hit: boolean;
}

export interface IncomingObs {
  turn: number;
  points: [number, number][];
}

export interface LogEntry {
  turn: number;
  text: string;
  kind: 'info' | 'good' | 'bad' | 'warn' | 'enemy';
  to: Seat | 'all';
}

export interface PlayerState {
  name: string;
  blocks: Block[];
  ammo: Record<AmmoId, number>;
  boughtAmmo: Record<AmmoId, number>;
  ready: boolean;
  stats: Stats;
  known: Record<string, KnownCell>;
  detections: Detection[];
  history: ShotRecord[];
  incoming: IncomingObs[];
  initialHp: number;
}

export type Phase = 'build' | 'combat' | 'over';

export interface MatchState {
  seed: number;
  rng: number;
  settings: MatchSettings;
  phase: Phase;
  turn: number;
  active: Seat;
  shotsThisTurn: number;
  firedThisTurn: number[];
  terrain: number[];
  wind: number;
  smoke: Smoke[];
  players: [PlayerState, PlayerState];
  winner: Seat | 'draw' | null;
  winReason: string;
  log: LogEntry[];
  nextId: number;
  turnStartedAt: number;
}

// ---- Actions ----
export type PlayerAction =
  | { t: 'place'; item: ItemId; c: number; r: number; rot?: number }
  | { t: 'remove'; c: number; r: number }
  | { t: 'ammo'; ammo: AmmoId; delta: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'fire'; weaponId: number; ammo: AmmoId; angle: number; power: number }
  | { t: 'endTurn' };

export interface ActionResult {
  ok: boolean;
  error?: string;
  shot?: ShotOutcome;
}

// ---- Shot outcome (authoritative, never sent raw) ----
export interface ProjectileResult {
  points: [number, number][];
  end: { x: number; y: number; kind: ImpactKind };
  explosion: { x: number; y: number; r: number; type: DamageType | 'smoke' | 'recon' | 'intercept' } | null;
}

export interface DamageEvent {
  owner: Seat;
  blockId: number;
  item: ItemId;
  c: number;
  r: number;
  amount: number;
  destroyed: boolean;
}

export interface FallEvent {
  owner: Seat;
  blockId: number;
  item: ItemId;
  c: number;
  fromR: number;
  toR: number;
  destroyed: boolean;
}

export interface ShotOutcome {
  shooter: Seat;
  weaponItem: ItemId;
  ammo: AmmoId;
  launch: { x: number; y: number };
  projectiles: ProjectileResult[];
  damage: DamageEvent[];
  falls: FallEvent[];
  secondary: { x: number; y: number; r: number }[];
  craters: { x: number; r: number }[];
  smoke: Smoke | null;
  revealed: KnownCell[];
}

// ---- Filtered, per-viewer report sent to clients ----
export interface ShotReport {
  shooter: Seat;
  viewer: Seat;
  weaponItem: ItemId | null;
  ammo: AmmoId | null;
  launch: { x: number; y: number } | null;
  projectiles: ProjectileResult[];
  damage: DamageEvent[]; // only blocks the viewer may know about
  falls: FallEvent[];
  secondary: { x: number; y: number; r: number }[];
  craters: { x: number; r: number }[];
  smoke: Smoke | null;
  messages: string[];
}

export interface PlayerView {
  you: Seat;
  phase: Phase;
  turn: number;
  active: Seat;
  settings: MatchSettings;
  terrain: number[];
  wind: number; // exact if you have radar, otherwise rounded estimate
  windExact: boolean;
  smoke: Smoke[];
  shotsThisTurn: number;
  firedThisTurn: number[];
  own: {
    name: string;
    blocks: Block[];
    ammo: Record<AmmoId, number>;
    boughtAmmo: Record<AmmoId, number>;
    spent: number;
    ready: boolean;
    stats: Stats;
    history: ShotRecord[];
    incoming: IncomingObs[];
    integrity: number;
  };
  enemy: {
    name: string;
    ready: boolean;
    known: KnownCell[];
    detections: Detection[];
    stats: Stats | null; // revealed at match end
    blocks: Block[] | null; // only when match is over or openBases
  };
  log: LogEntry[];
  winner: Seat | 'draw' | null;
  winReason: string;
  turnStartedAt: number;
}

export type Difficulty = 'easy' | 'medium' | 'hard';
