import { useEffect, useMemo, useState } from 'react';
import { AMMO, AMMO_ORDER, DEFAULT_SETTINGS, ITEMS, ITEM_ORDER, WEAPONS, type MatchSettings } from '../../shared/config';
import type { Difficulty } from '../../shared/types';
import { HotseatController, LocalAIController, OnlineController, type Controller } from './game/controller';
import { GameScreen, SettingsFields } from './ui/GameScreen';
import { getPrefs, resolveServerUrl, setPrefs } from './prefs';
import { texture } from './game/textures';
import { sfx } from './game/sound';

type SetupMode = 'ai' | 'hotseat' | 'online';
type Screen =
  | { k: 'menu' }
  | { k: 'setup'; mode: SetupMode }
  | { k: 'online' }
  | { k: 'game'; ctrl: Controller; mode: SetupMode | 'tutorial' }
  | { k: 'howto' }
  | { k: 'settings' };

const SETTINGS_KEY = 'blindfire.match.v1';
function loadMatchSettings(): MatchSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'menu' });
  const [settings, setSettings] = useState<MatchSettings>(loadMatchSettings);
  const [diff, setDiff] = useState<Difficulty>('medium');
  const [names, setNames] = useState<[string, string]>(['Player 1', 'Player 2']);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // resume an online match after a page reload
  useEffect(() => {
    if (sessionStorage.getItem('blindfire.session')) {
      const ctrl = new OnlineController();
      if (ctrl.tryResume()) setScreen({ k: 'game', ctrl, mode: 'online' });
      else ctrl.dispose();
    }
  }, []);

  const exitGame = () => {
    if (screen.k === 'game') screen.ctrl.dispose();
    setScreen({ k: 'menu' });
  };

  const start = (mode: SetupMode | 'tutorial', s = settings, d = diff) => {
    sfx.click();
    const name = getPrefs().name || 'You';
    let ctrl: Controller;
    if (mode === 'hotseat') ctrl = new HotseatController(s, names);
    else if (mode === 'tutorial') ctrl = new LocalAIController({ ...DEFAULT_SETTINGS, wind: 0 }, 'easy', name, true);
    else ctrl = new LocalAIController(s, d, name);
    setScreen({ k: 'game', ctrl, mode });
  };

  if (screen.k === 'game') {
    return (
      <GameScreen
        ctrl={screen.ctrl}
        onExit={exitGame}
        onChangeSettings={screen.mode === 'ai' || screen.mode === 'hotseat' ? () => { screen.ctrl.dispose(); setScreen({ k: 'setup', mode: screen.mode as SetupMode }); } : undefined}
      />
    );
  }

  return (
    <div className="shell">
      <div className="bg-art" aria-hidden />
      {screen.k === 'menu' && (
        <Menu
          onQuick={() => start('ai', { ...DEFAULT_SETTINGS }, 'medium')}
          onAI={() => setScreen({ k: 'setup', mode: 'ai' })}
          onOnline={() => setScreen({ k: 'online' })}
          onHotseat={() => setScreen({ k: 'setup', mode: 'hotseat' })}
          onTutorial={() => start('tutorial')}
          onHowTo={() => setScreen({ k: 'howto' })}
          onSettings={() => setScreen({ k: 'settings' })}
        />
      )}
      {screen.k === 'setup' && (
        <Setup
          mode={screen.mode}
          settings={settings}
          setSettings={setSettings}
          diff={diff}
          setDiff={setDiff}
          names={names}
          setNames={setNames}
          onBack={() => setScreen({ k: screen.mode === 'online' ? 'online' : 'menu' })}
          onStart={() => (screen.mode === 'online' ? setScreen({ k: 'online' }) : start(screen.mode))}
        />
      )}
      {screen.k === 'online' && (
        <Online
          settings={settings}
          onSettings={() => setScreen({ k: 'setup', mode: 'online' })}
          onBack={() => setScreen({ k: 'menu' })}
          onJoined={(ctrl) => setScreen({ k: 'game', ctrl, mode: 'online' })}
        />
      )}
      {screen.k === 'howto' && <HowTo onBack={() => setScreen({ k: 'menu' })} />}
      {screen.k === 'settings' && <SettingsScreen onBack={() => setScreen({ k: 'menu' })} />}
    </div>
  );
}

function Logo() {
  return (
    <div className="logo">
      <svg viewBox="0 0 64 64" className="logo-mark" aria-hidden>
        <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="4" />
        <circle cx="32" cy="32" r="6" fill="currentColor" />
        <path d="M32 2v16M32 46v16M2 32h16M46 32h16" stroke="currentColor" strokeWidth="4" />
      </svg>
      <div>
        <h1>BLINDFIRE</h1>
        <div className="tagline">FORTIFY · CONCEAL · BOMBARD</div>
      </div>
    </div>
  );
}

function Menu(p: { onQuick: () => void; onAI: () => void; onOnline: () => void; onHotseat: () => void; onTutorial: () => void; onHowTo: () => void; onSettings: () => void }) {
  const tutDone = getPrefs().tutorialDone;
  return (
    <div className="menu">
      <Logo />
      <p className="pitch">Build a hidden fortress on a budget. Find the enemy's with nothing but shell craters, radar ghosts and your own judgement.</p>
      <div className="menu-buttons">
        <button className="btn primary big" onClick={p.onQuick}>Quick start <small>vs Sergeant Bot</small></button>
        <button className="btn big" onClick={p.onAI}>Single player <small>choose difficulty &amp; rules</small></button>
        <button className="btn big" onClick={p.onOnline}>Online multiplayer <small>private room code</small></button>
        <button className="btn big" onClick={p.onHotseat}>Local 2 players <small>hot-seat, one device</small></button>
        <button className={`btn big ${tutDone ? '' : 'pulse-border'}`} onClick={p.onTutorial}>Tutorial <small>{tutDone ? 'replay the basics' : 'recommended for first game'}</small></button>
        <div className="row">
          <button className="btn ghost" onClick={p.onHowTo}>How to play</button>
          <button className="btn ghost" onClick={p.onSettings}>Settings</button>
        </div>
      </div>
      <footer className="foot">Desktop recommended · mouse + keyboard · works on tablets</footer>
    </div>
  );
}

function Setup(p: {
  mode: SetupMode; settings: MatchSettings; setSettings: (s: MatchSettings) => void;
  diff: Difficulty; setDiff: (d: Difficulty) => void; names: [string, string]; setNames: (n: [string, string]) => void;
  onBack: () => void; onStart: () => void;
}) {
  const s = p.settings;
  const set = (x: Partial<MatchSettings>) => p.setSettings({ ...s, ...x });
  return (
    <div className="page">
      <h2>{p.mode === 'ai' ? 'Single player' : p.mode === 'hotseat' ? 'Local 2 players' : 'Online room rules'}</h2>
      <div className="form">
        {p.mode === 'ai' && (
          <div className="field wide">
            <label>Opponent</label>
            <div className="seg">
              {(['easy', 'medium', 'hard'] as Difficulty[]).map((d) => (
                <button key={d} className={p.diff === d ? 'on' : ''} onClick={() => p.setDiff(d)}>
                  <b>{d === 'easy' ? 'Cadet' : d === 'medium' ? 'Sergeant' : 'Colonel'}</b>
                  <small>{d === 'easy' ? 'Sloppy aim, simple base' : d === 'medium' ? 'Layered defense, sweeps your zone' : 'Learns from misses, hunts weak points'}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {p.mode === 'hotseat' && (
          <div className="field wide two">
            <label>Player names</label>
            <input value={p.names[0]} maxLength={18} onChange={(e) => p.setNames([e.target.value, p.names[1]])} />
            <input value={p.names[1]} maxLength={18} onChange={(e) => p.setNames([p.names[0], e.target.value])} />
          </div>
        )}
        <div className="field">
          <label>Construction budget <b>{s.budget}</b></label>
          <input type="range" min={400} max={3000} step={50} value={s.budget} onChange={(e) => set({ budget: +e.target.value })} />
        </div>
        <div className="field">
          <label>Victory condition</label>
          <select value={s.victory} onChange={(e) => set({ victory: e.target.value as MatchSettings['victory'] })}>
            <option value="core">Destroy the Command Core</option>
            <option value="weapons">Core or all enemy artillery</option>
            <option value="integrity">Core or base integrity below 35%</option>
          </select>
        </div>
        <div className="field">
          <label>Information on hit</label>
          <select value={s.revealOnHit} onChange={(e) => set({ revealOnHit: e.target.value as MatchSettings['revealOnHit'] })}>
            <option value="none">Hardcore: no cells revealed</option>
            <option value="hit">Standard: damaged cells revealed</option>
            <option value="area">Generous: everything in blast revealed</option>
          </select>
        </div>
        <div className="field">
          <label>Wind</label>
          <select value={s.wind} onChange={(e) => set({ wind: +e.target.value as MatchSettings['wind'] })}>
            <option value={0}>Calm</option><option value={1}>Normal</option><option value={2}>Strong</option>
          </select>
        </div>
        <div className="field">
          <label>Shots per turn</label>
          <select value={s.shotsPerTurn} onChange={(e) => set({ shotsPerTurn: +e.target.value as MatchSettings['shotsPerTurn'] })}>
            <option value={1}>1 (classic)</option><option value={2}>2</option><option value={3}>3 (barrage)</option>
          </select>
        </div>
        {p.mode === 'online' && (
          <div className="field">
            <label>Turn timer <b>{s.turnTime ? `${s.turnTime}s` : 'off'}</b></label>
            <input type="range" min={0} max={180} step={15} value={s.turnTime} onChange={(e) => set({ turnTime: +e.target.value })} />
          </div>
        )}
        <div className="field">
          <label>Turn limit <b>{s.maxTurns}</b></label>
          <input type="range" min={20} max={200} step={10} value={s.maxTurns} onChange={(e) => set({ maxTurns: +e.target.value })} />
        </div>
        <div className="field checks">
          <label className="check"><input type="checkbox" checked={s.scouting} onChange={(e) => set({ scouting: e.target.checked })} /> Scouting (radar &amp; recon flares)</label>
          <label className="check"><input type="checkbox" checked={s.repairs} onChange={(e) => set({ repairs: e.target.checked })} /> Repair stations work</label>
          <label className="check"><input type="checkbox" checked={s.openBases} onChange={(e) => set({ openBases: e.target.checked })} /> Casual: bases visible in combat</label>
        </div>
      </div>
      <div className="row">
        <button className="btn ghost" onClick={p.onBack}>Back</button>
        <button className="btn ghost" onClick={() => p.setSettings({ ...DEFAULT_SETTINGS })}>Reset defaults</button>
        <button className="btn primary big" onClick={p.onStart}>{p.mode === 'online' ? 'Save rules' : 'Start match'}</button>
      </div>
    </div>
  );
}

function Online(p: { settings: MatchSettings; onSettings: () => void; onBack: () => void; onJoined: (c: OnlineController) => void }) {
  const [name, setName] = useState(getPrefs().name);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState(resolveServerUrl());
  const [ctrl, setCtrl] = useState<OnlineController | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!url) {
      setCtrl(null);
      return;
    }
    const c = new OnlineController(url);
    setCtrl(c);
    const off = c.on('change', () => bump((x) => x + 1));
    return () => {
      off();
      if (!(c as any).__handedOff) c.socket.close();
    };
  }, [url]);

  const go = async (create: boolean) => {
    if (!ctrl) return;
    setPrefs({ name });
    setBusy(true);
    setErr('');
    const r = create ? await ctrl.create(name || 'Commander', p.settings) : await ctrl.join(code, name || 'Commander');
    setBusy(false);
    if (!r.ok) return setErr(r.error || 'Failed');
    (ctrl as any).__handedOff = true;
    p.onJoined(ctrl);
  };

  const status = !url ? 'disconnected' : ctrl?.net ?? 'connecting';
  const summary = useMemo(() => `${p.settings.budget} pts · ${p.settings.victory === 'core' ? 'core kill' : p.settings.victory} · ${p.settings.turnTime ? p.settings.turnTime + 's turns' : 'no timer'} · wind ${['calm', 'normal', 'strong'][p.settings.wind]}`, [p.settings]);
  return (
    <div className="page narrow">
      <h2>Online multiplayer</h2>
      {url ? (
        <div className={`server-status s-${status}`}>
          <span>Server: {url}</span>
          <b>{status === 'connected' ? '● connected' : status === 'connecting' ? 'connecting… (free servers can take ~50s to wake up)' : '● unreachable, retrying (free servers can take ~50s to wake up)'}</b>
        </div>
      ) : (
        <div className="error">This static copy of the game has no multiplayer server configured. Enter a BLINDFIRE server address under “Advanced” below (see the README for one-click free deployment).</div>
      )}
      <div className="field wide">
        <label>Your callsign</label>
        <input value={name} maxLength={18} placeholder="Commander" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="online-grid">
        <div className="card">
          <h3>Create a room</h3>
          <p className="small">{summary}</p>
          <div className="row">
            <button className="btn ghost" onClick={p.onSettings}>Edit rules</button>
            <button className="btn primary" disabled={busy || status !== 'connected'} onClick={() => go(true)}>Create room</button>
          </div>
        </div>
        <div className="card">
          <h3>Join a room</h3>
          <input className="code-input" value={code} maxLength={5} placeholder="CODE" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && code.length === 5 && go(false)} />
          <button className="btn primary" disabled={busy || code.length !== 5 || status !== 'connected'} onClick={() => go(false)}>Join</button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      <details className="adv" open={!url}>
        <summary>Advanced: server address</summary>
        <p className="small">Leave empty to use the default. Point this at your own deployed BLINDFIRE server (see README).</p>
        <ServerUrlField onSave={() => setUrl(resolveServerUrl())} />
      </details>
      <div className="row"><button className="btn ghost" onClick={p.onBack}>Back</button></div>
    </div>
  );
}

function ServerUrlField({ onSave }: { onSave: () => void }) {
  const [v, setV] = useState(getPrefs().serverUrl);
  return (
    <div className="row">
      <input value={v} placeholder="https://your-server.onrender.com" onChange={(e) => setV(e.target.value)} />
      <button className="btn" onClick={() => { setPrefs({ serverUrl: v }); onSave(); }}>Use</button>
    </div>
  );
}

function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState(getPrefs().name);
  return (
    <div className="page narrow">
      <h2>Settings</h2>
      <div className="field wide">
        <label>Callsign</label>
        <input value={name} maxLength={18} onChange={(e) => { setName(e.target.value); setPrefs({ name: e.target.value }); }} />
      </div>
      <SettingsFields />
      <div className="row">
        <button className="btn ghost" onClick={() => { setPrefs({ tutorialDone: false }); }}>Reset tutorial progress</button>
        <button className="btn primary" onClick={onBack}>Done</button>
      </div>
    </div>
  );
}

function HowTo({ onBack }: { onBack: () => void }) {
  return (
    <div className="page howto">
      <h2>How to play</h2>
      <div className="howto-grid">
        <section>
          <h3>1 · Build</h3>
          <p>Both sides secretly build within their zone using the same point budget. You must place a <b>Command Core</b> and at least one weapon. Blocks need support: ground, a block below, or a sideways connection within the material's <b>span</b>. Destroying supports later makes everything above collapse.</p>
          <p>Weapons need a block or ground beneath and <b>open sky above</b>. Shells can hit your own walls, so leave firing lanes.</p>
        </section>
        <section>
          <h3>2 · Hunt</h3>
          <p>Players alternate turns. Pick a weapon, ammunition, <b>angle</b> and <b>power</b>. The dashed preview shows the trajectory through known terrain, your own base and the wind as you read it. It never shows the enemy base.</p>
          <p>Use <b>Solve power</b> to compute power for a typed range, or Shift-click the field to measure a range.</p>
        </section>
        <section>
          <h3>3 · Observe &amp; adapt</h3>
          <p>A shell that stops in mid-air hit something. Damaged enemy cells are marked (red ?), the core shows as ★, destroyed cells as ✕. Craters, collapses and secondary explosions are visible. With a <b>Radar Station</b> you see estimated enemy launch sites and exact wind. Decoys fake those sightings.</p>
        </section>
        <section>
          <h3>4 · Win</h3>
          <p>Destroy the enemy <b>Command Core</b> (default). Optional rules also end the game when all artillery is lost or integrity drops below 35%. If the turn limit is hit or both sides run dry, the higher <b>value destroyed</b> wins.</p>
        </section>
      </div>
      <h3>Materials &amp; equipment</h3>
      <div className="table-wrap">
        <table className="catalog-table">
          <thead><tr><th></th><th>Item</th><th>Cost</th><th>HP</th><th>Blast / AP / Frag taken</th><th>Notes</th></tr></thead>
          <tbody>
            {ITEM_ORDER.map((id) => {
              const d = ITEMS[id];
              return (
                <tr key={id}>
                  <td><img src={texture(id).toDataURL()} alt="" width={24} height={24} /></td>
                  <td>{d.name}</td><td>{d.cost}</td><td>{d.hp}</td>
                  <td>×{d.resist.blast} / ×{d.resist.pierce} / ×{d.resist.frag}</td>
                  <td>{d.desc}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <h3>Artillery</h3>
      <div className="table-wrap">
        <table className="catalog-table">
          <thead><tr><th>Weapon</th><th>Angle</th><th>Damage</th><th>Blast</th><th>Rounds/shot</th><th>Reload</th><th>Ammo</th></tr></thead>
          <tbody>
            {Object.values(WEAPONS).map((w) => (
              <tr key={w.id}><td>{w.name}<br /><small>{w.role}</small></td><td>{w.angleMin}–{w.angleMax}°</td><td>{w.damage}{w.projectiles > 1 ? ` ×${w.projectiles}` : ''}</td><td>{w.radius}</td><td>{w.ammoUse}</td><td>{w.reload}</td><td>{w.ammo.map((a) => AMMO[a].short).join(', ')}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Ammunition</h3>
      <ul className="ammo-list">
        {AMMO_ORDER.map((a) => <li key={a}><span className={`chip chip-${a}`}>{AMMO[a].short}</span> <b>{AMMO[a].name}</b> ({AMMO[a].cost} pts): {AMMO[a].desc}</li>)}
      </ul>
      <h3>Controls</h3>
      <p>Drag or WASD to pan · mouse wheel to zoom · Build: click/drag to place, right-click to remove, R rotate, X remove tool, Ctrl+Z / Ctrl+Y undo/redo · Combat: ↑/↓ angle, ←/→ power (hold Shift for fine steps), Space fire, Q/E switch weapon, Shift-click measure range · Esc menu.</p>
      <div className="row"><button className="btn primary" onClick={onBack}>Back</button></div>
    </div>
  );
}
