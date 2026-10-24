// End-to-end multiplayer test: two socket clients create/join a room, build, and fight to the finish.
// Usage: start the server (npm start), then: npm run test:mp [-- http://host:port]
import { io, type Socket } from 'socket.io-client';
import { aiChooseAction, newAIMemory } from '../shared/ai';
import { planBuildActions } from '../shared/botBuild';
import { Rng } from '../shared/rng';
import type { PlayerAction, PlayerView, ShotReport } from '../shared/types';

const URL = process.argv[2] || process.env.SERVER_URL || 'http://localhost:3001';
process.on('unhandledRejection', (e) => {
  console.error('FAILED (unhandled)', e);
  process.exit(1);
});

function call<T = any>(s: Socket, ev: string, payload: unknown): Promise<T> {
  return new Promise((res) => s.emit(ev, payload, res));
}

function bot(name: string, seedOff: number) {
  const s = io(URL, { transports: ['websocket'] });
  const mem = newAIMemory();
  const rng = new Rng(seedOff);
  let view: PlayerView | null = null;
  let built = false;
  let busy = false;
  let shotsSeen = 0;
  let leakChecked = true;
  const done = new Promise<PlayerView>((resolve) => {
    s.on('shot', (r: ShotReport) => {
      shotsSeen++;
      // the target must never learn the shooter's launch point
      if (r.viewer !== r.shooter && r.launch) leakChecked = false;
    });
    const tick = async () => {
      const v = view;
      if (!v || busy || v.phase === 'over') return;
      if (v.phase === 'build' && !built) {
        built = true;
        busy = true;
        for (const a of planBuildActions(v, 'medium', seedOff)) {
          const r = await call(s, 'action', a);
          if (!r.ok) console.log(name, 'build action rejected', a, r.error);
        }
        busy = false;
      } else if (v.phase === 'combat' && v.active === v.you) {
        busy = true;
        const act: PlayerAction = aiChooseAction(v, mem, 'medium', rng);
        if (process.env.DEBUG_MP) console.log(name, 'sending', JSON.stringify(act));
        const r = await call(s, 'action', act);
        if (process.env.DEBUG_MP) console.log(name, 'reply', JSON.stringify(r));
        if (!r.ok) await call(s, 'action', { t: 'endTurn' });
        busy = false;
      } else return;
      if (view !== v) tick(); // a newer view arrived while we were acting
    };
    s.on('view', (v: PlayerView) => {
      if (process.env.DEBUG_MP) console.log(Date.now() % 100000, name, 'view', v.phase, 'turn', v.turn, 'active', v.active, 'you', v.you, 'ready', v.own.ready, v.enemy.ready, 'busy', busy);
      view = v;
      if (v.enemy.blocks && v.phase !== 'over') leakChecked = false;
      if (v.phase === 'over') return resolve(v);
      tick();
    });
  });
  return { s, done, get view() { return view; }, get shots() { return shotsSeen; }, get clean() { return leakChecked; } };
}

async function main() {
  const t0 = Date.now();
  const a = bot('A', 11);
  const b = bot('B', 22);
  const connected = (s: Socket) => new Promise((r) => (s.connected ? r(null) : s.once('connect', () => r(null))));
  await connected(a.s);
  await connected(b.s);
  const created = await call(a.s, 'room:create', { name: 'Alpha', settings: { turnTime: 0, maxTurns: 60 } });
  console.log('created room', created.code);
  const bad = await call(b.s, 'room:join', { code: 'ZZZZZ', name: 'Bravo' });
  console.log('join wrong code ->', bad.error);
  const joined = await call(b.s, 'room:join', { code: created.code, name: 'Bravo' });
  console.log('joined', joined.ok, 'seat', joined.seat);
  // cheating attempt: acting out of turn / other player's weapon
  const cheat = await call(b.s, 'action', { t: 'fire', weaponId: 1, ammo: 'he', angle: 45, power: 50 });
  console.log('out-of-phase fire rejected ->', cheat.error);

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('match did not finish in time')), 180_000));
  const [va, vb] = (await Promise.race([Promise.all([a.done, b.done]), timeout])) as PlayerView[];
  console.log(`match over after turn ${va.turn}: winner seat ${va.winner} - ${va.winReason}`);
  console.log('A stats', va.own.stats);
  console.log('B stats', vb.own.stats);
  console.log('shot reports received A/B:', a.shots, b.shots, 'no hidden-info leaks:', a.clean && b.clean);
  console.log('end-of-match reveal present:', !!va.enemy.blocks && !!vb.enemy.blocks);

  // rematch
  const again = new Promise<PlayerView>((r) => a.s.on('view', (v: PlayerView) => v.phase === 'build' && r(v)));
  a.s.emit('rematch');
  b.s.emit('rematch');
  const rv = await Promise.race([again, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  console.log('rematch started:', !!rv);
  console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  a.s.close();
  b.s.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
