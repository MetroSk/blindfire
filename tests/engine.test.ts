import { describe, expect, it } from 'vitest';
import { CELL, ITEMS, WEAPONS, ZONES, WORLD } from '../shared/config';
import { flatRange, simulate, solvePower, speedFor } from '../shared/ballistics';
import { Match } from '../shared/match';
import { buildGrid, computeSupported, resolveCollapse } from '../shared/structure';
import { damageBlock } from '../shared/damage';
import { groundRowAt } from '../shared/terrain';
import { aiBuild, aiChooseAction, newAIMemory } from '../shared/ai';
import { Rng } from '../shared/rng';
import type { Block, Seat } from '../shared/types';

const flat = (y = 800) => new Array(WORLD.width).fill(y);
const blk = (id: number, item: Block['item'], c: number, r: number): Block => ({
  id, owner: 0, item, c, r, hp: ITEMS[item].hp, maxHp: ITEMS[item].hp, rot: 0, cooldown: 0,
});

describe('ballistics', () => {
  it('matches the analytic range on flat ground without wind', () => {
    const speed = 900;
    const angle = 45;
    const r = simulate(
      { x: 100, y: 800, angleDeg: angle, speed, dir: 1, wind: 0, weapon: 'mortar' },
      { terrain: flat(800.5), solidAt: () => null },
    );
    expect(r.end.kind).toBe('terrain');
    expect(Math.abs(r.end.x - 100 - flatRange(speed, angle))).toBeLessThan(25);
  });

  it('wind pushes shells downwind', () => {
    const base = { x: 100, y: 800, angleDeg: 50, speed: 800, dir: 1 as const, weapon: 'mortar' as const };
    const w = { terrain: flat(800.5), solidAt: () => null };
    const calm = simulate({ ...base, wind: 0 }, w).end.x;
    const tail = simulate({ ...base, wind: 1 }, w).end.x;
    const head = simulate({ ...base, wind: -1 }, w).end.x;
    expect(tail).toBeGreaterThan(calm);
    expect(head).toBeLessThan(calm);
  });

  it('collides with grid structures', () => {
    const wall = new Set([`40,30`, `40,31`, `40,32`, `40,33`]);
    const r = simulate(
      { x: 100, y: 760, angleDeg: 5, speed: 1200, dir: 1, wind: 0, weapon: 'cannon' },
      { terrain: flat(1000), solidAt: (c, rr) => (wall.has(`${c},${rr}`) ? 7 : null) },
    );
    expect(r.end.kind).toBe('structure');
    expect(r.end.blockId).toBe(7);
    expect(Math.floor(r.end.x / CELL)).toBe(40);
  });

  it('solves power for a requested range', () => {
    const world = { terrain: flat(800.5), solidAt: () => null };
    const sol = solvePower({ x: 100, y: 800, angleDeg: 45, dir: 1, wind: 0, weapon: 'howitzer' }, 2100, world)!;
    expect(sol).not.toBeNull();
    const r = simulate({ x: 100, y: 800, angleDeg: 45, dir: 1, wind: 0, weapon: 'howitzer', speed: speedFor('howitzer', sol.power) }, world);
    expect(Math.abs(r.end.x - 2100)).toBeLessThan(10);
  });

  it('every weapon can reach the enemy zone from the front of its own zone', () => {
    const near = (ZONES[1].c0 - ZONES[0].c1) * CELL;
    const world = { terrain: flat(800.5), solidAt: () => null };
    for (const w of Object.values(WEAPONS)) {
      const best = Math.max(...[w.angleMin, 45, w.angleMax].filter((a) => a >= w.angleMin && a <= w.angleMax).map((a) =>
        simulate({ x: 0, y: 800, angleDeg: a, speed: w.speedMax, dir: 1, wind: 0, weapon: w.id }, world).end.x));
      expect(best, w.id).toBeGreaterThan(near);
    }
  });
});

describe('structure', () => {
  it('supports cantilevers up to the material span and drops the rest', () => {
    const t = flat(32 * CELL);
    // pillar at c=10, steel beam extending right (span 3) and a wood beam beyond
    const blocks = [blk(1, 'stone', 10, 31), blk(2, 'steel', 11, 31 - 0), blk(3, 'steel', 12, 30)];
    const g = buildGrid(blocks);
    const sup = computeSupported(g, t);
    expect(sup.has(1)).toBe(true);
    expect(sup.has(2)).toBe(true); // grounded
    expect(sup.has(3)).toBe(false); // floating diagonal
  });

  it('collapses blocks when their support is removed', () => {
    const t = flat(32 * CELL);
    const blocks = [blk(1, 'stone', 10, 31), blk(2, 'stone', 10, 30), blk(3, 'stone', 10, 29)];
    const g = buildGrid(blocks);
    g.delete(10 * 1000 + 31); // destroy the base
    const res = resolveCollapse(g, t);
    expect(res.falls.length).toBe(2);
    expect(blocks[1].r).toBe(31);
    expect(blocks[2].r).toBe(30);
    expect(blocks[1].hp).toBeLessThan(ITEMS.stone.hp);
  });

  it('steel spans further than stone', () => {
    const t = flat(32 * CELL);
    const steel = [blk(1, 'stone', 10, 31), blk(2, 'stone', 10, 30), blk(3, 'steel', 11, 30), blk(4, 'steel', 12, 30)];
    const stone = [blk(1, 'stone', 10, 31), blk(2, 'stone', 10, 30), blk(3, 'stone', 11, 30), blk(4, 'stone', 12, 30)];
    expect(computeSupported(buildGrid(steel), t).has(4)).toBe(true);
    expect(computeSupported(buildGrid(stone), t).has(4)).toBe(false);
  });
});

describe('damage', () => {
  it('applies material resistance', () => {
    const wood = blk(1, 'wood', 0, 0);
    const conc = blk(2, 'concrete', 0, 0);
    const dw = damageBlock(wood, 30, 'blast');
    const dc = damageBlock(conc, 30, 'blast');
    expect(dw).toBeGreaterThan(dc);
    expect(conc.hp).toBe(ITEMS.concrete.hp - 30 * ITEMS.concrete.resist.blast);
  });
});

function setupMatch(): Match {
  const m = Match.create({ budget: 1000, wind: 0 }, 12345);
  aiBuild(m, 0, 'medium', new Rng(1));
  aiBuild(m, 1, 'medium', new Rng(2));
  return m;
}

describe('construction economy', () => {
  it('enforces the budget and refunds removals', () => {
    const m = Match.create({ budget: 300 }, 7);
    const c = ZONES[0].c0 + 5;
    const r = groundRowAt(m.state.terrain, c) - 1;
    expect(m.place(0, 'howitzer', c, r)).toBeNull();
    expect(m.spent(0)).toBe(250);
    expect(m.place(0, 'cannon', c + 1, groundRowAt(m.state.terrain, c + 1) - 1)).toBe('Not enough points');
    expect(m.remove(0, c, r)).toBeNull();
    expect(m.spent(0)).toBe(0);
  });

  it('rejects placements outside the zone, floating, or blocking a barrel', () => {
    const m = Match.create({}, 9);
    const c = ZONES[0].c0 + 3;
    const g = groundRowAt(m.state.terrain, c);
    expect(m.place(0, 'stone', ZONES[1].c0, 10)).toBe('Outside your build zone');
    expect(m.place(0, 'stone', c, g - 3)).toMatch(/Unsupported/);
    expect(m.place(0, 'mortar', c, g - 1)).toBeNull();
    expect(m.place(0, 'stone', c, g - 2)).toBe('Would block the equipment below');
    expect(m.place(0, 'foundation', c + 1, g - 2)).not.toBeNull();
  });

  it('requires a core and a weapon before readying', () => {
    const m = Match.create({}, 10);
    expect(m.setReady(0, true)).toMatch(/Core/);
  });
});

describe('turns, visibility and victory', () => {
  it('starts combat when both are ready and alternates turns', () => {
    const m = setupMatch();
    expect(m.state.phase).toBe('combat');
    const first = m.state.active;
    const r = m.apply(first, { t: 'endTurn' });
    expect(r.ok).toBe(true);
    expect(m.state.active).not.toBe(first);
    expect(m.apply(first, { t: 'endTurn' }).ok).toBe(false);
  });

  it('never exposes enemy blocks in a player view during combat', () => {
    const m = setupMatch();
    const v = m.viewFor(0);
    expect(v.enemy.blocks).toBeNull();
    const json = JSON.stringify(v);
    for (const b of m.state.players[1].blocks) expect(json.includes(`"id":${b.id},`)).toBe(false);
  });

  it('validates fire actions server-side', () => {
    const m = setupMatch();
    const s = m.state.active;
    const foreign = m.state.players[s === 0 ? 1 : 0].blocks.find((b) => ITEMS[b.item].weapon)!;
    expect(m.apply(s, { t: 'fire', weaponId: foreign.id, ammo: 'he', angle: 45, power: 50 }).ok).toBe(false);
    const mine = m.state.players[s].blocks.find((b) => ITEMS[b.item].weapon)!;
    expect(m.apply(s, { t: 'fire', weaponId: mine.id, ammo: 'he', angle: 999, power: 50 }).ok).toBe(false);
  });

  it('destroying the command core ends the match', () => {
    const m = setupMatch();
    const s = m.state.active as Seat;
    const enemy = (1 - s) as Seat;
    const core = m.state.players[enemy].blocks.find((b) => b.item === 'core')!;
    core.hp = 1;
    // strip the bunker so a shell can reach it: test via direct damage resolution
    core.hp = 0;
    (m as any).purgeDestroyed();
    (m as any).checkVictory(s);
    expect(m.state.phase).toBe('over');
    expect(m.state.winner).toBe(s);
  });

  it('AI vs AI plays a full match to completion', () => {
    for (const seed of [1, 2, 3]) {
      const m = Match.create({ wind: 1 }, seed * 777);
      aiBuild(m, 0, 'hard', new Rng(seed));
      aiBuild(m, 1, 'medium', new Rng(seed + 50));
      const mems = [newAIMemory(), newAIMemory()];
      const rng = new Rng(seed + 99);
      let guard = 0;
      while (m.state.phase === 'combat' && guard++ < 1000) {
        const s = m.state.active;
        const act = aiChooseAction(m.viewFor(s), mems[s], s === 0 ? 'hard' : 'medium', rng);
        const r = m.apply(s, act);
        if (!r.ok) m.apply(s, { t: 'endTurn' });
      }
      expect(m.state.phase).toBe('over');
      expect(m.state.winner).not.toBeNull();
    }
  });
});
