import { AMMO, CELL, ITEMS, WEAPONS, ZONES, type AmmoId, type ItemId, type WeaponId } from './config';
import { solvePower, speedFor, simulate, type CollisionWorld } from './ballistics';
import { Match, facing, other, muzzleOf } from './match';
import { Rng } from './rng';
import { groundRowAt, terrainAt } from './terrain';
import { key } from './structure';
import type { Block, Difficulty, PlayerAction, PlayerView, Seat } from './types';

// =================================================================== BUILDING

/** Builds a base for `seat` using exactly the same placement rules and budget as a human. */
export function aiBuild(m: Match, seat: Seat, diff: Difficulty, rng: Rng) {
  const z = ZONES[seat];
  const fwd = facing(seat); // +1 means enemy is to the right
  const terrain = m.state.terrain;
  const gr = (c: number) => groundRowAt(terrain, c);
  const place = (item: ItemId, c: number, r: number, rot = 0) => m.place(seat, item, c, r, rot) === null;
  const topFree = (c: number) => {
    let r = gr(c) - 1;
    while (m.grid.has(key(c, r))) r--;
    return r;
  };
  const stack = (c: number, items: ItemId[]) => items.every((it) => place(it, c, topFree(c)));
  const clampC = (c: number) => Math.max(z.c0, Math.min(z.c1, c));
  // columns ordered from back (safe) to front (toward enemy)
  const back = fwd === 1 ? z.c0 : z.c1;
  const at = (fromBack: number) => back + fwd * fromBack;
  const width = z.c1 - z.c0;

  // smart AIs keep the bunker toward the back so their guns have a clear lane forward
  const coreOff = diff === 'easy' ? rng.int(3, width - 3) : rng.int(2, Math.floor(width * 0.55));
  const cc = at(coreOff);
  const coreR = gr(cc) - 1;

  if (diff === 'easy') {
    place('core', cc, coreR);
    place('wood', cc - 1, gr(cc - 1) - 1);
    place('wood', cc + 1, gr(cc + 1) - 1);
    place('wood', cc, coreR - 1);
    place('stone', cc - 1, topFree(cc - 1));
    place('stone', cc + 1, topFree(cc + 1));
    const wc = clampC(cc + fwd * rng.int(2, 4));
    stack(wc, ['wood', 'mortar']);
    if (rng.chance(0.6)) stack(clampC(cc - fwd * rng.int(2, 4)), ['stone', 'cannon']);
    // wasteful purchases
    const wastes: ItemId[] = ['wood', 'sandbag', 'decoy', 'stone'];
    for (let i = 0; i < 25 && m.remaining(seat) > 60; i++) {
      const c = rng.int(z.c0, z.c1);
      place(rng.pick(wastes), c, topFree(c));
    }
    while (m.remaining(seat) >= 4 && m.buyAmmo(seat, rng.pick<AmmoId>(['he', 'he', 'frag', 'smoke']), 1) === null) { /* spend */ }
    m.setReady(seat, true);
    return;
  }

  const hard = diff === 'hard';
  // --- bunker around the core
  if (hard) {
    place('foundation', cc - 1, gr(cc - 1) - 1);
    place('foundation', cc + 1, gr(cc + 1) - 1);
  }
  place('core', cc, coreR);
  const wall: ItemId = hard ? 'concrete' : 'stone';
  const roof1: ItemId = hard ? 'armor' : 'steel';
  if (!hard) {
    place(wall, cc - 1, gr(cc - 1) - 1);
    place(wall, cc + 1, gr(cc + 1) - 1);
  }
  place(wall, cc - 1, topFree(cc - 1));
  place(wall, cc + 1, topFree(cc + 1));
  place(roof1, cc, topFree(cc));
  place(hard ? 'concrete' : 'stone', cc, topFree(cc));
  place('steel', cc - 1, topFree(cc - 1));
  place('steel', cc + 1, topFree(cc + 1));
  // outer sandbag / stone skirt
  for (const dc of [-2, 2]) {
    const c = clampC(cc + dc);
    if (c !== cc + dc) continue;
    place(hard ? 'sandbag' : 'stone', c, topFree(c));
  }

  // --- weapons dispersed: short-range mortar forward, long-range gun further back
  const budget = m.state.settings.budget;
  const longGun: WeaponId = hard && budget >= 1300 ? 'howitzer' : 'cannon';
  const weaponPlan: { w: WeaponId; off: number; pillar: ItemId[] }[] = [
    { w: 'mortar', off: rng.int(width - 3, width), pillar: [] },
    { w: longGun, off: rng.int(Math.min(width - 5, coreOff + 4), width - 5), pillar: ['stone'] },
  ];
  if (hard) weaponPlan.push({ w: 'mortar', off: rng.int(Math.min(width - 3, coreOff + 3), width - 2), pillar: [] });
  if (budget >= 1600) weaponPlan.push({ w: hard ? 'hmortar' : 'rocket', off: rng.int(Math.min(width - 3, coreOff + 4), width - 3), pillar: [] });
  for (const { w, off, pillar } of weaponPlan) {
    for (let tries = 0; tries < 10; tries++) {
      const c = clampC(at(off) + (tries % 2 ? tries : -tries));
      if (Math.abs(c - cc) <= 3) continue;
      if (stack(c, [...pillar, w])) break;
    }
  }

  // --- utility
  if (hard && m.state.settings.scouting) {
    for (let t = 0; t < 6; t++) {
      const c = clampC(cc + rng.pick([-3, -4, 3, 4]));
      if (place('radar', c, topFree(c))) break;
    }
  }
  if (hard && budget >= 1300) {
    for (let t = 0; t < 6; t++) {
      const c = clampC(cc + rng.pick([-2, -3, 2, 3]));
      if (place('aa', c, topFree(c))) break;
    }
  }
  // decoys far from core
  const decoys = hard ? 2 : 1;
  for (let d = 0; d < decoys; d++) {
    for (let t = 0; t < 8; t++) {
      const off = coreOff > width / 2 ? rng.int(0, Math.floor(width / 3)) : rng.int(Math.floor((width * 2) / 3), width);
      const c = at(off);
      if (Math.abs(c - cc) > 3 && place('decoy', c, topFree(c))) break;
    }
  }
  // ammo crate kept away from the core
  if (hard) {
    for (let t = 0; t < 8; t++) {
      const c = clampC(cc + fwd * -rng.int(4, 7));
      if (place('crate', c, topFree(c))) break;
    }
  }

  // --- ammunition
  const wantAmmo: [AmmoId, number][] = hard
    ? [['he', 10], ['ap', 4], ['frag', 3], ['recon', 2]]
    : [['he', 8], ['frag', 3], ['recon', 1]];
  for (const [a, n] of wantAmmo) for (let i = 0; i < n; i++) m.buyAmmo(seat, a, 1);
  // keep a reserve for more rounds before thickening walls
  const reserve = Math.round(budget * (hard ? 0.08 : 0.04));

  // --- spend remainder: extra armour on the bunker, then HE
  const extra: ItemId[] = hard ? ['concrete', 'steel', 'armor', 'stone'] : ['stone', 'wood'];
  for (let i = 0; i < 40 && m.remaining(seat) > 30 + reserve; i++) {
    const c = clampC(cc + rng.int(-2, 2));
    const it = rng.pick(extra);
    if (topFree(c) < gr(c) - 6) continue;
    place(it, c, topFree(c));
  }
  while (m.remaining(seat) >= AMMO.he.cost && m.buyAmmo(seat, 'he', 1) === null) { /* spend */ }
  m.setReady(seat, true);
}

// ==================================================================== COMBAT

export interface AIMemory {
  lastPlan?: { turn: number; weaponId: number; predictedX: number; targetX: number };
  offsets: number[]; // observed (actual - predicted) impact errors
  sweep: number[];
  sweepIdx: number;
  missX: number[];
}

export function newAIMemory(): AIMemory {
  return { offsets: [], sweep: [], sweepIdx: 0, missX: [] };
}

const DIFF = {
  easy: { power: 3.5, angle: 1.5, learn: 0, smart: false },
  medium: { power: 2.2, angle: 0.8, learn: 0.3, smart: true },
  hard: { power: 0.45, angle: 0.15, learn: 0.85, smart: true },
};

/** Least-squares parabola y = a x^2 + b x + c through observed incoming points. */
function fitParabola(pts: [number, number][]): [number, number, number] | null {
  if (pts.length < 4) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  let S = [0, 0, 0, 0, 0];
  let T = [0, 0, 0];
  for (const [x0, y] of pts) {
    const x = (x0 - mx) / 1000;
    S = [S[0] + 1, S[1] + x, S[2] + x * x, S[3] + x * x * x, S[4] + x * x * x * x];
    T = [T[0] + y, T[1] + x * y, T[2] + x * x * y];
  }
  // solve [S4 S3 S2; S3 S2 S1; S2 S1 S0] [a b c] = [T2 T1 T0]
  const M = [[S[4], S[3], S[2], T[2]], [S[3], S[2], S[1], T[1]], [S[2], S[1], S[0], T[0]]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-9) return null;
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const f = M[j][i] / M[i][i];
      for (let k = i; k < 4; k++) M[j][k] -= f * M[i][k];
    }
  }
  const a = M[0][3] / M[0][0];
  const b = M[1][3] / M[1][1];
  const c = M[2][3] / M[2][2];
  // convert back to world x
  const A = a / 1e6;
  const B = b / 1000 - (2 * a * mx) / 1e6;
  const C = c - (b * mx) / 1000 + (a * mx * mx) / 1e6;
  return [A, B, C];
}

/** Extrapolate an incoming shell back to where it left the ground on the enemy side. */
export function estimateOrigin(view: PlayerView, pts: [number, number][]): number | null {
  const fit = fitParabola(pts);
  if (!fit) return null;
  const [A, B, C] = fit;
  if (A <= 0) return null; // must open downward in screen coords
  const enemy = other(view.you);
  const z = ZONES[enemy];
  const xs = enemy === 1 ? [z.c1 * CELL, z.c0 * CELL - 200] : [z.c0 * CELL, (z.c1 + 1) * CELL + 200];
  const step = enemy === 1 ? -6 : 6;
  for (let x = xs[0]; enemy === 1 ? x >= xs[1] : x <= xs[1]; x += step) {
    const y = A * x * x + B * x + C;
    if (y >= terrainAt(view.terrain, x) - CELL * 2) return x;
  }
  return null;
}

export function aiChooseAction(view: PlayerView, mem: AIMemory, diff: Difficulty, rng: Rng): PlayerAction {
  const D = DIFF[diff];
  const me = view.you;
  const enemy = other(me);
  const own = view.own.blocks;
  const ownGrid = new Map<number, Block>();
  for (const b of own) ownGrid.set(key(b.c, b.r), b);
  const world: CollisionWorld = {
    terrain: view.terrain,
    solidAt: (c, r) => ownGrid.get(key(c, r))?.id ?? null,
  };

  // learn from the last shot: compare predicted ground impact vs observed
  if (mem.lastPlan && D.learn > 0) {
    const rec = view.own.history.find((h) => h.turn === mem.lastPlan!.turn && h.weaponId === mem.lastPlan!.weaponId);
    if (rec) {
      const e = rec.ends[0];
      // only learn from plausible aiming errors, not shells that clipped a ridge or wall
      if (e && e.kind === 'terrain' && Math.abs(e.x - mem.lastPlan.predictedX) < 250) {
        mem.offsets.push(e.x - mem.lastPlan.predictedX);
        if (mem.offsets.length > 4) mem.offsets.shift();
      }
      for (const end of rec.ends) if (end.kind === 'terrain' && !rec.hit) mem.missX.push(end.x);
    }
    mem.lastPlan = undefined;
  }

  const weapons = own.filter((b) => {
    const w = ITEMS[b.item].weapon;
    if (!w || b.hp <= 0 || b.cooldown > 0 || view.firedThisTurn.includes(b.id)) return false;
    if (ownGrid.has(key(b.c, b.r - 1))) return false;
    return WEAPONS[w].ammo.some((a) => view.own.ammo[a] >= WEAPONS[w].ammoUse);
  });
  if (!weapons.length) return { t: 'endTurn' };

  // ---------------------------------------------------------- pick a target
  const z = ZONES[enemy];
  const zx0 = z.c0 * CELL;
  const zx1 = (z.c1 + 1) * CELL;
  const alive = view.enemy.known.filter((k) => k.kind !== 'destroyed');
  if (!mem.sweep.length) {
    const step = diff === 'hard' ? 70 : 90;
    const xs: number[] = [];
    for (let x = zx0 + 40; x < zx1 - 20; x += step) xs.push(x);
    if (diff === 'hard') {
      // start from the middle of the zone and spiral outwards
      const mid = (zx0 + zx1) / 2;
      xs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    } else for (let i = xs.length - 1; i > 0; i--) { const j = rng.int(0, i); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    mem.sweep = xs;
  }
  let targetX: number | null = null;
  let targetKind: 'core' | 'weapon' | 'structure' | 'guess' | 'sweep' = 'sweep';
  let wantRecon = false;

  const core = alive.find((k) => k.kind === 'core');
  const gun = alive.find((k) => k.kind === 'weapon');
  // hard: silence known guns first when our own artillery is down to its last piece
  const lastGun = own.filter((b) => ITEMS[b.item].weapon && b.hp > 0).length <= 1;
  if (gun && diff === 'hard' && (lastGun || !core)) {
    targetX = gun.c * CELL + CELL / 2;
    targetKind = 'weapon';
  } else if (core && D.smart) {
    targetX = core.c * CELL + CELL / 2;
    targetKind = 'core';
  } else if (gun && D.smart) {
    targetX = gun.c * CELL + CELL / 2;
    targetKind = 'weapon';
  } else if (alive.length && diff !== 'easy') {
    let pick = alive[alive.length - 1];
    if (diff === 'hard') {
      // structural weak point: the lowest known cell with others stacked above it
      const score = (k: typeof pick) => k.r + alive.filter((o) => o.c === k.c && o.r < k.r).length * 2 + k.turn * 0.01;
      pick = alive.reduce((a, b) => (score(b) > score(a) ? b : a));
    }
    targetX = pick.c * CELL + CELL / 2;
    targetKind = 'structure';
  } else {
    const lastHit = [...view.own.history].reverse().find((h) => h.hit || h.ends.some((e) => e.kind === 'structure'));
    if (lastHit && D.smart) {
      const e = lastHit.ends.find((x) => x.kind === 'structure') ?? lastHit.ends[0];
      targetX = e.x + rng.range(-20, 20);
      targetKind = 'structure';
    }
  }

  if (targetX === null) {
    // estimates from radar detections and incoming shell paths
    const guesses: number[] = [];
    if (D.smart) {
      for (const d of view.enemy.detections) if (view.turn - d.turn <= 6) guesses.push(d.x);
      if (diff === 'hard') {
        for (const inc of view.own.incoming.slice(-3)) {
          const o = estimateOrigin(view, inc.points);
          if (o !== null) guesses.push(o);
        }
      }
    }
    const untested = guesses.filter((g) => !mem.missX.some((mx) => Math.abs(mx - g) < 35));
    if (untested.length) {
      targetX = rng.pick(untested) + rng.range(-30, 30);
      targetKind = 'guess';
    } else {
      // systematic sweep of the enemy zone
      if (diff === 'easy') targetX = rng.range(zx0 - 150, zx1 + 100);
      else {
        let tries = 0;
        do {
          targetX = mem.sweep[mem.sweepIdx % mem.sweep.length] + rng.range(-15, 15);
          mem.sweepIdx++;
        } while (tries++ < mem.sweep.length && mem.missX.some((mx) => Math.abs(mx - targetX!) < 30));
      }
      wantRecon = D.smart && view.own.history.length >= 3 && rng.chance(diff === 'hard' ? 0.45 : 0.25);
    }
  }

  // ---------------------------------------------------- weapon and ammunition
  const pref: Record<string, WeaponId[]> = {
    core: ['howitzer', 'cannon', 'hmortar', 'mortar', 'rocket'],
    weapon: ['rocket', 'hmortar', 'mortar', 'cannon', 'howitzer'],
    structure: ['hmortar', 'howitzer', 'rocket', 'mortar', 'cannon'],
    guess: ['hmortar', 'rocket', 'mortar', 'howitzer', 'cannon'],
    sweep: ['mortar', 'cannon', 'howitzer', 'rocket', 'hmortar'],
  };
  const order = diff === 'easy' ? [...weapons].sort(() => rng.next() - 0.5) :
    [...weapons].sort((a, b) => pref[targetKind].indexOf(ITEMS[a.item].weapon!) - pref[targetKind].indexOf(ITEMS[b.item].weapon!));

  const chooseAmmo = (w: WeaponId): AmmoId => {
    const W = WEAPONS[w];
    const has = (a: AmmoId) => W.ammo.includes(a) && view.own.ammo[a] >= W.ammoUse && (a !== 'recon' || view.settings.scouting);
    if (diff === 'easy') {
      const opts = W.ammo.filter((a) => has(a) && a !== 'smoke');
      return opts.length ? rng.pick(opts) : W.ammo.find(has)!;
    }
    if (wantRecon && has('recon')) return 'recon';
    if (targetKind === 'core' && has('ap')) return 'ap';
    if (targetKind === 'weapon' && has('frag')) return 'frag';
    if (has('he')) return 'he';
    const fallback = W.ammo.filter((a) => has(a) && a !== 'smoke' && a !== 'recon');
    return fallback[0] ?? W.ammo.find(has)!;
  };

  const avgErr = mem.offsets.length ? mem.offsets.reduce((a, b) => a + b, 0) / mem.offsets.length : 0;
  const correction = Math.max(-150, Math.min(150, avgErr * D.learn));
  // if the preferred target is out of reach, fall back to the nearest parts of the enemy zone
  const nearFirst = [...mem.sweep].sort((p, q) => Math.abs(p - muzzleOf(weapons[0]).x) - Math.abs(q - muzzleOf(weapons[0]).x));
  const candidates = [targetX, ...nearFirst.filter((x) => !mem.missX.some((mx) => Math.abs(mx - x) < 30)).slice(0, 3), ...nearFirst.slice(0, 2)];

  for (const tx of candidates) {
    const aimX = tx - correction;
    for (const wb of order) {
      const wid = ITEMS[wb.item].weapon!;
      const W = WEAPONS[wid];
      const m = muzzleOf(wb);
      const span = W.angleMax - W.angleMin;
      const angles = [0.55, 0.4, 0.7, 0.25, 0.85, 0.1, 0.95].map((f) => Math.round(W.angleMin + span * f));
      if (diff !== 'easy') angles.sort(() => rng.next() - 0.5);
      for (const ang of angles) {
        const sol = solvePower({ x: m.x, y: m.y, angleDeg: ang, dir: facing(me), wind: view.wind, weapon: wid }, aimX, world);
        if (!sol) continue;
        // make sure the predicted flight does not clip our own base
        const check = simulate({ x: m.x, y: m.y, angleDeg: ang, dir: facing(me), wind: view.wind, weapon: wid, speed: speedFor(wid, sol.power) }, world, { sampleEvery: 1000 });
        if (check.end.kind === 'structure') continue;
        const ammo = chooseAmmo(wid);
        const angle = Math.max(W.angleMin, Math.min(W.angleMax, ang + rng.gauss() * D.angle));
        const power = Math.max(1, Math.min(100, sol.power + rng.gauss() * D.power));
        mem.lastPlan = { turn: view.turn, weaponId: wb.id, predictedX: check.end.x, targetX: tx };
        return { t: 'fire', weaponId: wb.id, ammo, angle: Math.round(angle * 10) / 10, power: Math.round(power * 10) / 10 };
      }
    }
  }
  if (diff !== 'easy') return { t: 'endTurn' };
  // the cadet just lobs something at max range
  const wb = weapons[0];
  const W = WEAPONS[ITEMS[wb.item].weapon!];
  return { t: 'fire', weaponId: wb.id, ammo: chooseAmmo(W.id), angle: Math.round((W.angleMin + W.angleMax) / 2), power: 100 };
}

export const AI_NAMES: Record<Difficulty, string> = {
  easy: 'Cadet Bot',
  medium: 'Sergeant Bot',
  hard: 'Colonel Bot',
};
