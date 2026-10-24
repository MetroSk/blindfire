// Traces one AI-vs-AI match, printing every shot.
import { Match } from '../shared/match';
import { aiBuild, aiChooseAction, newAIMemory } from '../shared/ai';
import { Rng } from '../shared/rng';
import { CELL, ITEMS } from '../shared/config';
import type { Difficulty } from '../shared/types';

const [a, b] = (process.argv.slice(2) as Difficulty[]).concat(['hard', 'medium']).slice(0, 2) as Difficulty[];
const seed = 1000;
const m = Match.create({}, seed);
aiBuild(m, 0, a, new Rng(1));
aiBuild(m, 1, b, new Rng(501));
for (const s of [0, 1] as const) {
  const p = m.state.players[s];
  console.log(`P${s} (${s ? b : a}) spent ${m.spent(s)} blocks ${p.blocks.length} ammo`, p.ammo,
    p.blocks.filter((x) => ITEMS[x.item].weapon || x.item === 'core').map((x) => `${x.item}@${x.c},${x.r}`).join(' '));
}
const mems = [newAIMemory(), newAIMemory()];
const rng = new Rng(9);
while (m.state.phase === 'combat') {
  const s = m.state.active;
  const v = m.viewFor(s);
  const act = aiChooseAction(v, mems[s], s === 0 ? a : b, rng);
  const r = m.apply(s, act);
  if (act.t === 'fire') {
    const sh = r.shot;
    const tx = mems[s].lastPlan?.targetX;
    console.log(`T${v.turn} P${s} ${act.ammo} a=${act.angle} p=${act.power} target=${tx?.toFixed(0)}`, r.ok ? sh!.projectiles.map((p) => `${p.end.kind}@${(p.end.x / CELL).toFixed(1)}`).join(',') + ` dmg=${sh!.damage.filter((d) => d.owner !== s).reduce((q, d) => q + d.amount, 0).toFixed(0)}` : r.error);
  } else {
    console.log(`T${v.turn} P${s} endTurn`);
  }
  if (!r.ok) m.apply(s, { t: 'endTurn' });
}
console.log(m.state.winner, m.state.winReason, m.state.players.map((p) => p.stats));
