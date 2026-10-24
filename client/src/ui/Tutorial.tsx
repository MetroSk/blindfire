import { useEffect, useRef } from 'react';
import { ITEMS } from '../../../shared/config';
import type { PlayerView } from '../../../shared/types';

interface Step {
  title: string;
  body: string;
  /** Auto-advance when true. Steps without a check show a Next button. */
  check?: (v: PlayerView, ctx: { angle: number; power: number; start: { angle: number; power: number } }) => boolean;
  where?: 'left' | 'center' | 'top';
}

const STEPS: Step[] = [
  { title: 'Welcome, Commander', body: 'BLINDFIRE is an artillery duel with hidden bases. You will build a fortified base on a points budget, then try to find and destroy an enemy you cannot see. Let\'s build first.', where: 'center' },
  { title: '1 · Place your Command Core', body: 'Open the Utility tab and pick the Command Core (free). Click a ground cell inside your highlighted build zone. If the core is destroyed you lose, so choose a spot you can protect.', check: (v) => v.own.blocks.some((b) => b.item === 'core') },
  { title: '2 · Protect it', body: 'Place at least 4 blocks around and on top of the core. Blocks must rest on the ground or on other blocks. Steel spans 3 cells sideways, stone only 1, so overhangs need strong materials. Click and drag to paint.', check: (v) => v.own.blocks.filter((b) => !ITEMS[b.item].weapon && b.item !== 'core').length >= 4 },
  { title: 'The point economy', body: 'Everything costs points: cheap wood burns fast, concrete shrugs off blasts, armor resists HE but not armor-piercing rounds. Spend too much on walls and you have no guns; spend too much on guns and you are easy to crack. Hover any item for its stats.', where: 'left' },
  { title: '3 · Add artillery', body: 'Open the Weapons tab and place a Light Mortar. Weapons need solid ground or a block below and open sky above to fire. Mortars are short-ranged, so build them toward the front (right side) of your zone.', check: (v) => v.own.blocks.some((b) => !!ITEMS[b.item].weapon) },
  { title: '4 · Buy ammunition', body: 'Each weapon comes with a few HE rounds. Buy a few extra in the Ammunition section with the + buttons. Recon flares can reveal hidden structures.', check: (v) => Object.values(v.own.boughtAmmo).some((n) => n > 0) },
  { title: '5 · Finish building', body: 'When you are happy, press FINISH BUILDING. You cannot change your base after the battle starts.', check: (v) => v.phase !== 'build' },
  { title: 'The fog of war', body: 'The enemy base is somewhere in the red-tinted zone on the right, but you cannot see it. Your shells reveal information: a shell that stops in mid-air hit something. Hits mark enemy cells. Radar shows launch signatures. Use the minimap or ⤢ to see the whole field.', where: 'center' },
  { title: '6 · Aim: angle', body: 'Select a weapon in the left panel, then change the firing angle with the slider or ↑/↓. Watch the dashed trajectory preview update. It only knows terrain and your own base.', check: (_v, c) => Math.abs(c.angle - c.start.angle) > 0.4 },
  { title: '7 · Power and range', body: 'Change the power with the slider or ←/→. The estimated range readout tells you how far the shell should land, though wind and spread will move it. You can also type a target range and press "Solve power".', check: (_v, c) => Math.abs(c.power - c.start.power) > 0.4 },
  { title: '8 · Fire!', body: 'Aim at the enemy zone and press FIRE (or Space). It must be your turn. If the enemy is moving first, wait for their shell to land.', check: (v) => v.own.stats.shotsFired >= 1 },
  { title: '9 · Read the impact', body: 'Numbered ✕ markers show where your shells landed. A circled marker means you hit something. Red "?" cells are confirmed enemy structures. The event log on the right lists everything you observed.', where: 'center' },
  { title: '10 · Adapt', body: 'Missed short? Add power. Overshot? Reduce it. Fire again and walk your shells onto the target.', check: (v) => v.own.stats.shotsFired >= 2 },
  { title: 'You are ready', body: 'Find the enemy core (★) and destroy it. Tips: mix materials, hide guns away from your core, use decoys, and switch to AP rounds against armored bunkers. Good hunting!', where: 'center' },
];

interface Props {
  view: PlayerView;
  step: number;
  setStep: (n: number) => void;
  angle: number;
  power: number;
  onDone: () => void;
  onExit: () => void;
}

export function Tutorial({ view, step, setStep, angle, power, onDone }: Props) {
  const start = useRef({ angle, power, step: -1 });
  if (start.current.step !== step) start.current = { angle, power, step };
  const s = STEPS[step];
  useEffect(() => {
    if (!s?.check) return;
    if (s.check(view, { angle, power, start: start.current })) {
      const t = setTimeout(() => setStep(step + 1), 450);
      return () => clearTimeout(t);
    }
  }, [view, angle, power, step]);
  if (!s) return null;
  const last = step === STEPS.length - 1;
  return (
    <div className={`tutorial tut-${s.where ?? 'left'}`}>
      <div className="tut-progress">Tutorial {step + 1}/{STEPS.length}</div>
      <h3>{s.title}</h3>
      <p>{s.body}</p>
      <div className="row">
        {(!s.check || last) && <button className="btn primary" onClick={() => { if (last) onDone(); setStep(step + 1); }}>{last ? 'Finish tutorial' : 'Next'}</button>}
        {s.check && <span className="small pulse">Waiting for you to do this…</span>}
        {!last && <button className="btn ghost" onClick={() => { onDone(); setStep(STEPS.length); }}>Skip tutorial</button>}
      </div>
    </div>
  );
}
