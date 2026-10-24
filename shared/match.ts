import {
  AMMO, AMMO_ORDER, CELL, ITEMS, RULES, WEAPONS, WORLD,
  sanitizeSettings, type AmmoId, type DamageType, type ItemId, type MatchSettings,
} from './config';
import { Rng } from './rng';
import { applyCrater, generateTerrain } from './terrain';
import { simulate, speedFor } from './ballistics';
import { buildGrid, key, resolveCollapse } from './structure';
import { placementError, removalError } from './construction';
import { blastFalloff, blocksInBlast, damageBlock, hitsWedgeFace } from './damage';
import type {
  ActionResult, Block, DamageEvent, FallEvent, KnownKind, MatchState, PlayerAction,
  PlayerState, PlayerView, ProjectileResult, Seat, ShotOutcome, ShotReport, Stats,
} from './types';

const emptyAmmo = (): Record<AmmoId, number> => ({ he: 0, ap: 0, frag: 0, smoke: 0, recon: 0 });
const emptyStats = (): Stats => ({
  shotsFired: 0, shotsHit: 0, damageDealt: 0, damageTaken: 0,
  structuresDestroyed: 0, structuresLost: 0, pointsSpent: 0, ammoUsed: 0, score: 0,
});

/** Score value of an item for tie-breaks: its cost, the core counts as 300. */
const scoreValue = (item: ItemId) => (item === 'core' ? 300 : ITEMS[item].cost);

function newPlayer(name: string): PlayerState {
  return {
    name, blocks: [], ammo: emptyAmmo(), boughtAmmo: emptyAmmo(), ready: false, stats: emptyStats(),
    known: {}, detections: [], history: [], incoming: [], initialHp: 0,
  };
}

export const other = (s: Seat): Seat => (s === 0 ? 1 : 0);
export const isWeapon = (item: ItemId) => !!ITEMS[item].weapon;
export const facing = (s: Seat): 1 | -1 => (s === 0 ? 1 : -1);
export const halfOf = (x: number): Seat => (x < WORLD.width / 2 ? 0 : 1);

export function muzzleOf(b: Block): { x: number; y: number } {
  return { x: b.c * CELL + CELL / 2, y: b.r * CELL - 2 };
}

export class Match {
  state: MatchState;
  grid: Map<number, Block>;
  private rng: Rng;
  now: () => number;

  constructor(state: MatchState, now: () => number = () => Date.now()) {
    this.state = state;
    this.rng = new Rng(state.rng);
    this.now = now;
    this.grid = buildGrid([...state.players[0].blocks, ...state.players[1].blocks]);
  }

  static create(settings: Partial<MatchSettings>, seed: number, names: [string, string] = ['Player 1', 'Player 2']): Match {
    const rng = new Rng(seed);
    const terrain = generateTerrain(rng);
    const s = sanitizeSettings(settings);
    const state: MatchState = {
      seed, rng: rng.state, settings: s, phase: 'build', turn: 0, active: 0, shotsThisTurn: 0, firedThisTurn: [],
      terrain, wind: 0, smoke: [], players: [newPlayer(names[0]), newPlayer(names[1])],
      winner: null, winReason: '', log: [], nextId: 1, turnStartedAt: 0,
    };
    const m = new Match(state);
    m.state.wind = m.rollWind();
    m.sync();
    return m;
  }

  private sync() {
    this.state.rng = this.rng.state;
  }

  private log(text: string, kind: MatchState['log'][number]['kind'], to: Seat | 'all' = 'all') {
    this.state.log.push({ turn: this.state.turn, text, kind, to });
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400);
  }

  private rollWind(): number {
    const k = this.state.settings.wind;
    if (k === 0) return 0;
    return Math.round(this.rng.range(-0.8, 0.8) * k * 100) / 100;
  }

  // ------------------------------------------------------------------ economy
  spent(seat: Seat): number {
    const p = this.state.players[seat];
    let s = 0;
    for (const b of p.blocks) s += ITEMS[b.item].cost;
    for (const a of AMMO_ORDER) s += p.boughtAmmo[a] * AMMO[a].cost;
    return s;
  }

  remaining(seat: Seat): number {
    return this.state.settings.budget - this.spent(seat);
  }

  private recomputeBuildAmmo(seat: Seat) {
    const p = this.state.players[seat];
    const a = { ...p.boughtAmmo };
    for (const b of p.blocks) {
      const w = ITEMS[b.item].weapon;
      if (w) a.he += WEAPONS[w].includedHE;
      if (b.item === 'crate') a.he += RULES.crateRounds;
    }
    p.ammo = a;
  }

  // ------------------------------------------------------------- construction
  canPlace(seat: Seat, item: ItemId, c: number, r: number): string | null {
    const st = this.state;
    if (st.phase !== 'build') return 'Construction is closed';
    const p = st.players[seat];
    if (p.ready) return 'You already finished building';
    if (!ITEMS[item]) return 'Unknown item';
    return placementError(
      { seat, terrain: st.terrain, settings: st.settings, grid: this.grid, ownBlocks: p.blocks, remaining: this.remaining(seat) },
      item, c, r,
    );
  }

  place(seat: Seat, item: ItemId, c: number, r: number, rot = 0): string | null {
    const err = this.canPlace(seat, item, c, r);
    if (err) return err;
    const def = ITEMS[item];
    const b: Block = {
      id: this.state.nextId++, owner: seat, item, c, r, hp: def.hp, maxHp: def.hp,
      rot: (def.rotatable ? ((rot | 0) & 3) : 0) as Block['rot'], cooldown: 0,
    };
    this.state.players[seat].blocks.push(b);
    this.grid.set(key(c, r), b);
    this.recomputeBuildAmmo(seat);
    return null;
  }

  remove(seat: Seat, c: number, r: number): string | null {
    const st = this.state;
    if (st.phase !== 'build') return 'Construction is closed';
    const p = st.players[seat];
    if (p.ready) return 'You already finished building';
    const b = this.grid.get(key(c, r));
    if (!b || b.owner !== seat) return 'Nothing of yours here';
    const err = removalError(this.grid, st.terrain, p.blocks, c, r);
    if (err) return err;
    this.grid.delete(key(c, r));
    p.blocks = p.blocks.filter((o) => o !== b);
    this.recomputeBuildAmmo(seat);
    return null;
  }

  buyAmmo(seat: Seat, ammo: AmmoId, delta: number): string | null {
    const st = this.state;
    if (st.phase !== 'build') return 'Construction is closed';
    const p = st.players[seat];
    if (p.ready) return 'You already finished building';
    if (!AMMO[ammo]) return 'Unknown ammo';
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 50) return 'Invalid amount';
    if (!st.settings.scouting && ammo === 'recon') return 'Scouting is disabled in this match';
    if (p.boughtAmmo[ammo] + delta < 0) return 'Nothing to refund';
    if (delta > 0 && delta * AMMO[ammo].cost > this.remaining(seat)) return 'Not enough points';
    p.boughtAmmo[ammo] += delta;
    this.recomputeBuildAmmo(seat);
    return null;
  }

  readyError(seat: Seat): string | null {
    const p = this.state.players[seat];
    if (!p.blocks.some((b) => b.item === 'core')) return 'Place your Command Core first';
    if (!p.blocks.some((b) => isWeapon(b.item))) return 'Build at least one weapon';
    return null;
  }

  setReady(seat: Seat, ready: boolean): string | null {
    const st = this.state;
    if (st.phase !== 'build') return 'Construction is closed';
    if (ready) {
      const e = this.readyError(seat);
      if (e) return e;
    }
    st.players[seat].ready = ready;
    if (st.players[0].ready && st.players[1].ready) this.startCombat();
    return null;
  }

  private startCombat() {
    const st = this.state;
    st.phase = 'combat';
    for (const s of [0, 1] as Seat[]) {
      const p = st.players[s];
      this.recomputeBuildAmmo(s);
      p.stats.pointsSpent = this.spent(s);
      p.initialHp = p.blocks.reduce((a, b) => a + b.maxHp, 0);
    }
    st.active = this.rng.chance(0.5) ? 0 : 1;
    st.turn = 1;
    this.log('Construction complete. Battle begins!', 'info');
    this.beginTurn();
    this.sync();
  }

  // ------------------------------------------------------------------- combat
  integrity(seat: Seat): number {
    const p = this.state.players[seat];
    if (!p.initialHp) return 1;
    return p.blocks.reduce((a, b) => a + Math.max(0, b.hp), 0) / p.initialHp;
  }

  operational(seat: Seat, item?: ItemId): Block[] {
    return this.state.players[seat].blocks.filter((b) => b.hp > 0 && (item ? b.item === item : true));
  }

  /** Weapons that could fire right now for `seat` (ignores whose turn it is). */
  fireableWeapons(seat: Seat): Block[] {
    const p = this.state.players[seat];
    return p.blocks.filter((b) => {
      const w = ITEMS[b.item].weapon;
      if (!w || b.hp <= 0 || b.cooldown > 0) return false;
      if (this.state.firedThisTurn.includes(b.id)) return false;
      if (this.grid.get(key(b.c, b.r - 1))) return false;
      const W = WEAPONS[w];
      return W.ammo.some((a) => p.ammo[a] >= W.ammoUse && (a !== 'recon' || this.state.settings.scouting));
    });
  }

  private hasRadar(seat: Seat) {
    return this.state.settings.scouting && this.operational(seat, 'radar').length > 0;
  }

  private beginTurn() {
    const st = this.state;
    const s = st.active;
    const p = st.players[s];
    st.shotsThisTurn = 0;
    st.firedThisTurn = [];
    st.turnStartedAt = this.now();
    for (const b of p.blocks) if (b.cooldown > 0) b.cooldown--;
    // smoke drifts away
    st.smoke = st.smoke.map((sm) => ({ ...sm, ttl: sm.ttl - 1 })).filter((sm) => sm.ttl > 0);
    // detections fade
    for (const pl of st.players) pl.detections = pl.detections.filter((d) => st.turn - d.turn <= RULES.detectionLifetime * 2);
    // wind shift
    if (st.settings.wind > 0) {
      const k = st.settings.wind;
      let w = st.wind + this.rng.range(-0.18, 0.18) * k;
      if (this.rng.chance(0.08)) w = this.rollWind();
      st.wind = Math.round(Math.max(-1.2 * k, Math.min(1.2 * k, w)) * 100) / 100;
    }
    // repairs
    if (st.settings.repairs) {
      let repaired = 0;
      for (const rs of this.operational(s, 'repair')) {
        const targets = p.blocks
          .filter((b) => b.hp > 0 && b.hp < b.maxHp && Math.max(Math.abs(b.c - rs.c), Math.abs(b.r - rs.r)) <= RULES.repairRange)
          .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)
          .slice(0, RULES.repairTargets);
        for (const t of targets) {
          t.hp = Math.min(t.maxHp, t.hp + RULES.repairAmount);
          repaired++;
        }
      }
      if (repaired) this.log(`Repair crews patched ${repaired} block${repaired > 1 ? 's' : ''}.`, 'good', s);
    }
    if (st.turn > st.settings.maxTurns) {
      this.finishByScore('Turn limit reached');
      return;
    }
    if (this.fireableWeapons(s).length === 0) {
      const o = other(s);
      const canOther = this.state.players[o].blocks.some((b) => isWeapon(b.item) && b.hp > 0) &&
        this.hasAnyAmmoFor(o);
      if (!canOther && !this.anyFutureFire(s)) {
        this.finishByScore('Both sides are out of firepower');
        return;
      }
      this.log(`${p.name} has no weapon ready and passes.`, 'warn');
      this.passTurn(true);
    }
  }

  private hasAnyAmmoFor(seat: Seat): boolean {
    const p = this.state.players[seat];
    return p.blocks.some((b) => {
      const w = ITEMS[b.item].weapon;
      return w && b.hp > 0 && WEAPONS[w].ammo.some((a) => p.ammo[a] >= WEAPONS[w].ammoUse);
    });
  }

  /** Could this seat fire on a later turn (weapons merely reloading or blocked)? */
  private anyFutureFire(seat: Seat): boolean {
    return this.hasAnyAmmoFor(seat);
  }

  private passCount = 0; // consecutive forced passes (nobody able to fire)
  private passTurn(forced = false) {
    const st = this.state;
    if (st.phase !== 'combat') return;
    this.passCount = forced ? this.passCount + 1 : 0;
    if (this.passCount > 6) {
      this.passCount = 0;
      this.finishByScore('Stalemate');
      return;
    }
    st.active = other(st.active);
    st.turn++;
    this.beginTurn();
  }

  endTurn(seat: Seat): string | null {
    const st = this.state;
    if (st.phase !== 'combat') return 'Not in combat';
    if (st.active !== seat) return 'Not your turn';
    this.passTurn();
    this.sync();
    return null;
  }

  /** Called by the server when a turn timer runs out. */
  timeoutTurn() {
    const st = this.state;
    if (st.phase !== 'combat') return;
    this.log(`${st.players[st.active].name} ran out of time.`, 'warn');
    this.passTurn();
    this.sync();
  }

  forfeit(seat: Seat, reason: string) {
    const st = this.state;
    if (st.phase === 'over') return;
    st.phase = 'over';
    st.winner = other(seat);
    st.winReason = reason;
    this.log(`${st.players[other(seat)].name} wins: ${reason}`, 'info');
  }

  private finishByScore(reason: string) {
    const st = this.state;
    const s0 = st.players[0].stats.score;
    const s1 = st.players[1].stats.score;
    st.phase = 'over';
    if (s0 === s1) {
      const a = this.integrity(0);
      const b = this.integrity(1);
      st.winner = Math.abs(a - b) < 0.005 ? 'draw' : a > b ? 0 : 1;
      st.winReason = `${reason} - decided by base integrity`;
    } else {
      st.winner = s0 > s1 ? 0 : 1;
      st.winReason = `${reason} - decided by value destroyed (${Math.max(s0, s1)} vs ${Math.min(s0, s1)})`;
    }
    this.log(st.winReason, 'info');
  }

  fire(seat: Seat, weaponId: number, ammo: AmmoId, angle: number, power: number): { error?: string; shot?: ShotOutcome } {
    const st = this.state;
    if (st.phase !== 'combat') return { error: 'Not in combat' };
    if (st.active !== seat) return { error: 'Not your turn' };
    if (st.shotsThisTurn >= st.settings.shotsPerTurn) return { error: 'No shots left this turn' };
    const p = st.players[seat];
    const wb = p.blocks.find((b) => b.id === weaponId);
    if (!wb || !ITEMS[wb.item].weapon) return { error: 'You do not own that weapon' };
    if (wb.hp <= 0) return { error: 'Weapon destroyed' };
    if (wb.cooldown > 0) return { error: `Reloading (${wb.cooldown} turn${wb.cooldown > 1 ? 's' : ''})` };
    if (st.firedThisTurn.includes(wb.id)) return { error: 'Weapon already fired this turn' };
    if (this.grid.get(key(wb.c, wb.r - 1))) return { error: 'Barrel obstructed' };
    const W = WEAPONS[ITEMS[wb.item].weapon!];
    if (!AMMO[ammo] || !W.ammo.includes(ammo)) return { error: `${W.name} cannot fire ${AMMO[ammo]?.name ?? ammo}` };
    if (ammo === 'recon' && !st.settings.scouting) return { error: 'Scouting disabled' };
    if (p.ammo[ammo] < W.ammoUse) return { error: `Need ${W.ammoUse} ${AMMO[ammo].short} round(s)` };
    if (typeof angle !== 'number' || !isFinite(angle) || angle < W.angleMin || angle > W.angleMax)
      return { error: `Angle must be ${W.angleMin}-${W.angleMax}°` };
    if (typeof power !== 'number' || !isFinite(power) || power < 1 || power > 100) return { error: 'Power must be 1-100' };

    const shot = this.resolveShot(seat, wb, ammo, angle, power);
    p.ammo[ammo] -= W.ammoUse;
    p.stats.ammoUsed += W.ammoUse;
    wb.cooldown = W.reload + 1;
    st.shotsThisTurn++;
    st.firedThisTurn.push(wb.id);
    this.passCount = 0;
    this.checkVictory(seat);
    if (st.phase === 'combat' && (st.shotsThisTurn >= st.settings.shotsPerTurn || this.fireableWeapons(seat).length === 0)) {
      this.passTurn();
    }
    this.sync();
    return { shot };
  }

  private resolveShot(seat: Seat, wb: Block, ammo: AmmoId, angle: number, power: number): ShotOutcome {
    const st = this.state;
    const W = WEAPONS[ITEMS[wb.item].weapon!];
    const A = AMMO[ammo];
    const enemy = other(seat);
    const shooter = st.players[seat];
    const target = st.players[enemy];
    const launch = muzzleOf(wb);
    const outcome: ShotOutcome = {
      shooter: seat, weaponItem: wb.item, ammo, launch, projectiles: [], damage: [], falls: [],
      secondary: [], craters: [], smoke: null, revealed: [],
    };
    const dmgMap = new Map<number, DamageEvent>();
    const addDmg = (b: Block, raw: number, type: DamageType) => {
      const dealt = damageBlock(b, raw, type);
      if (dealt <= 0) return;
      const ev = dmgMap.get(b.id) ?? { owner: b.owner, blockId: b.id, item: b.item, c: b.c, r: b.r, amount: 0, destroyed: false };
      ev.amount = Math.round((ev.amount + dealt) * 10) / 10;
      ev.destroyed = b.hp <= 0;
      dmgMap.set(b.id, ev);
    };
    const pendingBlasts: { x: number; y: number; r: number; d: number; type: DamageType }[] = [];
    const world = {
      terrain: st.terrain,
      solidAt: (c: number, r: number) => {
        const b = this.grid.get(key(c, r));
        return b && b.hp > 0 ? b.id : null;
      },
    };
    const turrets = this.operational(enemy, 'aa');
    const salvo = W.projectiles;
    let anyHit = false;

    for (let i = 0; i < salvo; i++) {
      const offset = salvo > 1 ? (i - (salvo - 1) / 2) * 1.6 : 0;
      const a = angle + offset + this.rng.gauss() * W.spreadDeg;
      const sp = speedFor(W.id, power) * (1 + this.rng.gauss() * W.powerJitter);
      const rolled = new Set<number>();
      let pen = A.penetration;
      const pierced: number[] = [];
      const sim = simulate(
        { x: launch.x, y: launch.y, angleDeg: a, speed: sp, dir: facing(seat), wind: st.wind, weapon: W.id },
        world,
        {
          intercept: (x, y, _vx, vy) => {
            if (vy <= 0 || halfOf(x) !== enemy) return false;
            for (const t of turrets) {
              if (rolled.has(t.id)) continue;
              const m = muzzleOf(t);
              if (Math.hypot(m.x - x, m.y - y) < RULES.aaRadius) {
                rolled.add(t.id);
                if (this.rng.chance(salvo > 1 ? RULES.aaChanceRocket : RULES.aaChanceShell)) return true;
              }
            }
            return false;
          },
          onBlock: (id) => {
            if (pen > 0) {
              pen--;
              pierced.push(id);
              return true;
            }
            return false;
          },
        },
      );
      const proj: ProjectileResult = { points: sim.points, end: { x: sim.end.x, y: sim.end.y, kind: sim.end.kind }, explosion: null };
      outcome.projectiles.push(proj);
      const ex = sim.end.x;
      const ey = sim.end.y;
      // AP pass-through damage
      const blockById = (id: number) => [...this.grid.values()].find((b) => b.id === id);
      pierced.forEach((id, k) => {
        const b = blockById(id);
        if (b) addDmg(b, W.damage * A.dmgMul * (k === 0 ? 1 : 0.7), 'pierce');
      });
      if (sim.end.kind === 'intercepted') {
        proj.explosion = { x: ex, y: ey, r: 22, type: 'intercept' };
        continue;
      }
      if (sim.end.kind === 'lost') continue;
      if (A.special === 'smoke') {
        proj.explosion = { x: ex, y: ey, r: RULES.smokeRadius, type: 'smoke' };
        const sm = { x: ex, y: ey, r: RULES.smokeRadius, owner: seat, ttl: RULES.smokeTurns };
        st.smoke.push(sm);
        outcome.smoke = sm;
        continue;
      }
      if (A.special === 'recon') {
        proj.explosion = { x: ex, y: ey, r: RULES.reconRadius, type: 'recon' };
        for (const b of target.blocks) {
          if (b.hp <= 0) continue;
          const cx = b.c * CELL + CELL / 2;
          const cy = b.r * CELL + CELL / 2;
          if (Math.hypot(cx - ex, cy - ey) <= RULES.reconRadius) {
            const kind: KnownKind = b.item === 'core' ? 'core' : isWeapon(b.item) || b.item === 'decoy' ? 'weapon' : 'structure';
            outcome.revealed.push({ c: b.c, r: b.r, kind, turn: st.turn });
          }
        }
        continue;
      }
      const R = W.radius * A.radiusMul;
      const D = W.damage * A.dmgMul;
      proj.explosion = { x: ex, y: ey, r: R, type: A.dmgType };
      // direct hit bonus on the struck block
      if (sim.end.kind === 'structure') {
        const hitBlock = sim.end.blockId !== undefined ? blockById(sim.end.blockId) : undefined;
        if (hitBlock) {
          let bonus = D * RULES.directHitBonus;
          if (hitBlock.item === 'wedge') {
            const pts = sim.points;
            const [x1, y1] = pts[Math.max(0, pts.length - 2)];
            if (hitsWedgeFace(hitBlock.rot, ex - x1, ey - y1)) bonus *= 1 - RULES.wedgeReduction;
          }
          addDmg(hitBlock, bonus, A.dmgType);
        }
      }
      pendingBlasts.push({ x: ex, y: ey, r: R, d: D, type: A.dmgType });
      if (A.craterMul > 0 && (sim.end.kind === 'terrain' || sim.end.kind === 'structure')) {
        outcome.craters.push({ x: Math.round(ex), r: Math.round(R * 0.55 * A.craterMul) });
      }
    }

    // resolve blasts, cascading crate explosions
    let guard = 0;
    const crateSeen = new Set<number>();
    while (pendingBlasts.length && guard++ < 20) {
      const bl = pendingBlasts.shift()!;
      for (const b of blocksInBlast(this.grid, bl.x, bl.y, bl.r)) {
        let f = blastFalloff(b, bl.x, bl.y, bl.r);
        if (b.item === 'wedge') f *= 0.85;
        addDmg(b, bl.d * f, bl.type);
      }
      this.queueCrates(crateSeen, pendingBlasts, outcome);
    }
    // craters change the ground
    for (const cr of outcome.craters) {
      const y = st.terrain[Math.max(0, Math.min(st.terrain.length - 1, cr.x))];
      applyCrater(st.terrain, cr.x, y, cr.r);
    }
    // remove destroyed, collapse unsupported
    this.purgeDestroyed();
    for (let pass = 0; pass < 5; pass++) {
      const col = resolveCollapse(this.grid, st.terrain);
      for (const l of col.landings) addDmg(l.block, l.amount, 'blast');
      outcome.falls.push(...col.falls);
      for (const f of col.falls) {
        const ev = dmgMap.get(f.blockId);
        if (ev) {
          ev.r = f.toR;
          if (f.destroyed) ev.destroyed = true;
        }
      }
      const before = pendingBlasts.length;
      this.queueCrates(crateSeen, pendingBlasts, outcome);
      while (pendingBlasts.length) {
        const bl = pendingBlasts.shift()!;
        for (const b of blocksInBlast(this.grid, bl.x, bl.y, bl.r)) addDmg(b, bl.d * blastFalloff(b, bl.x, bl.y, bl.r), bl.type);
      }
      const removed = this.purgeDestroyed();
      if (col.falls.length === 0 && removed === 0 && before === 0) break;
    }
    outcome.damage = [...dmgMap.values()];
    // falls of undamaged blocks still count as damage events for destruction tallies
    for (const f of outcome.falls) {
      if (f.destroyed && !dmgMap.has(f.blockId)) {
        outcome.damage.push({ owner: f.owner, blockId: f.blockId, item: f.item, c: f.c, r: f.toR, amount: 0, destroyed: true });
      }
    }

    // ---- bookkeeping, observations
    const enemyDmg = outcome.damage.filter((d) => d.owner === enemy);
    const enemyDealt = enemyDmg.reduce((a, d) => a + d.amount, 0);
    const destroyedEnemy = enemyDmg.filter((d) => d.destroyed);
    const ownDmg = outcome.damage.filter((d) => d.owner === seat);
    anyHit = enemyDealt > 0 || destroyedEnemy.length > 0;
    shooter.stats.shotsFired++;
    if (anyHit) shooter.stats.shotsHit++;
    shooter.stats.damageDealt += Math.round(enemyDealt);
    for (const d of enemyDmg) {
      const frac = d.destroyed ? 1 : Math.min(1, d.amount / ITEMS[d.item].hp);
      shooter.stats.score += Math.round(scoreValue(d.item) * frac);
    }
    target.stats.damageTaken += Math.round(enemyDealt);
    shooter.stats.structuresDestroyed += destroyedEnemy.length;
    target.stats.structuresLost += destroyedEnemy.length;
    const ownLost = ownDmg.filter((d) => d.destroyed).length;
    shooter.stats.structuresLost += ownLost;
    shooter.stats.damageTaken += Math.round(ownDmg.reduce((a, d) => a + d.amount, 0));

    // obscured by enemy smoke?
    const inEnemySmoke = (x: number, y: number) => st.smoke.some((s) => s.owner === enemy && Math.hypot(s.x - x, s.y - y) < s.r);
    const obscured = outcome.projectiles.every((pr) => pr.end.kind !== 'lost' && inEnemySmoke(pr.end.x, pr.end.y)) && A.special !== 'smoke';

    // reveal per settings
    const rev = st.settings.revealOnHit;
    if (!obscured) {
      if (rev !== 'none') {
        for (const d of enemyDmg) {
          const kind: KnownKind = d.destroyed ? 'destroyed' : d.item === 'core' ? 'core' : 'structure';
          outcome.revealed.push({ c: d.c, r: d.r, kind, turn: st.turn });
        }
      }
      if (rev === 'area') {
        for (const pr of outcome.projectiles) {
          if (!pr.explosion || pr.explosion.type === 'intercept') continue;
          for (const b of target.blocks) {
            if (b.hp <= 0 || blastFalloff(b, pr.explosion.x, pr.explosion.y, pr.explosion.r) <= 0) continue;
            if (!outcome.revealed.some((k) => k.c === b.c && k.r === b.r))
              outcome.revealed.push({ c: b.c, r: b.r, kind: isWeapon(b.item) || b.item === 'decoy' ? 'weapon' : b.item === 'core' ? 'core' : 'structure', turn: st.turn });
          }
        }
      }
    } else {
      outcome.revealed = [];
    }
    for (const k of outcome.revealed) shooter.known[`${k.c},${k.r}`] = k;
    // destroyed known cells that have since fallen/moved: clear stale entries for destroyed ids
    for (const d of destroyedEnemy) {
      const kk = `${d.c},${d.r}`;
      if (rev !== 'none' && !obscured) shooter.known[kk] = { c: d.c, r: d.r, kind: 'destroyed', turn: st.turn };
    }

    shooter.history.push({
      turn: st.turn, weaponItem: wb.item, weaponId: wb.id, ammo, angle, power, launch, wind: st.wind, hit: anyHit,
      ends: outcome.projectiles.map((pr) => ({
        x: Math.round(pr.end.x), y: Math.round(pr.end.y),
        kind: obscured ? 'obscured' : pr.end.kind,
      })),
    });
    if (shooter.history.length > 60) shooter.history.shift();

    // target observes the incoming shell on its own half
    for (const pr of outcome.projectiles) {
      const pts = pr.points.filter(([x]) => halfOf(x) === enemy);
      if (pts.length) {
        const step = Math.max(1, Math.floor(pts.length / 20));
        target.incoming.push({ turn: st.turn, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1) });
      }
    }
    if (target.incoming.length > 20) target.incoming.splice(0, target.incoming.length - 20);

    // radar detection of the launch (and decoy flashes)
    const launchSmoked = st.smoke.some((s) => s.owner === seat && Math.hypot(s.x - launch.x, s.y - launch.y) < s.r);
    if (this.hasRadar(enemy) && !launchSmoked) {
      const nRadar = this.operational(enemy, 'radar').length;
      const err = RULES.radarErrorPx / Math.sqrt(nRadar);
      target.detections.push({ x: Math.round(launch.x + this.rng.gauss() * err * 0.6), y: Math.round(launch.y + this.rng.gauss() * 20), turn: st.turn });
      for (const d of this.operational(seat, 'decoy')) {
        if (this.rng.chance(0.85)) {
          const m = muzzleOf(d);
          target.detections.push({ x: Math.round(m.x + this.rng.gauss() * err * 0.6), y: Math.round(m.y + this.rng.gauss() * 20), turn: st.turn });
        }
      }
      this.log('Radar: enemy launch signature detected.', 'enemy', enemy);
    }

    // ---- log
    const wname = W.name;
    this.log(`${shooter.name} fired ${wname} (${A.short}).`, 'info', seat);
    this.log(`Incoming ${salvo > 1 ? 'rocket salvo' : W.id === 'howitzer' || W.id === 'hmortar' ? 'heavy shell' : 'shell'}!`, 'enemy', enemy);
    const intercepted = outcome.projectiles.filter((p) => p.end.kind === 'intercepted').length;
    if (intercepted) {
      this.log(`${intercepted > 1 ? intercepted + ' projectiles' : 'Projectile'} intercepted by enemy air defense.`, 'warn', seat);
      this.log(`Air defense intercepted ${intercepted} incoming projectile${intercepted > 1 ? 's' : ''}.`, 'good', enemy);
    }
    if (obscured) this.log('Impact obscured by smoke.', 'warn', seat);
    else if (A.special === 'recon') this.log(`Recon flare revealed ${outcome.revealed.length} contact${outcome.revealed.length === 1 ? '' : 's'}.`, 'info', seat);
    else if (A.special === 'smoke') this.log('Smoke screen deployed.', 'info', seat);
    else if (anyHit) {
      this.log(`Hit! ${Math.round(enemyDealt)} damage to enemy structures.`, 'good', seat);
      if (enemyDmg.some((d) => d.item === 'core')) this.log('Enemy COMMAND CORE hit!', 'good', seat);
    } else this.log('No confirmed damage.', 'info', seat);
    if (destroyedEnemy.length) {
      const wpn = destroyedEnemy.filter((d) => isWeapon(d.item)).length;
      this.log(`${destroyedEnemy.length} enemy structure${destroyedEnemy.length > 1 ? 's' : ''} destroyed${wpn ? ` (incl. ${wpn} artillery piece${wpn > 1 ? 's' : ''})` : ''}.`, 'good', seat);
    }
    if (outcome.falls.some((f) => f.owner === enemy)) this.log('Structural collapse observed in enemy lines.', 'good', seat);
    if (outcome.secondary.length) this.log('Secondary explosion!', 'good', seat);
    if (ownDmg.length) this.log(`Friendly fire! ${ownDmg.length} of your blocks were damaged.`, 'bad', seat);
    const tDmg = Math.round(enemyDealt);
    if (tDmg > 0) this.log(`Our base took ${tDmg} damage${destroyedEnemy.length ? `, ${destroyedEnemy.length} block${destroyedEnemy.length > 1 ? 's' : ''} lost` : ''}.`, 'bad', enemy);
    for (const d of destroyedEnemy) if (isWeapon(d.item)) this.log(`Our ${ITEMS[d.item].name} was destroyed!`, 'bad', enemy);
    if (enemyDmg.some((d) => d.item === 'core')) this.log('Our COMMAND CORE was hit!', 'bad', enemy);
    if (outcome.falls.some((f) => f.owner === enemy)) this.log('Part of our base collapsed.', 'bad', enemy);
    return outcome;
  }

  private queueCrates(seen: Set<number>, pending: { x: number; y: number; r: number; d: number; type: DamageType }[], outcome: ShotOutcome) {
    for (const s of [0, 1] as Seat[]) {
      const p = this.state.players[s];
      for (const b of p.blocks) {
        if (b.item === 'crate' && b.hp <= 0 && !seen.has(b.id)) {
          seen.add(b.id);
          const x = b.c * CELL + CELL / 2;
          const y = b.r * CELL + CELL / 2;
          pending.push({ x, y, r: RULES.crateBlastRadius, d: RULES.crateBlastDamage, type: 'blast' });
          outcome.secondary.push({ x, y, r: RULES.crateBlastRadius });
          p.ammo.he = Math.max(0, p.ammo.he - RULES.crateRounds);
        }
      }
    }
  }

  private purgeDestroyed(): number {
    let n = 0;
    // crate explosions are queued (queueCrates) before destroyed blocks are dropped here
    for (const p of this.state.players) {
      const keep = p.blocks.filter((b) => b.hp > 0);
      n += p.blocks.length - keep.length;
      p.blocks = keep;
    }
    this.grid = buildGrid([...this.state.players[0].blocks, ...this.state.players[1].blocks]);
    return n;
  }

  private checkVictory(shooter: Seat) {
    const st = this.state;
    const lost = [false, false];
    const reasons = ['', ''];
    for (const s of [0, 1] as Seat[]) {
      const p = st.players[s];
      if (!p.blocks.some((b) => b.item === 'core')) {
        lost[s] = true;
        reasons[s] = 'Command Core destroyed';
      } else if (st.settings.victory === 'weapons' && !p.blocks.some((b) => isWeapon(b.item))) {
        lost[s] = true;
        reasons[s] = 'All artillery destroyed';
      } else if (st.settings.victory === 'integrity' && this.integrity(s) < RULES.integrityLoss) {
        lost[s] = true;
        reasons[s] = `Base integrity below ${Math.round(RULES.integrityLoss * 100)}%`;
      }
    }
    if (!lost[0] && !lost[1]) return;
    st.phase = 'over';
    if (lost[0] && lost[1]) {
      st.winner = 'draw';
      st.winReason = 'Mutual destruction';
    } else {
      const loser: Seat = lost[0] ? 0 : 1;
      st.winner = other(loser);
      st.winReason = `${st.players[loser].name}: ${reasons[loser]}`;
    }
    void shooter;
    this.log(st.winner === 'draw' ? 'Draw - mutual destruction!' : `${st.players[st.winner as Seat].name} wins! ${st.winReason}`, 'info');
  }

  // ------------------------------------------------------------------ actions
  apply(seat: Seat, action: PlayerAction): ActionResult {
    if (!action || typeof action !== 'object') return { ok: false, error: 'Bad action' };
    let err: string | null = null;
    let shot: ShotOutcome | undefined;
    switch (action.t) {
      case 'place': err = this.place(seat, action.item, action.c, action.r, action.rot ?? 0); break;
      case 'remove': err = this.remove(seat, action.c, action.r); break;
      case 'ammo': err = this.buyAmmo(seat, action.ammo, action.delta); break;
      case 'ready': err = this.setReady(seat, !!action.ready); break;
      case 'fire': {
        const r = this.fire(seat, action.weaponId, action.ammo, action.angle, action.power);
        err = r.error ?? null;
        shot = r.shot;
        break;
      }
      case 'endTurn': err = this.endTurn(seat); break;
      default: err = 'Unknown action';
    }
    this.sync();
    return err ? { ok: false, error: err } : { ok: true, shot };
  }

  // ------------------------------------------------------- information filter
  viewFor(seat: Seat): PlayerView {
    const st = this.state;
    const me = st.players[seat];
    const foe = st.players[other(seat)];
    const exact = this.hasRadar(seat) || st.phase === 'over';
    const reveal = st.phase === 'over' || (st.settings.openBases && st.phase === 'combat');
    const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
    return {
      you: seat,
      phase: st.phase,
      turn: st.turn,
      active: st.active,
      settings: { ...st.settings },
      terrain: st.terrain.slice(),
      wind: exact ? st.wind : Math.round(st.wind * 4) / 4,
      windExact: exact,
      smoke: clone(st.smoke),
      shotsThisTurn: st.shotsThisTurn,
      firedThisTurn: st.firedThisTurn.filter((id) => me.blocks.some((b) => b.id === id)),
      own: {
        name: me.name,
        blocks: clone(me.blocks),
        ammo: { ...me.ammo },
        boughtAmmo: { ...me.boughtAmmo },
        spent: this.spent(seat),
        ready: me.ready,
        stats: { ...me.stats },
        history: clone(me.history),
        incoming: clone(me.incoming),
        integrity: this.integrity(seat),
      },
      enemy: {
        name: foe.name,
        ready: foe.ready,
        known: Object.values(me.known).map((k) => ({ ...k })),
        detections: me.detections.map((d) => ({ ...d })),
        stats: st.phase === 'over' ? { ...foe.stats } : null,
        blocks: reveal ? clone(foe.blocks) : null,
      },
      log: st.log.filter((l) => l.to === 'all' || l.to === seat).slice(-80),
      winner: st.winner,
      winReason: st.winReason,
      turnStartedAt: st.turnStartedAt,
    };
  }

  reportFor(shot: ShotOutcome, viewer: Seat): ShotReport {
    const st = this.state;
    const reveal = st.settings.openBases;
    const mine = viewer === shot.shooter;
    const messages: string[] = [];
    if (mine) {
      const enemySmoke = (x: number, y: number) => st.smoke.some((s) => s.owner !== viewer && Math.hypot(s.x - x, s.y - y) < s.r);
      const projectiles = shot.projectiles.map((p) => {
        if (shot.ammo !== 'smoke' && p.end.kind !== 'lost' && enemySmoke(p.end.x, p.end.y)) {
          const cut = p.points.findIndex(([x, y]) => enemySmoke(x, y));
          return { points: p.points.slice(0, Math.max(1, cut)), end: { ...p.end, kind: 'obscured' as const }, explosion: null };
        }
        return p;
      });
      const knownIds = new Set(shot.revealed.map((k) => `${k.c},${k.r}`));
      const damage = shot.damage.filter((d) => d.owner === viewer || reveal || knownIds.has(`${d.c},${d.r}`));
      const falls = shot.falls.filter((f) => f.owner === viewer || reveal);
      if (shot.damage.some((d) => d.owner !== viewer && d.item === 'core')) messages.push('COMMAND CORE HIT!');
      const dest = shot.damage.filter((d) => d.owner !== viewer && d.destroyed);
      if (dest.some((d) => isWeapon(d.item))) messages.push('Enemy artillery destroyed!');
      else if (dest.length) messages.push(`${dest.length} enemy structure${dest.length > 1 ? 's' : ''} destroyed`);
      else if (shot.damage.some((d) => d.owner !== viewer)) messages.push('Hit confirmed');
      if (shot.falls.some((f) => f.owner !== viewer)) messages.push('Collapse observed');
      if (projectiles.some((p) => p.end.kind === 'intercepted')) messages.push('Intercepted!');
      if (projectiles.every((p) => p.end.kind === 'obscured')) messages.push('Impact obscured by smoke');
      return {
        shooter: shot.shooter, viewer, weaponItem: shot.weaponItem, ammo: shot.ammo, launch: shot.launch,
        projectiles, damage, falls, secondary: shot.secondary, // big secondary blasts are visible from afar
        craters: shot.craters, smoke: shot.smoke, messages,
      };
    }
    // the target only sees what happens over its own half
    const projectiles = shot.projectiles.map((p) => {
      if (reveal) return p;
      const pts = p.points.filter(([x]) => halfOf(x) === viewer);
      const endVisible = halfOf(p.end.x) === viewer;
      return {
        points: pts,
        end: endVisible ? p.end : { ...p.end, kind: 'lost' as const },
        explosion: endVisible ? p.explosion : null,
      };
    });
    const damage = shot.damage.filter((d) => d.owner === viewer || reveal);
    const falls = shot.falls.filter((f) => f.owner === viewer || reveal);
    if (damage.some((d) => d.owner === viewer)) messages.push('We are hit!');
    if (damage.some((d) => d.owner === viewer && d.item === 'core')) messages.push('COMMAND CORE DAMAGED');
    if (projectiles.some((p) => p.end.kind === 'intercepted')) messages.push('Shell intercepted');
    if (!damage.length && !projectiles.some((p) => p.points.length)) messages.push('Enemy fired - shell not observed');
    else if (!damage.length) messages.push('Enemy shell missed');
    return {
      shooter: shot.shooter, viewer, weaponItem: shot.weaponItem, ammo: null, launch: reveal ? shot.launch : null,
      projectiles, damage, falls, secondary: shot.secondary.filter((s) => halfOf(s.x) === viewer || reveal),
      craters: shot.craters, smoke: shot.smoke, messages,
    };
  }
}

export type { FallEvent };
