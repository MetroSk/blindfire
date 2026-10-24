import { CELL, ITEMS, type DamageType } from './config';
import type { Block } from './types';

/** Applies raw damage after material resistance. Returns the HP actually removed. */
export function damageBlock(b: Block, raw: number, type: DamageType): number {
  if (b.hp <= 0 || raw <= 0) return 0;
  const amount = raw * ITEMS[b.item].resist[type];
  const dealt = Math.min(b.hp, amount);
  b.hp = Math.round((b.hp - amount) * 10) / 10;
  return dealt;
}

/** Linear falloff from centre to edge, measured to the block centre. */
export function blastFalloff(b: Block, x: number, y: number, radius: number): number {
  const cx = b.c * CELL + CELL / 2;
  const cy = b.r * CELL + CELL / 2;
  const d = Math.hypot(cx - x, cy - y);
  const reach = radius + CELL * 0.5;
  if (d >= reach) return 0;
  return 1 - d / reach;
}

/** Blocks whose centre lies within the explosion's reach. */
export function blocksInBlast(grid: Map<number, Block>, x: number, y: number, radius: number): Block[] {
  const out: Block[] = [];
  const reach = radius + CELL;
  const c0 = Math.floor((x - reach) / CELL);
  const c1 = Math.floor((x + reach) / CELL);
  const r0 = Math.floor((y - reach) / CELL);
  const r1 = Math.floor((y + reach) / CELL);
  for (let c = c0; c <= c1; c++)
    for (let r = r0; r <= r1; r++) {
      const b = grid.get(c * 1000 + r);
      if (b && blastFalloff(b, x, y, radius) > 0) out.push(b);
    }
  return out;
}

/** Does an incoming shell moving along (vx, vy) strike the sloped face of a wedge? */
export function hitsWedgeFace(rot: number, vx: number, vy: number): boolean {
  // face normals: 0 up-left, 1 up-right, 2 down-right, 3 down-left
  const normals = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const [nx, ny] = normals[rot & 3];
  return vx * nx + vy * ny < 0;
}
