import { CELL, RULES, WEAPONS, WORLD, type WeaponId } from './config';
import { terrainAt } from './terrain';
import type { ImpactKind } from './types';

export interface LaunchParams {
  x: number;
  y: number;
  angleDeg: number; // elevation above horizontal, toward `dir`
  speed: number;
  dir: 1 | -1;
  wind: number;
  weapon: WeaponId;
}

export interface CollisionWorld {
  terrain: number[];
  /** Returns an id for a solid cell at grid (c, r) or null. */
  solidAt: (c: number, r: number) => number | null;
}

export interface SimOptions {
  /** Called every step; return true to intercept the projectile at this point. */
  intercept?: (x: number, y: number, vx: number, vy: number) => boolean;
  /** Ids that are passed through (AP penetration). Returns true to continue. */
  onBlock?: (id: number, x: number, y: number) => boolean;
  maxTime?: number;
  sampleEvery?: number;
}

export interface SimResult {
  points: [number, number][];
  end: { x: number; y: number; kind: ImpactKind; blockId?: number };
  time: number;
}

export const DT = 1 / 120;

export function speedFor(weapon: WeaponId, power: number): number {
  return (WEAPONS[weapon].speedMax * Math.max(1, Math.min(100, power))) / 100;
}

/**
 * Fixed-step ballistic integration with gravity, wind and optional rocket boost.
 * Collision is swept along each step in 4px increments against terrain and grid cells.
 */
export function simulate(p: LaunchParams, world: CollisionWorld, opts: SimOptions = {}): SimResult {
  const w = WEAPONS[p.weapon];
  const a = (p.angleDeg * Math.PI) / 180;
  let vx = Math.cos(a) * p.speed * p.dir;
  let vy = -Math.sin(a) * p.speed;
  let x = p.x;
  let y = p.y;
  let t = 0;
  const maxTime = opts.maxTime ?? RULES.maxShotTime;
  const sampleEvery = opts.sampleEvery ?? 3;
  const points: [number, number][] = [[round1(x), round1(y)]];
  const windA = p.wind * WORLD.windAccel * w.windFactor;
  let step = 0;
  const passed = new Set<number>();

  while (t < maxTime) {
    // forces
    if (w.thrust && w.thrustTime && t < w.thrustTime) {
      const sp = Math.hypot(vx, vy) || 1;
      vx += (vx / sp) * w.thrust * DT;
      vy += (vy / sp) * w.thrust * DT;
    }
    vy += WORLD.gravity * DT;
    vx += windA * DT;
    const nx = x + vx * DT;
    const ny = y + vy * DT;

    // swept collision
    const dist = Math.hypot(nx - x, ny - y);
    const n = Math.max(1, Math.ceil(dist / 4));
    for (let i = 1; i <= n; i++) {
      const sx = x + ((nx - x) * i) / n;
      const sy = y + ((ny - y) * i) / n;
      if (sx < -200 || sx > WORLD.width + 200 || sy > WORLD.height + 50) {
        points.push([round1(sx), round1(sy)]);
        return { points, end: { x: sx, y: sy, kind: 'lost' }, time: t };
      }
      if (sy >= terrainAt(world.terrain, sx)) {
        points.push([round1(sx), round1(sy)]);
        return { points, end: { x: sx, y: sy, kind: 'terrain' }, time: t };
      }
      if (sy >= 0) {
        const id = world.solidAt(Math.floor(sx / CELL), Math.floor(sy / CELL));
        if (id !== null && !passed.has(id)) {
          if (opts.onBlock && opts.onBlock(id, sx, sy)) {
            passed.add(id);
          } else {
            points.push([round1(sx), round1(sy)]);
            return { points, end: { x: sx, y: sy, kind: 'structure', blockId: id }, time: t };
          }
        }
      }
    }
    x = nx;
    y = ny;
    t += DT;
    step++;
    if (opts.intercept && opts.intercept(x, y, vx, vy)) {
      points.push([round1(x), round1(y)]);
      return { points, end: { x, y, kind: 'intercepted' }, time: t };
    }
    if (step % sampleEvery === 0) points.push([round1(x), round1(y)]);
  }
  return { points, end: { x, y, kind: 'lost' }, time: t };
}

/** Analytic flat-ground range with no wind/drag, for UI estimates and tests. */
export function flatRange(speed: number, angleDeg: number): number {
  const a = (angleDeg * Math.PI) / 180;
  return (speed * speed * Math.sin(2 * a)) / WORLD.gravity;
}

/**
 * Finds the power (1..100) that lands the shell closest to targetX at a given angle,
 * using the same simulation (terrain + known blocks only). Returns null if unreachable.
 */
export function solvePower(
  base: Omit<LaunchParams, 'speed'>,
  targetX: number,
  world: CollisionWorld,
): { power: number; error: number } | null {
  let best: { power: number; error: number } | null = null;
  const evalP = (pw: number) => {
    const r = simulate({ ...base, speed: speedFor(base.weapon, pw) }, world, { sampleEvery: 1000 });
    return r.end.x;
  };
  // coarse scan, then refine around best
  for (let pw = 5; pw <= 100; pw += 5) {
    const err = Math.abs(evalP(pw) - targetX);
    if (!best || err < best.error) best = { power: pw, error: err };
  }
  if (!best) return null;
  let lo = Math.max(1, best.power - 5);
  let hi = Math.min(100, best.power + 5);
  for (let pw = lo; pw <= hi; pw += 0.25) {
    const err = Math.abs(evalP(pw) - targetX);
    if (err < best.error) best = { power: Math.round(pw * 100) / 100, error: err };
  }
  if (best.error > 60) return null;
  return best;
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
