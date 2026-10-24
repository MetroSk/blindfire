// AI-vs-AI balance probe: prints match length and winners for a batch of seeds.
import { Match } from '../shared/match';
import { aiBuild, aiChooseAction, newAIMemory } from '../shared/ai';
import { Rng } from '../shared/rng';
import { WEAPONS, CELL } from '../shared/config';
import { simulate } from '../shared/ballistics';
import type { Difficulty } from '../shared/types';

const flat = new Array(3600).fill(800.5);
for (const w of Object.values(WEAPONS)) {
  const r = simulate({ x: 0, y: 800, angleDeg: 45, speed: w.speedMax, dir: 1, wind: 0, weapon: w.id }, { terrain: flat, solidAt: () => null });
  console.log(w.id.padEnd(9), 'max range @45 ~', Math.round(r.end.x), 'px =', Math.round(r.end.x / CELL), 'cells');
}

const pairs: [Difficulty, Difficulty][] = [['hard', 'easy'], ['hard', 'medium'], ['medium', 'easy'], ['medium', 'medium']];
for (const [a, b] of pairs) {
  let wins = [0, 0, 0];
  let turns = 0;
  const N = Number(process.env.N) || 12;
  const reasons: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const m = Match.create({}, 1000 + i * 31);
    aiBuild(m, 0, a, new Rng(i));
    aiBuild(m, 1, b, new Rng(i + 500));
    const mems = [newAIMemory(), newAIMemory()];
    const rng = new Rng(i + 9);
    let g = 0;
    while (m.state.phase === 'combat' && g++ < 2000) {
      const s = m.state.active;
      const act = aiChooseAction(m.viewFor(s), mems[s], s === 0 ? a : b, rng);
      if (!m.apply(s, act).ok) m.apply(s, { t: 'endTurn' });
    }
    const w = m.state.winner;
    wins[w === 'draw' || w === null ? 2 : w]++;
    turns += m.state.turn;
    const key = m.state.winReason.replace(/^.*?: /, '').replace(/ \(.*\)$/, '');
    reasons[key] = (reasons[key] || 0) + 1;
  }
  console.log(`${a} vs ${b}: ${wins[0]}-${wins[1]} (draws ${wins[2]}), avg turns ${(turns / N).toFixed(1)}`, reasons);
}
