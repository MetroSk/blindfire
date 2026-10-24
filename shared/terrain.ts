import { CELL, WORLD, ZONES } from './config';
import { Rng } from './rng';

/** Terrain is a heightmap: terrain[x] = y of the ground surface at world pixel column x. */
export function generateTerrain(rng: Rng): number[] {
  const W = WORLD.width;
  const t = new Array<number>(W);
  const base = WORLD.baseGroundRow * CELL;
  const waves = Array.from({ length: 5 }, (_, i) => ({
    amp: rng.range(18, 60) / (i * 0.6 + 1),
    freq: (i + 1) * rng.range(0.7, 1.3) * ((2 * Math.PI) / W) * 2,
    phase: rng.range(0, Math.PI * 2),
  }));
  const ridgeX = W / 2 + rng.range(-250, 250);
  const ridgeH = rng.range(160, 280);
  const ridgeW = rng.range(260, 420);
  const valleyOffset = rng.range(600, 850);
  for (let x = 0; x < W; x++) {
    let y = base;
    for (const w of waves) y += Math.sin(x * w.freq + w.phase) * w.amp;
    // central ridge blocks flat cannon shots
    y -= ridgeH * Math.exp(-(((x - ridgeX) / ridgeW) ** 2));
    // valleys either side of the ridge
    y += 70 * Math.exp(-(((x - (ridgeX - valleyOffset)) / 220) ** 2));
    y += 70 * Math.exp(-(((x - (ridgeX + valleyOffset)) / 220) ** 2));
    t[x] = y;
  }
  // Flatten build zones into grid-aligned steps.
  for (const z of ZONES) {
    const stepCol = rng.int(z.c0 + 6, z.c1 - 6);
    const rowA = WORLD.baseGroundRow + rng.int(-1, 1);
    const rowB = rowA + rng.pick([-1, 0, 1]);
    const x0 = z.c0 * CELL;
    const x1 = (z.c1 + 1) * CELL;
    for (let c = z.c0; c <= z.c1; c++) {
      const row = c < stepCol ? rowA : rowB;
      for (let x = c * CELL; x < (c + 1) * CELL; x++) t[x] = row * CELL;
    }
    // blend edges
    const blend = 140;
    for (let i = 1; i <= blend; i++) {
      const k = i / blend;
      const s = k * k * (3 - 2 * k);
      const xl = x0 - i;
      const xr = x1 - 1 + i;
      if (xl >= 0) t[xl] = t[x0] * (1 - s) + t[xl] * s;
      if (xr < W) t[xr] = t[x1 - 1] * (1 - s) + t[xr] * s;
    }
    // edges of the map
    if (x0 - blend <= 0) for (let x = 0; x < x0; x++) t[x] = Math.min(t[x], t[x0]);
    if (x1 + blend >= W) for (let x = x1; x < W; x++) t[x] = Math.min(t[x], t[x1 - 1]);
  }
  return t.map((v) => Math.round(Math.max(300, Math.min(WORLD.height - 60, v)) * 10) / 10);
}

export function terrainAt(terrain: number[], x: number): number {
  const xi = Math.floor(x);
  if (xi < 0 || xi >= terrain.length) return Infinity;
  return terrain[xi];
}

/** Lowers the ground in a circular crater. Returns true if anything changed. */
export function applyCrater(terrain: number[], cx: number, cy: number, r: number): boolean {
  let changed = false;
  const floor = WORLD.height - 30;
  for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(terrain.length - 1, Math.ceil(cx + r)); x++) {
    const dx = x - cx;
    const dy = Math.sqrt(Math.max(0, r * r - dx * dx));
    const bottom = cy + dy;
    const top = cy - dy;
    // Only remove earth that intersects the circle and is below its top edge
    if (terrain[x] < bottom && terrain[x] >= top - 1) {
      terrain[x] = Math.min(floor, Math.round(bottom * 10) / 10);
      changed = true;
    } else if (terrain[x] < top && bottom > terrain[x]) {
      // circle fully below surface: shell buried, push surface down a little
      const sag = Math.min(r * 0.3, bottom - terrain[x]) * (1 - Math.abs(dx) / r);
      if (sag > 0.5) {
        terrain[x] = Math.min(floor, terrain[x] + sag);
        changed = true;
      }
    }
  }
  return changed;
}

/** Ground row for a grid column (first row whose top is at/below the surface). */
export function groundRowAt(terrain: number[], c: number): number {
  const y = terrainAt(terrain, c * CELL + CELL / 2);
  return Math.floor((y + 4) / CELL);
}
