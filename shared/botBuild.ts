import { AMMO_ORDER } from './config';
import { Match } from './match';
import { aiBuild } from './ai';
import { Rng } from './rng';
import type { Difficulty, PlayerAction, PlayerView } from './types';

/**
 * Plans an AI base against a private sandbox copy of the visible terrain and returns the
 * equivalent list of player actions, so a remote bot can build through the normal server API.
 */
export function planBuildActions(view: PlayerView, diff: Difficulty, seed: number): PlayerAction[] {
  const sandbox = Match.create(view.settings, 1);
  sandbox.state.terrain = view.terrain.slice();
  aiBuild(sandbox, view.you, diff, new Rng(seed));
  const p = sandbox.state.players[view.you];
  const actions: PlayerAction[] = [...p.blocks]
    .sort((a, b) => a.id - b.id)
    .map((b) => ({ t: 'place', item: b.item, c: b.c, r: b.r, rot: b.rot }));
  for (const a of AMMO_ORDER) if (p.boughtAmmo[a] > 0) actions.push({ t: 'ammo', ammo: a, delta: p.boughtAmmo[a] });
  actions.push({ t: 'ready', ready: true });
  return actions;
}
