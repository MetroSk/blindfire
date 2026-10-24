import { AMMO, CELL, ITEMS, WEAPONS, WORLD, ZONES, type AmmoId, type ItemId } from '../../../shared/config';
import { simulate, speedFor } from '../../../shared/ballistics';
import { applyCrater, groundRowAt } from '../../../shared/terrain';
import { buildGrid, key } from '../../../shared/structure';
import { placementError, removalError } from '../../../shared/construction';
import { facing, muzzleOf, other } from '../../../shared/match';
import type { Block, PlayerView, ShotReport, Smoke } from '../../../shared/types';
import { BARREL, texture } from './textures';
import { sfx } from './sound';
import { getPrefs } from '../prefs';

export interface BuildState {
  item: ItemId | null;
  tool: 'place' | 'remove' | 'move';
  rot: number;
}

export interface AimState {
  weaponId: number | null;
  angle: number;
  power: number;
  ammo: AmmoId;
}

export interface HoverInfo {
  c: number;
  r: number;
  error: string | null;
  block: Block | null;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number;
  color: string; kind: 'spark' | 'smoke' | 'debris' | 'flash' | 'ring' | 'dust';
  rot?: number; vr?: number;
}

interface FlyingShell {
  points: [number, number][];
  idx: number;
  delay: number;
  done: boolean;
  trail: string;
  end: ShotReport['projectiles'][number]['end'];
  explosion: ShotReport['projectiles'][number]['explosion'];
  rocket: boolean;
}

interface Marker { x: number; y: number; kind: string; turn: number; label?: string }

const PLAYBACK = 60; // projectile path points per second (paths are sampled at 40/s)

export class BattleRenderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  view: PlayerView | null = null;
  private pendingView: PlayerView | null = null;
  private terrain: number[] = [];
  private terrainPath: Path2D | null = null;
  private own: Block[] = [];
  private foe: Block[] | null = null;
  private smoke: Smoke[] = [];
  private grid = new Map<number, Block>();

  cam = { x: 0, y: 200, zoom: 0.5 };
  private camTarget: { x: number; y: number } | null = null;
  private shake = 0;

  mode: 'build' | 'aim' | 'idle' = 'idle';
  build: BuildState = { item: 'stone', tool: 'place', rot: 0 };
  aim: AimState = { weaponId: null, angle: 45, power: 60, ammo: 'he' };
  aimTargetX: number | null = null;
  private preview: { points: [number, number][]; end: { x: number; y: number; kind: string } } | null = null;
  private previewKey = '';

  hover: HoverInfo | null = null;
  private dragging: { sx: number; sy: number; cx: number; cy: number; moved: boolean; build: boolean; button: number } | null = null;
  private lastPaintCell = '';
  private keys = new Set<string>();

  private shotQueue: ShotReport[] = [];
  private shells: FlyingShell[] = [];
  private current: ShotReport | null = null;
  private shotPhase: 'flying' | 'settle' | 'hold' = 'flying';
  private holdUntil = 0;
  private particles: Particle[] = [];
  private markers: Marker[] = [];
  showAllShots = false;

  onCell: (c: number, r: number, button: 'primary' | 'secondary', dragging: boolean) => void = () => {};
  onHover: (h: HoverInfo | null) => void = () => {};
  onTarget: (x: number) => void = () => {};
  onViewApplied: (v: PlayerView) => void = () => {};
  onShotStart: (r: ShotReport) => void = () => {};
  onShotDone: (r: ShotReport) => void = () => {};

  private raf = 0;
  private last = performance.now();
  private hills: number[] = [];
  private minimap: HTMLCanvasElement | null = null;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.bindInput();
    for (let i = 0; i < 64; i++) this.hills.push(Math.sin(i * 1.7) * 0.5 + Math.sin(i * 0.43) * 0.8 + Math.random() * 0.3);
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('resize', this.resize);
  }

  setMinimap(c: HTMLCanvasElement | null) {
    this.minimap = c;
    if (c) {
      c.onpointerdown = (e) => {
        const r = c.getBoundingClientRect();
        const wx = ((e.clientX - r.left) / r.width) * WORLD.width;
        this.centerOn(wx, this.cam.y + this.viewH() / 2);
      };
    }
  }

  // ------------------------------------------------------------- view state
  get animating() {
    return !!this.current || this.shotQueue.length > 0;
  }

  setView(v: PlayerView, force = false) {
    if (this.animating && !force) {
      this.pendingView = v;
      return;
    }
    this.applyView(v);
  }

  private applyView(v: PlayerView) {
    const first = !this.view || this.view.you !== v.you || (this.view.phase !== v.phase && v.phase === 'build');
    this.view = v;
    this.pendingView = null;
    this.terrain = v.terrain.slice();
    this.terrainPath = null;
    this.own = v.own.blocks.map((b) => ({ ...b }));
    this.foe = v.enemy.blocks ? v.enemy.blocks.map((b) => ({ ...b })) : null;
    this.smoke = v.smoke.map((s) => ({ ...s }));
    this.grid = buildGrid(this.own);
    this.rebuildMarkers();
    this.previewKey = '';
    if (first) this.focusOwnBase();
    this.onViewApplied(v);
  }

  private rebuildMarkers() {
    const v = this.view!;
    this.markers = [];
    const hist = this.showAllShots ? v.own.history : v.own.history.slice(-8);
    hist.forEach((h, i) => {
      h.ends.forEach((e) => this.markers.push({ x: e.x, y: e.y, kind: e.kind, turn: h.turn, label: String(v.own.history.length - hist.length + i + 1) }));
    });
  }

  focusOwnBase() {
    if (!this.view) return;
    const z = ZONES[this.view.you];
    const cx = ((z.c0 + z.c1 + 1) / 2) * CELL;
    const w = (z.c1 - z.c0 + 1) * CELL;
    const vw = this.canvas.width / this.dpr;
    // leave room for the side panel on wide screens
    const panel = vw > 640 ? Math.min(320, vw * 0.3) : 0;
    this.cam.zoom = Math.max(this.minZoom(), Math.min(1.6, ((vw - panel) * 0.8) / (w * 1.2)));
    const gy = WORLD.baseGroundRow * CELL;
    this.cam.x = cx - (panel + (vw - panel) / 2) / this.cam.zoom;
    this.cam.y = gy - this.viewH() * 0.62;
    this.clampCam();
  }

  overview() {
    this.cam.zoom = this.minZoom();
    this.cam.x = 0;
    this.cam.y = WORLD.height - this.viewH();
    this.clampCam();
  }

  centerOn(x: number, y: number) {
    this.cam.x = x - this.viewW() / 2;
    this.cam.y = y - this.viewH() / 2;
    this.clampCam();
  }

  private viewW() { return this.canvas.width / this.dpr / this.cam.zoom; }
  private viewH() { return this.canvas.height / this.dpr / this.cam.zoom; }
  private minZoom() { return (this.canvas.width / this.dpr) / WORLD.width; }

  private clampCam() {
    const z = this.cam.zoom;
    this.cam.zoom = Math.max(this.minZoom(), Math.min(2.5, z));
    const vw = this.viewW();
    const vh = this.viewH();
    this.cam.x = Math.max(-100, Math.min(WORLD.width - vw + 100, this.cam.x));
    this.cam.y = Math.max(-900, Math.min(WORLD.height - vh + 40, this.cam.y));
  }

  resize = () => {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.clampCam();
  };

  // ------------------------------------------------------------------ input
  private toWorld(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: this.cam.x + (e.clientX - r.left) / this.cam.zoom, y: this.cam.y + (e.clientY - r.top) / this.cam.zoom };
  }

  private keyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    this.keys.add(e.key.toLowerCase());
  };
  private keyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());

  private bindInput() {
    const c = this.canvas;
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e);
      this.cam.zoom *= Math.exp(-e.deltaY * 0.0012);
      this.clampCam();
      const after = this.toWorld(e);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
      this.clampCam();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const w = this.toWorld(e);
      const buildPaint = this.mode === 'build' && e.button === 0 && e.pointerType !== 'touch' && !e.altKey;
      this.dragging = { sx: e.clientX, sy: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false, build: buildPaint, button: e.button };
      if (this.mode === 'build' && e.button === 2) {
        this.onCell(Math.floor(w.x / CELL), Math.floor(w.y / CELL), 'secondary', false);
      } else if (buildPaint) {
        const ck = `${Math.floor(w.x / CELL)},${Math.floor(w.y / CELL)}`;
        this.lastPaintCell = ck;
        this.onCell(Math.floor(w.x / CELL), Math.floor(w.y / CELL), 'primary', false);
      } else if (this.mode === 'aim' && e.button === 0 && e.shiftKey) {
        this.aimTargetX = w.x;
        this.onTarget(w.x);
        this.dragging = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      const w = this.toWorld(e);
      this.updateHover(Math.floor(w.x / CELL), Math.floor(w.y / CELL));
      const d = this.dragging;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.build && this.build.tool !== 'move') {
        const ck = `${Math.floor(w.x / CELL)},${Math.floor(w.y / CELL)}`;
        if (ck !== this.lastPaintCell) {
          this.lastPaintCell = ck;
          this.onCell(Math.floor(w.x / CELL), Math.floor(w.y / CELL), 'primary', true);
        }
        return;
      }
      if (!d.build) {
        this.cam.x = d.cx - dx / this.cam.zoom;
        this.cam.y = d.cy - dy / this.cam.zoom;
        this.camTarget = null;
        this.clampCam();
      }
    });
    const up = (e: PointerEvent) => {
      const d = this.dragging;
      this.dragging = null;
      // a touch tap in build mode places a block
      if (d && !d.moved && e.pointerType === 'touch' && this.mode === 'build') {
        const w = this.toWorld(e);
        this.onCell(Math.floor(w.x / CELL), Math.floor(w.y / CELL), 'primary', false);
      }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover(null);
    });
  }

  refreshHover() {
    if (this.hover) this.updateHover(this.hover.c, this.hover.r);
  }

  private updateHover(c: number, r: number) {
    const v = this.view;
    if (!v) return;
    const block = this.grid.get(key(c, r)) ?? null;
    let error: string | null = null;
    if (this.mode === 'build') {
      if (this.build.tool === 'remove' || (this.build.tool === 'move' && !this.build.item)) {
        error = !block ? 'Nothing to remove' : removalError(this.grid, this.terrain, this.own, c, r);
      } else if (this.build.item) {
        error = v.own.ready ? 'Already finished building' : placementError({
          seat: v.you, terrain: this.terrain, settings: v.settings, grid: this.grid, ownBlocks: this.own,
          remaining: v.settings.budget - v.own.spent,
        }, this.build.item, c, r);
      }
    }
    const h = { c, r, error, block };
    const changed = !this.hover || this.hover.c !== c || this.hover.r !== r || this.hover.error !== error;
    this.hover = h;
    if (changed) this.onHover(h);
  }

  // ------------------------------------------------------------- animation
  queueShot(r: ShotReport) {
    this.shotQueue.push(r);
    if (!this.current) this.startNextShot();
  }

  private startNextShot() {
    const r = this.shotQueue.shift();
    if (!r) {
      this.current = null;
      if (this.pendingView) this.applyView(this.pendingView);
      return;
    }
    this.current = r;
    this.onShotStart(r);
    const mine = this.view ? r.shooter === this.view.you : true;
    const heavy = r.weaponItem === 'howitzer' || r.weaponItem === 'hmortar' ? 1 : r.weaponItem === 'rocket' ? 0.7 : 0.4;
    sfx.fire(heavy, !mine);
    const trail = r.weaponItem && ITEMS[r.weaponItem].weapon ? WEAPONS[ITEMS[r.weaponItem].weapon!].trail : '#fff';
    this.shells = r.projectiles.map((p, i) => ({
      points: p.points,
      idx: 0,
      // shells observed only on our half appear after a lag (they had to cross the field)
      delay: i * 0.12 + (mine || !p.points.length ? 0 : 1.1),
      done: p.points.length === 0,
      trail,
      end: p.end,
      explosion: p.explosion,
      rocket: r.weaponItem === 'rocket',
    }));
    if (mine && r.launch) {
      this.burst(r.launch.x, r.launch.y - 4, 'flash', 1, '#ffd27a', 14);
      this.burst(r.launch.x, r.launch.y - 4, 'smoke', 8, 'rgba(200,200,200,0.5)', 8);
      if (getPrefs().followShells) this.camTarget = { x: r.launch.x, y: r.launch.y };
    } else if (!mine && getPrefs().followShells) {
      const first = r.projectiles.find((p) => p.points.length);
      if (first) this.camTarget = { x: first.points[0][0], y: first.points[0][1] };
    }
    if (this.shells.some((s) => s.points.length > 20)) sfx.whistle(Math.min(3, this.shells[0].points.length / PLAYBACK));
    // shells we can't see at all: just a pause for the distant report
    if (this.shells.every((s) => s.done)) {
      this.shotPhase = 'settle';
      this.holdUntil = performance.now() + (mine ? 600 : 1300);
      for (const s of this.shells) if (s.explosion) this.explode(s);
    } else {
      this.shotPhase = 'flying';
      this.holdUntil = 0;
    }
  }

  private explode(s: FlyingShell) {
    const e = s.explosion;
    if (!e) return;
    const near = this.view ? Math.abs(e.x - (ZONES[this.view.you].c0 + 12) * CELL) < 1200 : true;
    if (e.type === 'smoke') {
      for (let i = 0; i < 26; i++) this.burst(e.x + (Math.random() - 0.5) * e.r, e.y - Math.random() * e.r * 0.6, 'smoke', 1, 'rgba(210,214,220,0.55)', 40);
      sfx.boom(0.2, !near);
      return;
    }
    if (e.type === 'recon') {
      this.burst(e.x, e.y, 'ring', 1, '#7fe3ff', e.r);
      this.burst(e.x, e.y - 30, 'flash', 1, '#bff3ff', 30);
      sfx.alert();
      return;
    }
    if (e.type === 'intercept') {
      this.burst(e.x, e.y, 'flash', 1, '#ffffff', 18);
      this.burst(e.x, e.y, 'spark', 14, '#ffd27a', 3);
      sfx.boom(0.2, !near);
      return;
    }
    const big = e.r / 50;
    this.burst(e.x, e.y, 'flash', 1, '#fff1c2', e.r * 1.2);
    this.burst(e.x, e.y, 'ring', 1, 'rgba(255,220,160,0.8)', e.r);
    this.burst(e.x, e.y, 'spark', Math.round(16 * big + 8), e.type === 'frag' ? '#ffe9a8' : '#ff9a3c', 3);
    this.burst(e.x, e.y, 'smoke', Math.round(10 * big + 6), 'rgba(70,64,58,0.7)', 16);
    this.burst(e.x, e.y, 'dust', Math.round(10 * big + 4), '#6d5b45', 3);
    this.shake = Math.min(14, 4 + e.r / 8) * (near ? 1 : 0.4);
    sfx.boom(Math.min(1, big), !near);
  }

  private finishShot() {
    const r = this.current!;
    // apply observed results to the displayed battlefield
    for (const cr of r.craters) {
      const y = this.terrain[Math.max(0, Math.min(this.terrain.length - 1, cr.x))];
      applyCrater(this.terrain, cr.x, y, cr.r);
    }
    this.terrainPath = null;
    const lists = [this.own, this.foe ?? []];
    for (const d of r.damage) {
      for (const list of lists) {
        const b = list.find((x) => x.id === d.blockId);
        if (!b) continue;
        b.hp = Math.max(0, b.hp - d.amount);
        if (d.destroyed) {
          b.hp = 0;
          const cx = b.c * CELL + CELL / 2;
          const cy = b.r * CELL + CELL / 2;
          this.burst(cx, cy, 'debris', 6, ITEMS[b.item].color, 4);
        }
      }
    }
    for (const f of r.falls) {
      for (const list of lists) {
        const b = list.find((x) => x.id === f.blockId);
        if (!b) continue;
        b.r = f.toR;
        if (f.destroyed) b.hp = 0;
        this.burst(b.c * CELL + CELL / 2, f.toR * CELL + CELL, 'dust', 5, '#8a7a62', 3);
      }
    }
    // known-enemy damage we may see (hit cells) flash briefly
    for (const s of r.secondary) {
      this.burst(s.x, s.y, 'flash', 1, '#ffe0a0', s.r * 1.4);
      this.burst(s.x, s.y, 'spark', 30, '#ffb347', 4);
      this.burst(s.x, s.y, 'smoke', 14, 'rgba(60,50,40,0.75)', 20);
      sfx.boom(1);
    }
    this.own = this.own.filter((b) => b.hp > 0);
    if (this.foe) this.foe = this.foe.filter((b) => b.hp > 0);
    this.grid = buildGrid(this.own);
    if (r.smoke && !this.smoke.some((s) => s.x === r.smoke!.x && s.y === r.smoke!.y)) this.smoke.push({ ...r.smoke });
    if (this.view && r.shooter === this.view.you)
      for (const p of r.projectiles) if (p.end.kind !== 'lost') this.markers.push({ x: p.end.x, y: p.end.y, kind: p.end.kind, turn: -1 });
    this.shotPhase = 'hold';
    this.holdUntil = performance.now() + 700;
  }

  private stepShots(dt: number) {
    if (!this.current) return;
    const now = performance.now();
    if (this.shotPhase !== 'flying') {
      if (now < this.holdUntil) return;
      if (this.shotPhase === 'settle') {
        this.finishShot(); // applies results and enters 'hold'
        return;
      }
      const r = this.current;
      this.current = null;
      this.onShotDone(r);
      this.startNextShot();
      return;
    }
    let active = false;
    for (const s of this.shells) {
      if (s.done) continue;
      if (s.delay > 0) {
        s.delay -= dt;
        active = true;
        continue;
      }
      s.idx += dt * PLAYBACK;
      const i = Math.floor(s.idx);
      if (i >= s.points.length - 1) {
        s.done = true;
        s.idx = s.points.length - 1;
        if (s.end.kind !== 'lost' && s.end.kind !== 'obscured') this.explode(s);
        else if (s.end.kind === 'obscured') this.burst(s.points[s.points.length - 1][0], s.points[s.points.length - 1][1], 'smoke', 4, 'rgba(200,200,200,0.4)', 12);
      } else {
        active = true;
        const [x, y] = s.points[i];
        if (s.rocket || Math.random() < 0.35) this.particles.push({ x, y, vx: 0, vy: -6, life: 0, max: s.rocket ? 0.9 : 0.5, size: s.rocket ? 4 : 2.5, color: 'rgba(220,220,220,0.35)', kind: 'smoke' });
        if (getPrefs().followShells && this.shells[0] === s) this.camTarget = { x, y };
      }
    }
    if (!active) {
      this.shotPhase = 'settle';
      this.holdUntil = now + 150;
    }
  }

  private burst(x: number, y: number, kind: Particle['kind'], n: number, color: string, size: number) {
    if (getPrefs().reducedMotion && (kind === 'spark' || kind === 'debris')) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = kind === 'spark' ? 120 + Math.random() * 260 : kind === 'debris' ? 80 + Math.random() * 180 : kind === 'dust' ? 40 + Math.random() * 120 : 10 + Math.random() * 30;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (kind === 'debris' || kind === 'dust' ? 160 : kind === 'smoke' ? 20 : 0),
        life: 0,
        max: kind === 'flash' ? 0.18 : kind === 'ring' ? 0.5 : kind === 'smoke' ? 1.6 + Math.random() * 1.6 : kind === 'spark' ? 0.4 + Math.random() * 0.4 : 1 + Math.random() * 0.6,
        size: kind === 'flash' || kind === 'ring' ? size : size * (0.6 + Math.random() * 0.8),
        color, kind, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
      });
    }
  }

  private stepParticles(dt: number) {
    const ps = this.particles;
    for (const p of ps) {
      p.life += dt;
      if (p.kind === 'debris' || p.kind === 'spark' || p.kind === 'dust') p.vy += WORLD.gravity * 0.9 * dt;
      if (p.kind === 'smoke') {
        p.vx *= 0.98;
        p.vy = p.vy * 0.98 - 8 * dt;
        p.vx += (this.view?.wind ?? 0) * 12 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot = (p.rot ?? 0) + (p.vr ?? 0) * dt;
      if ((p.kind === 'debris' || p.kind === 'dust') && this.terrain.length) {
        const ty = this.terrain[Math.max(0, Math.min(this.terrain.length - 1, Math.floor(p.x)))];
        if (p.y > ty) { p.y = ty; p.vy *= -0.3; p.vx *= 0.6; }
      }
    }
    this.particles = ps.filter((p) => p.life < p.max);
    if (this.particles.length > 1500) this.particles.splice(0, this.particles.length - 1500);
  }

  // ----------------------------------------------------------------- preview
  private computePreview() {
    const v = this.view;
    if (!v || this.mode !== 'aim' || this.aim.weaponId === null) {
      this.preview = null;
      return;
    }
    const k = `${this.aim.weaponId}:${this.aim.angle}:${this.aim.power}:${v.wind}:${this.own.length}:${this.terrainPath ? 1 : 0}`;
    if (k === this.previewKey) return;
    this.previewKey = k;
    const wb = this.own.find((b) => b.id === this.aim.weaponId);
    const wid = wb && ITEMS[wb.item].weapon;
    if (!wb || !wid) {
      this.preview = null;
      return;
    }
    const m = muzzleOf(wb);
    const sim = simulate(
      { x: m.x, y: m.y, angleDeg: this.aim.angle, speed: speedFor(wid, this.aim.power), dir: facing(v.you), wind: v.wind, weapon: wid },
      { terrain: this.terrain, solidAt: (c, r) => this.grid.get(key(c, r))?.id ?? null },
      { sampleEvery: 2 },
    );
    this.preview = { points: sim.points, end: sim.end };
  }

  previewInfo(): { range: number; endKind: string; x: number } | null {
    this.computePreview();
    const v = this.view;
    if (!this.preview || !v) return null;
    const wb = this.own.find((b) => b.id === this.aim.weaponId);
    if (!wb) return null;
    const m = muzzleOf(wb);
    return { range: Math.abs(this.preview.end.x - m.x), endKind: this.preview.end.kind, x: this.preview.end.x };
  }

  // ------------------------------------------------------------------- frame
  private frame = (t: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    // keyboard panning
    const pan = 700 * dt / this.cam.zoom;
    if (this.keys.has('a')) { this.cam.x -= pan; this.camTarget = null; }
    if (this.keys.has('d')) { this.cam.x += pan; this.camTarget = null; }
    if (this.keys.has('w')) { this.cam.y -= pan; this.camTarget = null; }
    if (this.keys.has('s')) { this.cam.y += pan; this.camTarget = null; }
    if (this.camTarget && !this.dragging) {
      const tx = this.camTarget.x - this.viewW() / 2;
      const ty = this.camTarget.y - this.viewH() * 0.55;
      this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 4);
      this.cam.y += (ty - this.cam.y) * Math.min(1, dt * 2.5);
    }
    this.clampCam();
    this.stepShots(dt);
    this.stepParticles(dt);
    this.shake *= Math.pow(0.02, dt);
    this.draw(t / 1000);
    if (this.minimap && Math.floor(t / 100) !== Math.floor((t - dt * 1000) / 100)) this.drawMinimap();
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(time: number) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const v = this.view;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#1b2430');
    sky.addColorStop(0.55, '#3a4450');
    sky.addColorStop(1, '#a7865a');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // distant ridges (parallax)
    this.drawParallax(ctx, W, H);

    const z = this.cam.zoom * this.dpr;
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(z, 0, 0, z, (-this.cam.x + sx) * z, (-this.cam.y + sy) * z);
    if (!v) return;

    const enemy = other(v.you);
    // build zone
    if (v.phase === 'build') this.drawBuildZone(ctx, v.you);
    // terrain
    this.drawTerrain(ctx);
    // enemy territory fog
    this.drawFog(ctx, enemy, time);
    // structures
    for (const b of this.own) this.drawBlock(ctx, b, v.you);
    if (this.foe) for (const b of this.foe) this.drawBlock(ctx, b, enemy);
    // intelligence overlays
    this.drawIntel(ctx, time);
    // smoke screens
    for (const s of this.smoke) {
      const g = ctx.createRadialGradient(s.x, s.y - s.r * 0.2, s.r * 0.1, s.x, s.y - s.r * 0.2, s.r);
      g.addColorStop(0, 'rgba(205,208,212,0.85)');
      g.addColorStop(0.7, 'rgba(190,194,200,0.55)');
      g.addColorStop(1, 'rgba(190,194,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y - s.r * 0.2, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // aim preview
    if (this.mode === 'aim' && !this.animating) this.drawPreview(ctx);
    // ghost
    if (this.mode === 'build' && this.hover) this.drawGhost(ctx);
    // projectiles
    this.drawShells(ctx);
    this.drawParticles(ctx);
  }

  private drawParallax(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const layers = [
      { k: 0.15, col: 'rgba(60,70,82,0.85)', amp: 0.13, base: 0.62 },
      { k: 0.3, col: 'rgba(48,55,62,0.95)', amp: 0.09, base: 0.7 },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      const off = this.cam.x * L.k * this.dpr;
      const yOff = (this.cam.y - 200) * L.k * 0.5 * this.dpr;
      for (let x = 0; x <= W; x += 16) {
        const u = (x + off) / (180 * this.dpr);
        const i = Math.floor(u);
        const f = u - i;
        const h0 = this.hills[((i % 64) + 64) % 64];
        const h1 = this.hills[(((i + 1) % 64) + 64) % 64];
        const h = h0 + (h1 - h0) * (f * f * (3 - 2 * f));
        ctx.lineTo(x, H * L.base - h * H * L.amp - yOff);
      }
      ctx.lineTo(W, H);
      ctx.fill();
    }
  }

  private drawBuildZone(ctx: CanvasRenderingContext2D, seat: 0 | 1) {
    const z = ZONES[seat];
    const x0 = z.c0 * CELL;
    const x1 = (z.c1 + 1) * CELL;
    const top = (WORLD.baseGroundRow - WORLD.maxBuildHeight - 2) * CELL;
    ctx.fillStyle = 'rgba(245,165,36,0.05)';
    ctx.fillRect(x0, top, x1 - x0, WORLD.baseGroundRow * CELL - top + CELL * 2);
    if (getPrefs().showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1 / this.cam.zoom;
      ctx.beginPath();
      for (let c = z.c0; c <= z.c1 + 1; c++) {
        const gr = c <= z.c1 ? groundRowAt(this.terrain, c) : groundRowAt(this.terrain, z.c1);
        ctx.moveTo(c * CELL, (gr - WORLD.maxBuildHeight) * CELL);
        ctx.lineTo(c * CELL, gr * CELL);
      }
      for (let r = WORLD.baseGroundRow - WORLD.maxBuildHeight - 2; r <= WORLD.baseGroundRow + 2; r++) {
        ctx.moveTo(x0, r * CELL);
        ctx.lineTo(x1, r * CELL);
      }
      ctx.stroke();
    }
    // height limit
    ctx.strokeStyle = 'rgba(245,165,36,0.45)';
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2 / this.cam.zoom;
    ctx.beginPath();
    for (let c = z.c0; c <= z.c1; c++) {
      const y = (groundRowAt(this.terrain, c) - WORLD.maxBuildHeight) * CELL;
      ctx.moveTo(c * CELL, y);
      ctx.lineTo((c + 1) * CELL, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245,165,36,0.8)';
    ctx.font = `600 ${14}px "Chakra Petch", sans-serif`;
    ctx.fillText('YOUR BUILD ZONE', x0 + 6, top + 6);
  }

  private drawTerrain(ctx: CanvasRenderingContext2D) {
    if (!this.terrainPath) {
      const p = new Path2D();
      p.moveTo(0, WORLD.height + 400);
      for (let x = 0; x < this.terrain.length; x += 2) p.lineTo(x, this.terrain[x]);
      p.lineTo(WORLD.width, this.terrain[this.terrain.length - 1]);
      p.lineTo(WORLD.width, WORLD.height + 400);
      p.closePath();
      this.terrainPath = p;
    }
    const g = ctx.createLinearGradient(0, 500, 0, WORLD.height + 200);
    g.addColorStop(0, '#5b4a36');
    g.addColorStop(0.35, '#4a3b2b');
    g.addColorStop(1, '#2a2119');
    ctx.fillStyle = g;
    ctx.fill(this.terrainPath);
    // strata
    ctx.save();
    ctx.clip(this.terrainPath);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 6;
    for (let y = 640; y < WORLD.height + 200; y += 46) {
      ctx.beginPath();
      for (let x = 0; x <= WORLD.width; x += 60) ctx.lineTo(x, y + Math.sin(x * 0.004 + y) * 10);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = '#6f7d3c';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x < this.terrain.length; x += 2) ctx.lineTo(x, this.terrain[x] + 1);
    ctx.stroke();
  }

  private drawFog(ctx: CanvasRenderingContext2D, enemy: 0 | 1, time: number) {
    const z = ZONES[enemy];
    const x0 = z.c0 * CELL - 30;
    const x1 = (z.c1 + 1) * CELL + 30;
    const top = (WORLD.baseGroundRow - WORLD.maxBuildHeight - 3) * CELL;
    const revealed = !!this.foe;
    ctx.save();
    const g = ctx.createLinearGradient(0, top - 120, 0, WORLD.baseGroundRow * CELL + 30);
    g.addColorStop(0, 'rgba(20,24,29,0)');
    g.addColorStop(0.25, revealed ? 'rgba(20,24,29,0.15)' : 'rgba(20,24,29,0.62)');
    g.addColorStop(1, revealed ? 'rgba(20,24,29,0.15)' : 'rgba(20,24,29,0.8)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, top - 120, x1 - x0, WORLD.baseGroundRow * CELL - top + 160);
    if (!revealed) {
      ctx.strokeStyle = 'rgba(255,90,70,0.08)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      const off = (time * 10) % 40;
      for (let x = x0 - 400 + off; x < x1; x += 40) {
        ctx.moveTo(x, WORLD.baseGroundRow * CELL + 30);
        ctx.lineTo(x + 400, top - 120 + 0);
      }
      ctx.rect(x0, top - 120, x1 - x0, WORLD.baseGroundRow * CELL - top + 160);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,120,100,0.55)';
      ctx.font = `600 ${18}px "Chakra Petch", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('ENEMY TERRITORY · POSITIONS UNKNOWN', (x0 + x1) / 2, top - 60);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  private drawBlock(ctx: CanvasRenderingContext2D, b: Block, owner: 0 | 1) {
    const x = b.c * CELL;
    const y = b.r * CELL;
    const def = ITEMS[b.item];
    const v = this.view!;
    const isEnemy = owner !== v.you;
    ctx.drawImage(texture(b.item, b.rot), x, y, CELL, CELL);
    const br = BARREL[b.item];
    if (br) {
      const angle = !isEnemy && b.id === this.aim.weaponId ? this.aim.angle : (WEAPONS[def.weapon!].angleMin + WEAPONS[def.weapon!].angleMax) / 2;
      const a = (angle * Math.PI) / 180;
      const dir = facing(owner);
      ctx.save();
      ctx.translate(x + CELL / 2, y + CELL - 11);
      ctx.rotate(dir === 1 ? -a : Math.PI + a);
      ctx.fillStyle = br.col;
      if (br.tubes) {
        for (let i = 0; i < br.tubes; i++) ctx.fillRect(0, -br.w / 2 + i * 3, br.len, 2.4);
      } else ctx.fillRect(0, -br.w / 2, br.len, br.w);
      ctx.restore();
    }
    // damage
    if (b.hp < b.maxHp) {
      const k = 1 - b.hp / b.maxHp;
      ctx.fillStyle = `rgba(0,0,0,${k * 0.55})`;
      ctx.fillRect(x, y, CELL, CELL);
      if (k > 0.3) {
        ctx.strokeStyle = `rgba(20,10,0,${0.5 + k * 0.4})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x + 4, y + 3); ctx.lineTo(x + 10, y + 11); ctx.lineTo(x + 8, y + 18);
        if (k > 0.6) { ctx.moveTo(x + 20, y + 4); ctx.lineTo(x + 14, y + 12); ctx.lineTo(x + 19, y + 21); }
        ctx.stroke();
      }
    }
    if (!isEnemy && v.phase === 'combat' && def.weapon) {
      const blocked = this.grid.has(key(b.c, b.r - 1));
      const reload = v.active === v.you ? b.cooldown : b.cooldown - 1; // cooldown ticks down at the start of our turn
      const status = blocked ? '#ff5a46' : reload > 0 ? '#f5a524' : v.firedThisTurn.includes(b.id) ? '#888' : '#6fdc8c';
      ctx.fillStyle = status;
      ctx.fillRect(x + 1, y - 4, CELL - 2, 2.5);
      if (b.id === this.aim.weaponId) {
        ctx.strokeStyle = '#f5a524';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 1.5, y - 1.5, CELL + 3, CELL + 3);
      }
    }
  }

  private drawIntel(ctx: CanvasRenderingContext2D, time: number) {
    const v = this.view!;
    // known enemy cells
    if (!this.foe) {
      for (const k of v.enemy.known) {
        const x = k.c * CELL;
        const y = k.r * CELL;
        const age = v.turn - k.turn;
        const a = Math.max(0.45, 1 - age * 0.05);
        if (k.kind === 'destroyed') {
          ctx.strokeStyle = `rgba(160,160,160,${a})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(x + 5, y + 5); ctx.lineTo(x + CELL - 5, y + CELL - 5); ctx.moveTo(x + CELL - 5, y + 5); ctx.lineTo(x + 5, y + CELL - 5); ctx.stroke();
          continue;
        }
        const col = k.kind === 'core' ? '255,210,60' : k.kind === 'weapon' ? '255,120,80' : '255,80,70';
        ctx.fillStyle = `rgba(${col},${0.22 * a})`;
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = `rgba(${col},${0.9 * a})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
        ctx.fillStyle = `rgba(${col},${a})`;
        ctx.font = 'bold 13px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(k.kind === 'core' ? '★' : k.kind === 'weapon' ? '⌖' : '?', x + CELL / 2, y + CELL / 2 + 5);
        ctx.textAlign = 'left';
      }
    }
    // radar detections
    for (const d of v.enemy.detections) {
      const age = v.turn - d.turn;
      const a = Math.max(0.2, 1 - age / 7);
      const pulse = 1 + Math.sin(time * 4) * 0.15;
      ctx.strokeStyle = `rgba(255,90,70,${a})`;
      ctx.fillStyle = `rgba(255,90,70,${a * 0.15})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, 70 * pulse, 26 * pulse, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = `rgba(255,140,120,${a})`;
      ctx.font = '600 12px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('LAUNCH SIGNATURE?', d.x, d.y - 32);
      ctx.textAlign = 'left';
    }
    // observed incoming paths
    const inc = v.own.incoming.slice(-2);
    inc.forEach((o, i) => {
      ctx.strokeStyle = `rgba(255,90,70,${i === inc.length - 1 ? 0.45 : 0.2})`;
      ctx.setLineDash([6, 8]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [x, y] of o.points) ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
    });
    // impact markers of our own shots
    for (const m of this.markers) {
      const col = m.kind === 'structure' ? '#ffb347' : m.kind === 'intercepted' ? '#7fe3ff' : m.kind === 'obscured' ? '#aaa' : '#f2efe6';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      const s = 6;
      ctx.beginPath();
      ctx.moveTo(m.x - s, m.y - s); ctx.lineTo(m.x + s, m.y + s);
      ctx.moveTo(m.x + s, m.y - s); ctx.lineTo(m.x - s, m.y + s);
      ctx.stroke();
      if (m.label) {
        ctx.fillStyle = col;
        ctx.font = '600 11px "Chakra Petch", sans-serif';
        ctx.fillText(m.label, m.x + 7, m.y - 7);
      }
      if (m.kind === 'structure') {
        ctx.beginPath();
        ctx.arc(m.x, m.y, 11, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (this.aimTargetX !== null && this.mode === 'aim') {
      const x = this.aimTargetX;
      const y = this.terrain[Math.max(0, Math.min(this.terrain.length - 1, Math.round(x)))];
      ctx.strokeStyle = '#7fe3ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - 60); ctx.lineTo(x, y + 4);
      ctx.moveTo(x - 10, y - 50); ctx.lineTo(x + 10, y - 50);
      ctx.stroke();
    }
  }

  private drawPreview(ctx: CanvasRenderingContext2D) {
    this.computePreview();
    const p = this.preview;
    if (!p) return;
    ctx.strokeStyle = 'rgba(245,165,36,0.9)';
    ctx.lineWidth = 2 / this.cam.zoom;
    ctx.setLineDash([10 / this.cam.zoom, 8 / this.cam.zoom]);
    ctx.beginPath();
    for (const [x, y] of p.points) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const e = p.end;
    const wb = this.own.find((b) => b.id === this.aim.weaponId);
    const wid = wb && ITEMS[wb.item].weapon;
    const radius = wid ? WEAPONS[wid].radius * (AMMO[this.aim.ammo].radiusMul || 0.5) : 30;
    ctx.strokeStyle = e.kind === 'structure' ? '#ff5a46' : '#f5a524';
    ctx.fillStyle = e.kind === 'structure' ? 'rgba(255,90,70,0.15)' : 'rgba(245,165,36,0.12)';
    ctx.beginPath();
    ctx.arc(e.x, e.y, Math.max(12, radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffe1a8';
    ctx.font = `600 ${13 / Math.max(0.6, this.cam.zoom)}px "Chakra Petch", sans-serif`;
    ctx.textAlign = 'center';
    const label = e.kind === 'structure' ? 'BLOCKED BY YOUR OWN BASE' : e.kind === 'lost' ? 'OUT OF BOUNDS' : 'EST. IMPACT';
    ctx.fillText(label, e.x, e.y - Math.max(16, radius) - 6);
    ctx.textAlign = 'left';
  }

  private drawGhost(ctx: CanvasRenderingContext2D) {
    const h = this.hover!;
    const x = h.c * CELL;
    const y = h.r * CELL;
    if (this.build.tool === 'remove' || (this.build.tool === 'move' && !this.build.item)) {
      if (!h.block) return;
      ctx.strokeStyle = h.error ? '#ff5a46' : '#ff9a3c';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
      ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + CELL - 4, y + CELL - 4); ctx.moveTo(x + CELL - 4, y + 4); ctx.lineTo(x + 4, y + CELL - 4); ctx.stroke();
      return;
    }
    if (!this.build.item) return;
    ctx.globalAlpha = 0.75;
    ctx.drawImage(texture(this.build.item, this.build.rot), x, y, CELL, CELL);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = h.error ? '#ff5a46' : '#6fdc8c';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, CELL - 2, CELL - 2);
    if (h.error) {
      ctx.fillStyle = 'rgba(255,90,70,0.25)';
      ctx.fillRect(x, y, CELL, CELL);
    }
  }

  private drawShells(ctx: CanvasRenderingContext2D) {
    for (const s of this.shells) {
      if (s.delay > 0 || !s.points.length) continue;
      const i = Math.min(s.points.length - 1, Math.floor(s.idx));
      const t0 = Math.max(0, i - 40);
      ctx.strokeStyle = s.trail;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let k = t0; k <= i; k++) ctx.lineTo(s.points[k][0], s.points[k][1]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (!s.done) {
        const [x, y] = s.points[i];
        ctx.fillStyle = s.rocket ? '#ffb070' : '#fff6d8';
        ctx.beginPath();
        ctx.arc(x, y, s.rocket ? 4 : 3.2, 0, Math.PI * 2);
        ctx.fill();
        if (s.rocket) {
          ctx.fillStyle = 'rgba(255,140,60,0.6)';
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      const k = p.life / p.max;
      switch (p.kind) {
        case 'flash': {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          g.addColorStop(0, `rgba(255,255,240,${1 - k})`);
          g.addColorStop(0.4, `rgba(255,190,90,${0.8 * (1 - k)})`);
          g.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = 1 - k;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.3 + k * 0.9), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        case 'smoke':
          ctx.fillStyle = p.color;
          ctx.globalAlpha = (1 - k) * 0.9;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 + k * 1.8), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        case 'spark':
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = 1 - k;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
          ctx.stroke();
          ctx.globalAlpha = 1;
          break;
        default:
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot ?? 0);
          ctx.globalAlpha = 1 - k * k;
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
      }
    }
  }

  private drawMinimap() {
    const m = this.minimap!;
    const c = m.getContext('2d')!;
    const w = m.width;
    const h = m.height;
    const sx = w / WORLD.width;
    const top = 350;
    const sy = h / (WORLD.height - top);
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(16,20,25,0.9)';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#4a3b2b';
    c.beginPath();
    c.moveTo(0, h);
    for (let x = 0; x < this.terrain.length; x += 12) c.lineTo(x * sx, (this.terrain[x] - top) * sy);
    c.lineTo(w, h);
    c.fill();
    const v = this.view;
    if (v) {
      c.fillStyle = 'rgba(255,90,70,0.18)';
      const ez = ZONES[other(v.you)];
      c.fillRect(ez.c0 * CELL * sx, 0, (ez.c1 - ez.c0 + 1) * CELL * sx, h);
      c.fillStyle = '#7fd0ff';
      for (const b of this.own) c.fillRect(b.c * CELL * sx, (b.r * CELL - top) * sy, Math.max(1.5, CELL * sx), Math.max(1.5, CELL * sy));
      c.fillStyle = '#ff6a50';
      if (this.foe) for (const b of this.foe) c.fillRect(b.c * CELL * sx, (b.r * CELL - top) * sy, Math.max(1.5, CELL * sx), Math.max(1.5, CELL * sy));
      else for (const k of v.enemy.known) if (k.kind !== 'destroyed') c.fillRect(k.c * CELL * sx, (k.r * CELL - top) * sy, 2, 2);
      c.fillStyle = '#ffb347';
      for (const mk of this.markers) c.fillRect(mk.x * sx - 1, (mk.y - top) * sy - 1, 2, 2);
    }
    c.strokeStyle = '#f5a524';
    c.lineWidth = 1;
    c.strokeRect(this.cam.x * sx, (this.cam.y - top) * sy, this.viewW() * sx, this.viewH() * sy);
  }

  setShowAllShots(on: boolean) {
    this.showAllShots = on;
    if (this.view) this.rebuildMarkers();
  }
}
