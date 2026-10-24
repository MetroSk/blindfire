// Small deterministic PRNG (mulberry32). State is a single uint32 so it can be serialized.
export class Rng {
  constructor(public state: number) {
    this.state = state >>> 0;
  }
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  /** Approximate standard normal (sum of uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
