import { CELL, ITEMS, RULES } from './config';
import { terrainAt } from './terrain';
import type { Block, FallEvent } from './types';

export const key = (c: number, r: number) => c * 1000 + r;

export function buildGrid(blocks: Iterable<Block>): Map<number, Block> {
  const g = new Map<number, Block>();
  for (const b of blocks) g.set(key(b.c, b.r), b);
  return g;
}

export function isGrounded(b: { item: Block['item']; c: number; r: number }, terrain: number[]): boolean {
  if (b.item === 'foundation') return true; // anchored
  const surface = terrainAt(terrain, b.c * CELL + CELL / 2);
  return (b.r + 1) * CELL >= surface - 4;
}

/**
 * Support propagation (0-1 BFS):
 *  - grounded blocks have cantilever distance 0
 *  - a block resting on a supporting block inherits its distance
 *  - a block attached sideways to a structural block gets distance + 1, allowed up to its material span
 * Anything unreachable is unsupported and will collapse.
 */
export function computeSupported(grid: Map<number, Block>, terrain: number[]): Map<number, number> {
  const dist = new Map<number, number>(); // block id -> distance
  const deque: Block[] = [];
  for (const b of grid.values()) {
    if (isGrounded(b, terrain)) {
      dist.set(b.id, 0);
      deque.push(b);
    }
  }
  let head = 0;
  // Simple approach: since edge weights are 0/1 and spans are tiny, iterate a relaxation queue.
  while (head < deque.length) {
    const b = deque[head++];
    const d = dist.get(b.id)!;
    const def = ITEMS[b.item];
    // block above
    if (def.supportsAbove) {
      const a = grid.get(key(b.c, b.r - 1));
      if (a && (dist.get(a.id) ?? Infinity) > d) {
        dist.set(a.id, d);
        deque.push(a);
      }
    }
    // sideways
    if (def.span >= 0 && def.supportsAbove) {
      for (const dc of [-1, 1]) {
        const s = grid.get(key(b.c + dc, b.r));
        if (!s) continue;
        const sd = ITEMS[s.item].span;
        if (sd < 0) continue;
        const nd = d + 1;
        if (nd <= sd && (dist.get(s.id) ?? Infinity) > nd) {
          dist.set(s.id, nd);
          deque.push(s);
        }
      }
    }
  }
  return dist;
}

export interface CollapseResult {
  falls: FallEvent[];
  landings: { block: Block; amount: number }[];
  destroyed: Block[];
}

/**
 * Drops unsupported blocks straight down until they rest on something.
 * Blocks that cannot fall (wedged but unsupported) crumble.
 * Mutates the grid and block rows/hp. Destroyed blocks are removed from the grid.
 */
export function resolveCollapse(grid: Map<number, Block>, terrain: number[]): CollapseResult {
  const res: CollapseResult = { falls: [], landings: [], destroyed: [] };
  for (let iter = 0; iter < 40; iter++) {
    const sup = computeSupported(grid, terrain);
    const loose = [...grid.values()].filter((b) => !sup.has(b.id));
    if (loose.length === 0) break;
    loose.sort((a, b) => b.r - a.r); // lowest first
    for (const b of loose) {
      grid.delete(key(b.c, b.r));
      let r = b.r;
      let landedOn: Block | undefined;
      while (r < 80) {
        if (isGrounded({ item: b.item === 'foundation' ? 'stone' : b.item, c: b.c, r }, terrain)) break;
        const below = grid.get(key(b.c, r + 1));
        if (below) {
          landedOn = below;
          break;
        }
        r++;
      }
      const rows = r - b.r;
      const fromR = b.r;
      if (rows === 0 || r >= 80) {
        // crumbles in place
        b.hp = 0;
        res.destroyed.push(b);
        res.falls.push({ owner: b.owner, blockId: b.id, item: b.item, c: b.c, fromR, toR: fromR, destroyed: true });
        continue;
      }
      b.r = r;
      b.hp -= rows * RULES.fallDamagePerRow;
      if (landedOn) res.landings.push({ block: landedOn, amount: rows * RULES.landDamagePerRow });
      const destroyed = b.hp <= 0;
      res.falls.push({ owner: b.owner, blockId: b.id, item: b.item, c: b.c, fromR, toR: r, destroyed });
      if (destroyed) res.destroyed.push(b);
      else grid.set(key(b.c, b.r), b);
    }
  }
  return res;
}
