import { ITEMS, WORLD, ZONES, type ItemId, type MatchSettings } from './config';
import { groundRowAt } from './terrain';
import { computeSupported, key } from './structure';
import type { Block, Seat } from './types';

export interface BuildContext {
  seat: Seat;
  terrain: number[];
  settings: MatchSettings;
  /** Every block the validator may consider (server: all; client: own). Zones never overlap. */
  grid: Map<number, Block>;
  ownBlocks: Block[];
  remaining: number;
}

/** Returns a human readable reason why `item` cannot go at (c, r), or null if it can. */
export function placementError(ctx: BuildContext, item: ItemId, c: number, r: number): string | null {
  const def = ITEMS[item];
  if (!def) return 'Unknown item';
  const z = ZONES[ctx.seat];
  if (!Number.isInteger(c) || !Number.isInteger(r)) return 'Invalid cell';
  if (c < z.c0 || c > z.c1) return 'Outside your build zone';
  const gr = groundRowAt(ctx.terrain, c);
  if (r >= gr) return 'Cannot build underground';
  if (r < gr - WORLD.maxBuildHeight || r < 0) return 'Too high (max ' + WORLD.maxBuildHeight + ' rows)';
  if (ctx.grid.has(key(c, r))) return 'Cell occupied';
  if (!ctx.settings.scouting && item === 'radar') return 'Scouting is disabled in this match';
  if (def.maxCount && ctx.ownBlocks.filter((b) => b.item === item).length >= def.maxCount) return `Only ${def.maxCount} allowed`;
  if (def.groundOnly && r !== gr - 1) return 'Must be placed on the ground';
  if (def.cost > ctx.remaining) return 'Not enough points';
  const above = ctx.grid.get(key(c, r - 1));
  if (def.needsClearAbove && above) return 'Needs open sky above';
  const below = ctx.grid.get(key(c, r + 1));
  if (below && ITEMS[below.item].needsClearAbove) return 'Would block the equipment below';
  const probe: Block = { id: -1, owner: ctx.seat, item, c, r, hp: 1, maxHp: 1, rot: 0, cooldown: 0 };
  ctx.grid.set(key(c, r), probe);
  const sup = computeSupported(ctx.grid, ctx.terrain);
  ctx.grid.delete(key(c, r));
  if (!sup.has(-1)) {
    if (def.span < 0) return 'Needs solid support directly below';
    return `Unsupported (span limit ${def.span})`;
  }
  return null;
}

/** Would removing the block at (c, r) leave any of the owner's other blocks unsupported? */
export function removalError(grid: Map<number, Block>, terrain: number[], ownBlocks: Block[], c: number, r: number): string | null {
  const b = grid.get(key(c, r));
  if (!b) return 'Nothing here';
  grid.delete(key(c, r));
  const sup = computeSupported(grid, terrain);
  grid.set(key(c, r), b);
  return ownBlocks.some((o) => o !== b && !sup.has(o.id)) ? 'Other blocks depend on this one' : null;
}
