import { getPrefs } from '../prefs';

// Tiny WebAudio synth: no audio files needed.
let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(c: AudioContext) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

function vol() {
  return getPrefs().volume;
}

export const sfx = {
  /** Muzzle report. heavy: 0..1, distant attenuates (enemy fire heard from afar). */
  fire(heavy = 0.5, distant = false) {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    const n = noise(c);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(distant ? 500 : 1800 - heavy * 900, t);
    f.frequency.exponentialRampToValueAtTime(80, t + 0.5);
    const g = c.createGain();
    const v = vol() * (distant ? 0.25 : 0.7);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4 + heavy * 0.4);
    n.connect(f).connect(g).connect(c.destination);
    n.start(t);
    n.stop(t + 1);
    const o = c.createOscillator();
    o.frequency.setValueAtTime(120 - heavy * 50, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    const og = c.createGain();
    og.gain.setValueAtTime(v * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(og).connect(c.destination);
    o.start(t);
    o.stop(t + 0.4);
  },
  boom(size = 0.5, distant = false) {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    const n = noise(c);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(distant ? 300 : 900, t);
    f.frequency.exponentialRampToValueAtTime(40, t + 1.2);
    const g = c.createGain();
    const v = vol() * (distant ? 0.35 : 0.9) * (0.5 + size * 0.5);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8 + size);
    n.connect(f).connect(g).connect(c.destination);
    n.start(t);
    n.stop(t + 2.2);
  },
  whistle(duration = 1.2) {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1700, t);
    o.frequency.exponentialRampToValueAtTime(500, t + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol() * 0.08, t + duration * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + duration + 0.05);
  },
  click() {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(900, t);
    const g = c.createGain();
    g.gain.setValueAtTime(vol() * 0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.06);
  },
  place() {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    const n = noise(c);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 400;
    const g = c.createGain();
    g.gain.setValueAtTime(vol() * 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    n.connect(f).connect(g).connect(c.destination);
    n.start(t);
    n.stop(t + 0.1);
  },
  alert() {
    const c = ac();
    if (!c || vol() === 0) return;
    const t = c.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(660, t + i * 0.16);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.16);
      g.gain.exponentialRampToValueAtTime(vol() * 0.12, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.13);
      o.connect(g).connect(c.destination);
      o.start(t + i * 0.16);
      o.stop(t + i * 0.16 + 0.15);
    }
  },
};
