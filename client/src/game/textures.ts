import { CELL, ITEMS, type ItemId } from '../../../shared/config';

// Procedurally drawn, cached block textures (no image assets needed).
const S = 2; // supersampling
const cache = new Map<string, HTMLCanvasElement>();

function mk(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = CELL * S;
  const x = c.getContext('2d')!;
  x.scale(S, S);
  return [c, x];
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function bevel(x: CanvasRenderingContext2D, base: string) {
  const s = CELL;
  x.fillStyle = base;
  x.fillRect(0, 0, s, s);
  x.fillStyle = 'rgba(255,255,255,0.14)';
  x.fillRect(0, 0, s, 2);
  x.fillRect(0, 0, 2, s);
  x.fillStyle = 'rgba(0,0,0,0.28)';
  x.fillRect(0, s - 2, s, 2);
  x.fillRect(s - 2, 0, 2, s);
}

function rivets(x: CanvasRenderingContext2D, col: string) {
  x.fillStyle = col;
  for (const [a, b] of [[4, 4], [CELL - 5, 4], [4, CELL - 5], [CELL - 5, CELL - 5]]) {
    x.beginPath();
    x.arc(a, b, 1.3, 0, Math.PI * 2);
    x.fill();
  }
}

/** Base plate under equipment. */
function mount(x: CanvasRenderingContext2D, col: string) {
  x.fillStyle = shade(col, 0.6);
  x.fillRect(1, CELL - 8, CELL - 2, 8);
  x.fillStyle = shade(col, 0.9);
  x.fillRect(3, CELL - 12, CELL - 6, 5);
}

export function texture(item: ItemId, rot = 0, ghost = false): HTMLCanvasElement {
  const k = `${item}:${rot}:${ghost}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const [c, x] = mk();
  const def = ITEMS[item];
  const col = def.color;
  const s = CELL;
  switch (item) {
    case 'wood':
      bevel(x, col);
      x.strokeStyle = shade(col, 0.7);
      x.lineWidth = 1;
      for (let i = 6; i < s; i += 6) { x.beginPath(); x.moveTo(1, i); x.lineTo(s - 1, i); x.stroke(); }
      x.fillStyle = shade(col, 0.6);
      x.fillRect(8, 2, 1, 4); x.fillRect(15, 8, 1, 4); x.fillRect(6, 14, 1, 4);
      break;
    case 'stone':
      bevel(x, col);
      x.strokeStyle = shade(col, 0.65);
      x.lineWidth = 1;
      x.strokeRect(1.5, 1.5, s / 2 - 1, s / 2 - 2);
      x.strokeRect(s / 2 + 0.5, 1.5, s / 2 - 2, s / 2 - 2);
      x.strokeRect(1.5, s / 2 + 0.5, s - 3, s / 2 - 2);
      break;
    case 'steel':
      bevel(x, col);
      x.fillStyle = 'rgba(255,255,255,0.08)';
      x.fillRect(3, 3, s - 6, s - 6);
      rivets(x, shade(col, 1.5));
      break;
    case 'armor':
      bevel(x, col);
      x.strokeStyle = shade(col, 1.4);
      x.lineWidth = 2;
      x.beginPath(); x.moveTo(0, s * 0.35); x.lineTo(s * 0.35, 0); x.moveTo(0, s); x.lineTo(s, 0); x.moveTo(s * 0.65, s); x.lineTo(s, s * 0.65); x.stroke();
      rivets(x, shade(col, 0.5));
      break;
    case 'concrete':
      bevel(x, col);
      x.fillStyle = shade(col, 0.8);
      for (let i = 0; i < 14; i++) x.fillRect((i * 37) % (s - 3) + 1, (i * 53) % (s - 3) + 1, 1.5, 1.5);
      x.strokeStyle = shade(col, 0.75);
      x.strokeRect(2.5, 2.5, s - 5, s - 5);
      break;
    case 'foundation':
      bevel(x, col);
      x.strokeStyle = shade(col, 0.6);
      x.lineWidth = 1.5;
      for (let i = -s; i < s; i += 6) { x.beginPath(); x.moveTo(i, s); x.lineTo(i + s, 0); x.stroke(); }
      break;
    case 'sandbag':
      x.fillStyle = shade(col, 0.7);
      x.fillRect(0, s - 3, s, 3);
      for (let row = 0; row < 3; row++) {
        for (let i = 0; i < 2; i++) {
          const ox = row % 2 ? i * 12 - 6 : i * 12;
          x.fillStyle = shade(col, 1 - row * 0.05);
          x.beginPath();
          x.roundRect(ox + 1, s - 8 - row * 7, 11, 7, 3.5);
          x.fill();
          x.strokeStyle = shade(col, 0.6);
          x.stroke();
        }
      }
      break;
    case 'wedge': {
      x.fillStyle = col;
      const pts = [[[0, s], [s, s], [s, 0]], [[0, s], [s, s], [0, 0]], [[0, 0], [s, 0], [0, s]], [[0, 0], [s, 0], [s, s]]][rot & 3];
      x.beginPath();
      x.moveTo(pts[0][0], pts[0][1]);
      x.lineTo(pts[1][0], pts[1][1]);
      x.lineTo(pts[2][0], pts[2][1]);
      x.closePath();
      x.fill();
      x.strokeStyle = shade(col, 1.5);
      x.lineWidth = 2;
      x.stroke();
      break;
    }
    case 'core': {
      bevel(x, '#2a2b2e');
      const g = x.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
      g.addColorStop(0, '#fff2b0');
      g.addColorStop(0.4, col);
      g.addColorStop(1, '#6a4a10');
      x.fillStyle = g;
      x.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        x.lineTo(s / 2 + Math.cos(a) * 8.5, s / 2 + Math.sin(a) * 8.5);
      }
      x.closePath();
      x.fill();
      x.fillStyle = '#1a1a1a';
      x.font = 'bold 8px sans-serif';
      x.textAlign = 'center';
      x.fillText('HQ', s / 2, s / 2 + 3);
      break;
    }
    case 'mortar': case 'hmortar': case 'cannon': case 'howitzer': case 'rocket':
      mount(x, col);
      if (item === 'cannon' || item === 'howitzer') {
        x.fillStyle = '#222';
        x.beginPath(); x.arc(6, s - 4, 3.5, 0, Math.PI * 2); x.arc(s - 6, s - 4, 3.5, 0, Math.PI * 2); x.fill();
      }
      x.fillStyle = shade(col, 1.2);
      x.beginPath(); x.arc(s / 2, s - 11, item === 'hmortar' || item === 'howitzer' ? 6 : 5, Math.PI, 0); x.fill();
      break;
    case 'aa':
      mount(x, col);
      x.fillStyle = shade(col, 1.3);
      x.beginPath(); x.arc(s / 2, s - 11, 7, Math.PI, 0); x.fill();
      x.fillStyle = '#222';
      x.fillRect(s / 2 - 4, 2, 2, s - 12);
      x.fillRect(s / 2 + 2, 2, 2, s - 12);
      break;
    case 'radar':
      mount(x, col);
      x.strokeStyle = shade(col, 1.6);
      x.lineWidth = 2;
      x.beginPath(); x.moveTo(s / 2, s - 10); x.lineTo(s / 2, 9); x.stroke();
      x.fillStyle = shade(col, 1.4);
      x.beginPath(); x.ellipse(s / 2, 8, 9, 4, -0.4, 0, Math.PI); x.fill();
      x.fillStyle = '#9ef';
      x.fillRect(s / 2 - 1, 3, 2, 2);
      break;
    case 'decoy':
      mount(x, col);
      x.fillStyle = shade(col, 1.25);
      x.beginPath(); x.arc(s / 2, s - 11, 5, Math.PI, 0); x.fill();
      x.strokeStyle = shade(col, 1.25);
      x.lineWidth = 3;
      x.beginPath(); x.moveTo(s / 2, s - 12); x.lineTo(s - 3, 6); x.stroke();
      x.fillStyle = 'rgba(0,0,0,0.35)';
      x.font = 'bold 7px sans-serif';
      x.fillText('D', 3, 9);
      break;
    case 'repair':
      bevel(x, shade(col, 0.6));
      x.fillStyle = '#e8f5e9';
      x.fillRect(s / 2 - 2, 5, 4, s - 10);
      x.fillRect(5, s / 2 - 2, s - 10, 4);
      break;
    case 'crate':
      bevel(x, col);
      x.strokeStyle = shade(col, 0.6);
      x.lineWidth = 2;
      x.strokeRect(3, 3, s - 6, s - 6);
      x.beginPath(); x.moveTo(3, 3); x.lineTo(s - 3, s - 3); x.stroke();
      x.fillStyle = '#f5d76e';
      x.fillRect(s / 2 - 5, s / 2 - 2, 10, 4);
      break;
  }
  if (ghost) {
    x.globalCompositeOperation = 'destination-in';
    x.fillStyle = 'rgba(0,0,0,0.55)';
    x.fillRect(0, 0, s, s);
  }
  cache.set(k, c);
  return c;
}

/** Barrel geometry for drawing artillery pointing at the current elevation. */
export const BARREL: Partial<Record<ItemId, { len: number; w: number; col: string; tubes?: number }>> = {
  mortar: { len: 11, w: 4, col: '#3e4628' },
  hmortar: { len: 13, w: 6, col: '#353d22' },
  cannon: { len: 17, w: 3, col: '#2f3b3a' },
  howitzer: { len: 20, w: 4.5, col: '#2c3324' },
  rocket: { len: 13, w: 9, col: '#4a2c22', tubes: 3 },
};

export { shade };
