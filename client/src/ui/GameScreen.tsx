import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AMMO, AMMO_ORDER, CELL, ITEMS, ITEM_ORDER, WEAPONS, type AmmoId, type Category, type ItemId } from '../../../shared/config';
import { solvePower } from '../../../shared/ballistics';
import { buildGrid, key } from '../../../shared/structure';
import { facing, muzzleOf } from '../../../shared/match';
import type { Block, PlayerAction, PlayerView, ShotReport } from '../../../shared/types';
import type { Controller } from '../game/controller';
import { BattleRenderer, type HoverInfo } from '../game/renderer';
import { texture } from '../game/textures';
import { sfx } from '../game/sound';
import { getPrefs, setPrefs } from '../prefs';
import { Tutorial } from './Tutorial';

interface Props {
  ctrl: Controller;
  onExit: () => void;
  onChangeSettings?: () => void;
}

interface UndoEntry { redo: PlayerAction; undo: PlayerAction }

const CATS: { id: Category; label: string }[] = [
  { id: 'blocks', label: 'Blocks' },
  { id: 'defense', label: 'Defense' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'utility', label: 'Utility' },
];

const iconCache = new Map<string, string>();
function icon(item: ItemId, rot = 0) {
  const k = `${item}:${rot}`;
  if (!iconCache.has(k)) iconCache.set(k, texture(item, rot).toDataURL());
  return iconCache.get(k)!;
}

export function GameScreen({ ctrl, onExit, onChangeSettings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<BattleRenderer | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [, force] = useReducer((x) => x + 1, 0);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [cat, setCat] = useState<Category>('blocks');
  const [item, setItem] = useState<ItemId | null>('stone');
  const [tool, setTool] = useState<'place' | 'remove' | 'move'>('place');
  const [rot, setRot] = useState(0);
  const [moving, setMoving] = useState<Block | null>(null);
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [redo, setRedo] = useState<UndoEntry[]>([]);
  const [weaponId, setWeaponId] = useState<number | null>(null);
  const [angle, setAngle] = useState(55);
  const [power, setPower] = useState(70);
  const [ammo, setAmmo] = useState<AmmoId>('he');
  const [rangeInput, setRangeInput] = useState('');
  const [toast, setToast] = useState<{ text: string; kind: string; id: number } | null>(null);
  const [banner, setBanner] = useState<{ text: string; sub?: string; kind: string; id: number } | null>(null);
  const [logOpen, setLogOpen] = useState(window.innerWidth > 1100);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [showResults, setShowResults] = useState(true);
  const [animating, setAnimating] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [allShots, setAllShots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);

  const flash = useCallback((text: string, kind = 'warn') => setToast({ text, kind, id: Math.random() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 2200);
    return () => clearTimeout(t);
  }, [banner]);

  // ---------------------------------------------------------------- wiring
  useEffect(() => {
    const r = new BattleRenderer(canvasRef.current!);
    rRef.current = r;
    r.setMinimap(miniRef.current);
    r.onViewApplied = (v) => setView(v);
    r.onHover = (h) => setHover(h);
    r.onShotStart = (rep: ShotReport) => {
      setAnimating(true);
      if (rep.shooter !== rep.viewer) {
        sfx.alert();
        setBanner({ text: 'INCOMING', sub: rep.weaponItem ? `${ITEMS[rep.weaponItem].name} fire detected` : undefined, kind: 'bad', id: Math.random() });
      }
    };
    r.onShotDone = (rep: ShotReport) => {
      setAnimating(r.animating);
      if (rep.messages.length) {
        const good = rep.shooter === rep.viewer;
        const msg = rep.messages[0];
        const kind = good ? (/miss|obscured|Intercepted/i.test(msg) ? 'info' : 'good') : /missed|not observed|intercepted/i.test(msg) ? 'info' : 'bad';
        setBanner({ text: msg.toUpperCase(), sub: rep.messages.slice(1).join(' · ') || undefined, kind, id: Math.random() });
      }
      ctrl.animationDone();
    };
    const offs = [
      ctrl.on('shot', (rep: ShotReport) => r.queueShot(rep)),
      ctrl.on('view', () => {
        if (ctrl.view) r.setView(ctrl.view);
      }),
      ctrl.on('change', () => force()),
    ];
    if (ctrl.view) r.setView(ctrl.view);
    (window as any).__blindfire = { renderer: r, ctrl }; // handy for debugging and automated UI tests
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      offs.forEach((o) => o());
      clearInterval(tick);
      r.dispose();
    };
  }, [ctrl]);

  const v = view;
  const isTutorial = ctrl.mode === 'tutorial';
  const myTurn = !!v && v.phase === 'combat' && v.active === v.you;
  const building = !!v && v.phase === 'build' && !v.own.ready;
  const weapons = useMemo(() => (v ? v.own.blocks.filter((b) => ITEMS[b.item].weapon) : []), [v]);
  const ownGrid = useMemo(() => buildGrid(v?.own.blocks ?? []), [v]);
  const selWeapon = weapons.find((b) => b.id === weaponId) ?? null;
  const W = selWeapon ? WEAPONS[ITEMS[selWeapon.item].weapon!] : null;

  // renderer mode / tools
  useEffect(() => {
    const r = rRef.current;
    if (!r) return;
    r.mode = building ? 'build' : myTurn && !animating ? 'aim' : 'idle';
    r.build = { item: tool === 'remove' ? null : tool === 'move' ? (moving ? moving.item : null) : item, tool, rot: moving ? moving.rot : rot };
    r.aim = { weaponId, angle, power, ammo };
    r.refreshHover();
  }, [building, myTurn, animating, item, tool, rot, moving, weaponId, angle, power, ammo, v]);

  // keep a valid weapon selected
  useEffect(() => {
    if (!v || v.phase !== 'combat') return;
    const usable = (b: Block) => b.hp > 0 && b.cooldown === 0 && !v.firedThisTurn.includes(b.id) && !ownGrid.has(key(b.c, b.r - 1));
    if (!selWeapon || !usable(selWeapon)) {
      const pick = weapons.find(usable) ?? weapons[0];
      if (pick) selectWeapon(pick);
    }
  }, [v]);

  const selectWeapon = (b: Block) => {
    const w = WEAPONS[ITEMS[b.item].weapon!];
    setWeaponId(b.id);
    setAngle((a) => Math.max(w.angleMin, Math.min(w.angleMax, a)));
    const own = v?.own.ammo;
    setAmmo((cur) => (w.ammo.includes(cur) && (own?.[cur] ?? 0) >= w.ammoUse ? cur : w.ammo.find((a) => (own?.[a] ?? 0) >= w.ammoUse) ?? w.ammo[0]));
  };

  // ---------------------------------------------------------------- actions
  const send = useCallback(async (a: PlayerAction, record?: UndoEntry) => {
    const res = await ctrl.send(a);
    if (!res.ok) {
      if (res.error) flash(res.error);
      return false;
    }
    if (record) {
      setUndo((u) => [...u.slice(-200), record]);
      setRedo([]);
    }
    return true;
  }, [ctrl, flash]);

  const onCell = useCallback(async (c: number, r: number, button: 'primary' | 'secondary', dragging: boolean) => {
    const vv = rRef.current?.view;
    if (!vv || vv.phase !== 'build' || vv.own.ready) return;
    const existing = vv.own.blocks.find((b) => b.c === c && b.r === r);
    const doRemove = async (b: Block) => {
      if (await send({ t: 'remove', c, r }, { redo: { t: 'remove', c, r }, undo: { t: 'place', item: b.item, c, r, rot: b.rot } })) sfx.click();
    };
    if (button === 'secondary' || tool === 'remove') {
      if (existing) await doRemove(existing);
      return;
    }
    if (tool === 'move') {
      if (!moving) {
        if (!existing || dragging) return;
        if (await send({ t: 'remove', c, r }, { redo: { t: 'remove', c, r }, undo: { t: 'place', item: existing.item, c, r, rot: existing.rot } })) {
          setMoving(existing);
          sfx.click();
        }
      } else if (!dragging) {
        if (await send({ t: 'place', item: moving.item, c, r, rot: moving.rot }, { redo: { t: 'place', item: moving.item, c, r, rot: moving.rot }, undo: { t: 'remove', c, r } })) {
          setMoving(null);
          sfx.place();
        }
      }
      return;
    }
    if (!item || existing) return;
    const err = rRef.current?.hover?.error;
    if (dragging && err) return; // silent while painting
    if (await send({ t: 'place', item, c, r, rot }, { redo: { t: 'place', item, c, r, rot }, undo: { t: 'remove', c, r } })) sfx.place();
  }, [tool, item, rot, moving, send]);

  useEffect(() => {
    if (rRef.current) rRef.current.onCell = onCell;
  }, [onCell]);

  const doUndo = async () => {
    const e = undo[undo.length - 1];
    if (!e) return;
    const res = await ctrl.send(e.undo);
    if (!res.ok) return flash(res.error ?? 'Cannot undo');
    setUndo((u) => u.slice(0, -1));
    setRedo((r) => [...r, e]);
  };
  const doRedo = async () => {
    const e = redo[redo.length - 1];
    if (!e) return;
    const res = await ctrl.send(e.redo);
    if (!res.ok) return flash(res.error ?? 'Cannot redo');
    setRedo((r) => r.slice(0, -1));
    setUndo((u) => [...u, e]);
  };

  const buyAmmo = (a: AmmoId, delta: number) => send({ t: 'ammo', ammo: a, delta }, { redo: { t: 'ammo', ammo: a, delta }, undo: { t: 'ammo', ammo: a, delta: -delta } });

  const fire = async () => {
    if (!myTurn || animating || busy || !selWeapon) return;
    setBusy(true);
    const ok = await send({ t: 'fire', weaponId: selWeapon.id, ammo, angle, power });
    setBusy(false);
    if (ok) setRangeInput('');
  };

  const endTurn = () => myTurn && !animating && send({ t: 'endTurn' });

  const solve = () => {
    const r = rRef.current;
    const range = parseFloat(rangeInput);
    if (!r || !v || !selWeapon || !W || !(range > 0)) return flash('Enter a range in metres (1 m = 1 px)');
    const m = muzzleOf(selWeapon);
    const tx = m.x + facing(v.you) * range;
    const sol = solvePower({ x: m.x, y: m.y, angleDeg: angle, dir: facing(v.you), wind: v.wind, weapon: W.id }, tx, { terrain: v.terrain, solidAt: (c, rr) => ownGrid.get(key(c, rr))?.id ?? null });
    if (!sol) return flash(`Out of reach at ${angle.toFixed(1)}° - try another angle`);
    setPower(Math.round(sol.power * 10) / 10);
    r.aimTargetX = tx;
    sfx.click();
  };

  useEffect(() => {
    const r = rRef.current;
    if (!r) return;
    r.onTarget = (x: number) => {
      if (!v || !selWeapon) return;
      const m = muzzleOf(selWeapon);
      setRangeInput(String(Math.round(Math.abs(x - m.x))));
    };
  }, [v, selWeapon]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const fine = e.shiftKey ? 0.1 : 1;
      if (e.key === 'Escape') { setMenuOpen((o) => !o); return; }
      if (building) {
        if (e.key === 'r' || e.key === 'R') setRot((x) => (x + 1) % 4);
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
        if (e.key === 'x' || e.key === 'X') setTool((t) => (t === 'remove' ? 'place' : 'remove'));
      }
      if (myTurn && W) {
        if (e.key === 'ArrowUp') { e.preventDefault(); setAngle((a) => +Math.min(W.angleMax, a + fine).toFixed(1)); }
        if (e.key === 'ArrowDown') { e.preventDefault(); setAngle((a) => +Math.max(W.angleMin, a - fine).toFixed(1)); }
        if (e.key === 'ArrowRight') { e.preventDefault(); setPower((p) => +Math.min(100, p + fine).toFixed(1)); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); setPower((p) => +Math.max(1, p - fine).toFixed(1)); }
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(); }
        if (e.key === 'q' || e.key === 'e') {
          const usable = weapons.filter((b) => b.hp > 0);
          const i = usable.findIndex((b) => b.id === weaponId);
          const n = usable[(i + (e.key === 'e' ? 1 : usable.length - 1)) % usable.length];
          if (n) selectWeapon(n);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------------ render
  const preview = myTurn && !animating ? rRef.current?.previewInfo() : null;
  const budget = v?.settings.budget ?? 0;
  const spent = v?.own.spent ?? 0;
  const left = budget - spent;
  const sel = item ? ITEMS[item] : null;
  const turnLeft = v && v.phase === 'combat' && ctrl.mode === 'online' && v.settings.turnTime
    ? Math.max(0, Math.ceil(v.settings.turnTime - (now - v.turnStartedAt) / 1000)) : null;
  const room = ctrl.room;
  const oppConnected = room?.players[room.seat === 0 ? 1 : 0]?.connected ?? true;
  const stats = v ? {
    blocks: v.own.blocks.length,
    hp: v.own.blocks.reduce((a, b) => a + b.maxHp, 0),
    guns: weapons.length,
    core: v.own.blocks.some((b) => b.item === 'core'),
  } : null;
  const over = v?.phase === 'over' && !animating;
  const won = v && v.winner === v.you;
  const coreBlock = v?.own.blocks.find((b) => b.item === 'core');

  return (
    <div className="game">
      <canvas ref={canvasRef} className="battlefield" />

      {/* ---------- top bar ---------- */}
      <header className="topbar">
        <div className="brand-mini">BLINDFIRE</div>
        <div className={`phase phase-${v?.phase ?? 'build'}`}>
          {v?.phase === 'build' ? 'CONSTRUCTION' : v?.phase === 'combat' ? `TURN ${v.turn}` : v?.phase === 'over' ? 'BATTLE OVER' : 'LOADING'}
        </div>
        {v && v.phase === 'combat' && (
          <div className={`whose ${myTurn ? 'mine' : 'theirs'}`}>
            {myTurn ? 'YOUR TURN' : `${v.enemy.name.toUpperCase()}'S TURN`}
            {v.settings.shotsPerTurn > 1 && myTurn && <span className="sub"> · shot {v.shotsThisTurn + 1}/{v.settings.shotsPerTurn}</span>}
          </div>
        )}
        {v && v.phase === 'build' && (
          <div className="whose">{v.own.ready ? (v.enemy.ready ? 'Starting…' : `Waiting for ${v.enemy.name}…`) : `vs ${v.enemy.name}`}</div>
        )}
        <div className="spacer" />
        {v && v.phase !== 'build' && (
          <div className="integrity" title="Your base integrity (remaining HP)">
            <span>BASE</span>
            <div className="bar"><i style={{ width: `${Math.round(v.own.integrity * 100)}%` }} /></div>
            <b>{Math.round(v.own.integrity * 100)}%</b>
            {coreBlock && <span className="core-hp" title="Command core HP">★ {Math.ceil(coreBlock.hp)}/{coreBlock.maxHp}</span>}
          </div>
        )}
        {v && <Wind wind={v.wind} exact={v.windExact} />}
        {turnLeft !== null && <div className={`timer ${turnLeft <= 10 ? 'low' : ''}`} title="Turn timer">⏱ {turnLeft}s</div>}
        {ctrl.mode === 'online' && <NetBadge net={ctrl.net} opp={oppConnected} />}
        <button className="icon-btn" title="Overview (whole battlefield)" onClick={() => rRef.current?.overview()}>⤢</button>
        <button className="icon-btn" title="Focus my base" onClick={() => rRef.current?.focusOwnBase()}>⌂</button>
        <button className="icon-btn" title="Menu (Esc)" onClick={() => setMenuOpen(true)}>☰</button>
      </header>

      {/* ---------- left panel ---------- */}
      {v && v.phase === 'build' && (
        <aside className="panel left build-panel">
          <div className="budget">
            <div className="budget-row"><span>Budget</span><b>{budget}</b></div>
            <div className="budget-bar"><i style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>
            <div className="budget-row small"><span>Spent {spent}</span><span className={left < 50 ? 'warn' : ''}>Remaining <b>{left}</b></span></div>
          </div>
          {v.own.ready ? (
            <div className="ready-box">
              <p>Base locked in. {v.enemy.ready ? 'Battle starting…' : `Waiting for ${v.enemy.name} to finish building.`}</p>
              {!v.enemy.ready && <button className="btn ghost" onClick={() => send({ t: 'ready', ready: false })}>Edit base</button>}
            </div>
          ) : (
            <>
              <div className="tabs">
                {CATS.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.label}</button>)}
              </div>
              <div className="catalog">
                {ITEM_ORDER.filter((id) => ITEMS[id].category === cat).map((id) => {
                  const d = ITEMS[id];
                  const disabled = (id === 'radar' && !v.settings.scouting);
                  const placed = v.own.blocks.filter((b) => b.item === id).length;
                  return (
                    <button key={id} disabled={disabled} className={`item ${item === id && tool === 'place' ? 'on' : ''} ${d.cost > left ? 'poor' : ''} ${id === 'core' && !stats?.core ? 'need' : ''}`}
                      onClick={() => { setItem(id); setTool('place'); setMoving(null); sfx.click(); }} title={d.desc}>
                      <img src={icon(id, item === id ? rot : 0)} alt="" />
                      <span className="nm">{d.name}{placed ? <em> ×{placed}</em> : null}</span>
                      <span className="cost">{d.cost || 'FREE'}</span>
                    </button>
                  );
                })}
              </div>
              {sel && tool === 'place' && (
                <div className="detail">
                  <div className="detail-head"><b>{sel.name}</b><span className="cost">{sel.cost} pts</span></div>
                  <p>{sel.desc}</p>
                  <div className="specs">
                    <span>HP {sel.hp}</span>
                    <span title="Blast / Pierce / Fragment damage taken multiplier">Resist B{sel.resist.blast} P{sel.resist.pierce} F{sel.resist.frag}</span>
                    {sel.span >= 0 && sel.category !== 'weapons' ? <span>Span {sel.span}</span> : <span>Needs support below</span>}
                    {sel.weapon && <WeaponSpecs id={sel.weapon} />}
                  </div>
                </div>
              )}
              <div className="tools">
                <button className={tool === 'place' ? 'on' : ''} onClick={() => { setTool('place'); setMoving(null); }} title="Place (click / drag)">✚ Place</button>
                <button className={tool === 'remove' ? 'on' : ''} onClick={() => { setTool('remove'); setMoving(null); }} title="Remove (X, or right-click)">✖ Remove</button>
                <button className={tool === 'move' ? 'on' : ''} onClick={() => { setTool('move'); setMoving(null); }} title="Pick up a block and put it elsewhere">⇄ Move</button>
                <button onClick={() => setRot((x) => (x + 1) % 4)} disabled={!sel?.rotatable} title="Rotate (R)">⟳</button>
                <button onClick={doUndo} disabled={!undo.length} title="Undo (Ctrl+Z)">↶</button>
                <button onClick={doRedo} disabled={!redo.length} title="Redo (Ctrl+Y)">↷</button>
              </div>
              {moving && <div className="hint">Moving {ITEMS[moving.item].name} - click an empty cell.</div>}
              <div className="ammo-shop">
                <div className="sec-title">Ammunition <small>(each weapon includes some HE)</small></div>
                {AMMO_ORDER.map((a) => {
                  const A = AMMO[a];
                  const disabled = a === 'recon' && !v.settings.scouting;
                  const usable = weapons.some((b) => WEAPONS[ITEMS[b.item].weapon!].ammo.includes(a));
                  return (
                    <div key={a} className={`ammo-row ${disabled ? 'dis' : ''}`} title={A.desc}>
                      <span className={`chip chip-${a}`}>{A.short}</span>
                      <span className="nm">{A.name}{!usable && weapons.length > 0 ? <em className="warn"> · no weapon fires this</em> : null}</span>
                      <span className="cost">{A.cost}/rd</span>
                      <button disabled={disabled || v.own.boughtAmmo[a] <= 0} onClick={() => buyAmmo(a, -1)}>−</button>
                      <b className="cnt">{v.own.ammo[a]}</b>
                      <button disabled={disabled || A.cost > left} onClick={() => buyAmmo(a, 1)}>+</button>
                      <button disabled={disabled || A.cost * 5 > left} onClick={() => buyAmmo(a, 5)}>+5</button>
                    </div>
                  );
                })}
              </div>
              <div className="base-stats">
                <span>{stats?.blocks} blocks</span><span>{stats?.hp} total HP</span><span>{stats?.guns} weapon{stats?.guns === 1 ? '' : 's'}</span>
                <span className={stats?.core ? 'ok' : 'warn'}>{stats?.core ? '★ Core placed' : '★ Core missing'}</span>
              </div>
              <button className="btn primary big" onClick={async () => { if (await send({ t: 'ready', ready: true })) { sfx.alert(); setUndo([]); setRedo([]); } }}>
                FINISH BUILDING
              </button>
            </>
          )}
        </aside>
      )}

      {v && v.phase !== 'build' && (
        <aside className="panel left aim-panel">
          <div className="sec-title">Artillery</div>
          <div className="weapons">
            {weapons.length === 0 && <div className="hint">All your artillery has been destroyed.</div>}
            {weapons.map((b) => {
              const w = WEAPONS[ITEMS[b.item].weapon!];
              const blocked = ownGrid.has(key(b.c, b.r - 1));
              const fired = v.firedThisTurn.includes(b.id);
              const reload = myTurn ? b.cooldown : b.cooldown - 1; // cooldown ticks down at the start of our turn
              const status = blocked ? 'BLOCKED' : reload > 0 ? `RELOAD ${reload}` : fired ? 'FIRED' : 'READY';
              return (
                <button key={b.id} className={`weapon ${b.id === weaponId ? 'on' : ''} st-${status.split(' ')[0].toLowerCase()}`} onClick={() => selectWeapon(b)}>
                  <img src={icon(b.item)} alt="" />
                  <span className="nm">{w.name}<small>HP {Math.ceil(b.hp)}/{b.maxHp}</small></span>
                  <span className="st">{status}</span>
                </button>
              );
            })}
          </div>
          {W && selWeapon && (
            <>
              <div className="wspec"><i>{W.role}</i> · DMG {W.damage} · R {W.radius} · {W.ammoUse} rd/shot · reload {W.reload}</div>
              <div className="sec-title">Ammunition</div>
              <div className="ammo-pick">
                {W.ammo.map((a) => (
                  <button key={a} className={`chip chip-${a} ${ammo === a ? 'on' : ''}`} disabled={v.own.ammo[a] < W.ammoUse || (a === 'recon' && !v.settings.scouting)} onClick={() => setAmmo(a)} title={AMMO[a].desc}>
                    {AMMO[a].short} <b>{v.own.ammo[a]}</b>
                  </button>
                ))}
              </div>
              <div className="ctl">
                <label>Angle <b>{angle.toFixed(1)}°</b> <small>{W.angleMin}–{W.angleMax}°</small></label>
                <div className="slider-row">
                  <button onClick={() => setAngle((a) => +Math.max(W.angleMin, a - 0.5).toFixed(1))}>−</button>
                  <input type="range" min={W.angleMin} max={W.angleMax} step={0.1} value={angle} onChange={(e) => setAngle(+e.target.value)} />
                  <button onClick={() => setAngle((a) => +Math.min(W.angleMax, a + 0.5).toFixed(1))}>+</button>
                </div>
              </div>
              <div className="ctl">
                <label>Power <b>{power.toFixed(1)}%</b> <small>{Math.round((W.speedMax * power) / 100)} m/s</small></label>
                <div className="slider-row">
                  <button onClick={() => setPower((p) => +Math.max(1, p - 0.5).toFixed(1))}>−</button>
                  <input type="range" min={1} max={100} step={0.1} value={power} onChange={(e) => setPower(+e.target.value)} />
                  <button onClick={() => setPower((p) => +Math.min(100, p + 0.5).toFixed(1))}>+</button>
                </div>
              </div>
              <div className="readout">
                <div><span>Est. range</span><b>{preview ? `${Math.round(preview.range)} m` : '—'}</b></div>
                <div><span>Impact</span><b className={preview?.endKind === 'structure' ? 'warn' : ''}>{preview ? (preview.endKind === 'structure' ? 'own base!' : preview.endKind === 'lost' ? 'off map' : `x ${Math.round(preview.x / CELL)}`) : '—'}</b></div>
              </div>
              <div className="solve">
                <input placeholder="Target range (m)" value={rangeInput} onChange={(e) => setRangeInput(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && solve()} />
                <button onClick={solve} title="Compute the power needed to land at this range with the current angle">Solve power</button>
              </div>
              <div className="hint small">Shift-click the battlefield to measure a range. Arrows adjust, Space fires, Q/E switch guns.</div>
              <button className="btn fire big" disabled={!myTurn || animating || busy || v.own.ammo[ammo] < W.ammoUse} onClick={fire}>
                {myTurn ? (animating ? '…' : 'FIRE') : 'ENEMY TURN'}
              </button>
              <button className="btn ghost" disabled={!myTurn || animating} onClick={endTurn}>End turn</button>
            </>
          )}
          <label className="check"><input type="checkbox" checked={allShots} onChange={(e) => { setAllShots(e.target.checked); rRef.current?.setShowAllShots(e.target.checked); }} /> Show all my impact markers</label>
        </aside>
      )}

      {/* ---------- right: log + minimap ---------- */}
      <aside className={`panel right log-panel ${logOpen ? '' : 'closed'}`}>
        <button className="log-toggle" onClick={() => setLogOpen((o) => !o)}>{logOpen ? 'Event log ▸' : '◂ Log'}</button>
        {logOpen && v && (
          <div className="log">
            {[...v.log].reverse().map((l, i) => (
              <div key={i} className={`le le-${l.kind}`}><span className="lt">{l.turn ? `T${l.turn}` : '—'}</span>{l.text}</div>
            ))}
          </div>
        )}
        {logOpen && v && v.phase === 'combat' && (
          <div className="intel">
            <div className="sec-title">Intel</div>
            <span>Known contacts: <b>{v.enemy.known.filter((k) => k.kind !== 'destroyed').length}</b></span>
            <span>Destroyed: <b>{v.enemy.known.filter((k) => k.kind === 'destroyed').length}</b></span>
            <span>Radar sightings: <b>{v.enemy.detections.length}</b></span>
            <span>Shots / hits: <b>{v.own.stats.shotsFired} / {v.own.stats.shotsHit}</b></span>
          </div>
        )}
      </aside>
      <canvas ref={miniRef} className="minimap" width={300} height={90} title="Tactical overview - click to move the camera" />

      {/* ---------- hover tooltip ---------- */}
      {hover && building && hover.error && (tool !== 'place' || item) && <div className="cursor-tip">{hover.error}</div>}

      {toast && <div key={toast.id} className={`toast t-${toast.kind}`}>{toast.text}</div>}
      {banner && <div key={banner.id} className={`banner b-${banner.kind}`}><b>{banner.text}</b>{banner.sub && <span>{banner.sub}</span>}</div>}

      {/* ---------- overlays ---------- */}
      {ctrl.mode === 'online' && room && room.status === 'waiting' && <WaitingRoom code={room.code} onLeave={onExit} />}
      {ctrl.handoff !== null && (
        <div className="overlay opaque">
          <div className="card center">
            <h2>Pass the device</h2>
            <p>Hand over to <b>{ctrl.handoff === 0 ? 'Player 1' : 'Player 2'}</b>. No peeking at the screen!</p>
            <button className="btn primary big" onClick={() => ctrl.acceptHandoff()}>I am {ctrl.handoff === 0 ? 'Player 1' : 'Player 2'} - continue</button>
          </div>
        </div>
      )}
      {over && v && showResults && (
        <div className="overlay">
          <div className="card results">
            <h1 className={won ? 'win' : v.winner === 'draw' ? '' : 'lose'}>{v.winner === 'draw' ? 'DRAW' : ctrl.mode === 'hotseat' ? `${v.winner === 0 ? 'PLAYER 1' : 'PLAYER 2'} WINS` : won ? 'VICTORY' : 'DEFEAT'}</h1>
            <p className="reason">{v.winReason}</p>
            <table className="stats">
              <thead><tr><th></th><th>{v.own.name}</th><th>{v.enemy.name}</th></tr></thead>
              <tbody>
                {([
                  ['Shots fired', 'shotsFired'], ['Shots on target', 'shotsHit'], ['Damage dealt', 'damageDealt'], ['Damage taken', 'damageTaken'],
                  ['Structures destroyed', 'structuresDestroyed'], ['Value destroyed', 'score'], ['Points spent', 'pointsSpent'], ['Rounds used', 'ammoUsed'],
                ] as const).map(([label, k]) => (
                  <tr key={k}><td>{label}</td><td>{v.own.stats[k]}</td><td>{v.enemy.stats?.[k] ?? '—'}</td></tr>
                ))}
                <tr><td>Accuracy</td><td>{pct(v.own.stats.shotsHit, v.own.stats.shotsFired)}</td><td>{v.enemy.stats ? pct(v.enemy.stats.shotsHit, v.enemy.stats.shotsFired) : '—'}</td></tr>
                <tr><td>Damage per round</td><td>{ratio(v.own.stats.damageDealt, v.own.stats.ammoUsed)}</td><td>{v.enemy.stats ? ratio(v.enemy.stats.damageDealt, v.enemy.stats.ammoUsed) : '—'}</td></tr>
              </tbody>
            </table>
            <div className="row">
              <button className="btn" onClick={() => setShowResults(false)}>Review battlefield</button>
              <button className="btn primary" disabled={ctrl.mode === 'online' && !oppConnected} onClick={() => { setShowResults(true); setUndo([]); setRedo([]); ctrl.rematch(); }}>
                {ctrl.mode === 'online'
                  ? !oppConnected ? 'Opponent left' : room?.rematch.includes(room.seat) ? 'Waiting for opponent…' : `Rematch${room?.rematch.length ? ' (opponent is ready)' : ''}`
                  : 'Rematch'}
              </button>
              {onChangeSettings && <button className="btn" onClick={onChangeSettings}>Change settings</button>}
              <button className="btn ghost" onClick={onExit}>Main menu</button>
            </div>
          </div>
        </div>
      )}
      {over && !showResults && <button className="btn primary floating" onClick={() => setShowResults(true)}>Show results</button>}

      {menuOpen && (
        <div className="overlay" onClick={() => setMenuOpen(false)}>
          <div className="card menu-card" onClick={(e) => e.stopPropagation()}>
            <h2>Paused</h2>
            {ctrl.mode === 'online' && <p className="small">The match keeps running while this menu is open.</p>}
            <SettingsFields />
            <div className="row">
              <button className="btn primary" onClick={() => setMenuOpen(false)}>Resume</button>
              {ctrl.mode !== 'online' && <button className="btn" onClick={() => { setMenuOpen(false); setShowResults(true); setUndo([]); setRedo([]); ctrl.rematch(); }}>Restart match</button>}
              {!confirmQuit ? <button className="btn ghost" onClick={() => setConfirmQuit(true)}>Quit to menu</button>
                : <button className="btn danger" onClick={onExit}>{ctrl.mode === 'online' ? 'Forfeit & quit' : 'Confirm quit'}</button>}
            </div>
            <div className="keys">
              <b>Controls</b>: drag / WASD pan · wheel zoom · build: click/drag place, right-click remove, R rotate, X toggle remove, Ctrl+Z/Y undo/redo ·
              combat: ↑↓ angle, ←→ power (Shift = fine), Space fire, Q/E switch weapon, Shift-click measure range
            </div>
          </div>
        </div>
      )}
      {isTutorial && v && (
        <Tutorial view={v} step={tutorialStep} setStep={setTutorialStep} angle={angle} power={power} onDone={() => setPrefs({ tutorialDone: true })} onExit={onExit} />
      )}
    </div>
  );
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const ratio = (a: number, b: number) => (b ? (a / b).toFixed(1) : '—');

function Wind({ wind, exact }: { wind: number; exact: boolean }) {
  const mag = Math.abs(wind);
  const arrows = mag < 0.05 ? '·' : (wind > 0 ? '→' : '←').repeat(mag > 0.8 ? 3 : mag > 0.4 ? 2 : 1);
  return (
    <div className="wind" title={exact ? 'Exact wind (radar)' : 'Estimated wind - build a Radar Station for exact readings'}>
      <span>WIND</span><b>{arrows}</b><small>{exact ? '' : '≈'}{(wind * 10).toFixed(exact ? 1 : 0)}</small>
    </div>
  );
}

function NetBadge({ net, opp }: { net: string; opp: boolean }) {
  if (net !== 'connected') return <div className="net bad">{net === 'reconnecting' ? 'Reconnecting…' : net === 'connecting' ? 'Connecting…' : 'Disconnected'}</div>;
  if (!opp) return <div className="net warn">Opponent disconnected - waiting…</div>;
  return <div className="net ok">● Online</div>;
}

function WeaponSpecs({ id }: { id: keyof typeof WEAPONS }) {
  const w = WEAPONS[id];
  return (
    <>
      <span>{w.role}</span>
      <span>Angle {w.angleMin}–{w.angleMax}°</span>
      <span>DMG {w.damage}{w.projectiles > 1 ? ` ×${w.projectiles}` : ''}</span>
      <span>Blast R {w.radius}</span>
      <span>{w.ammoUse} rd/shot</span>
      <span>Reload {w.reload}</span>
      <span>+{w.includedHE} HE incl.</span>
    </>
  );
}

function WaitingRoom({ code, onLeave }: { code: string; onLeave: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overlay opaque">
      <div className="card center">
        <h2>Room created</h2>
        <p>Share this code with your opponent:</p>
        <div className="room-code">{code}</div>
        <div className="row">
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(code).then(() => setCopied(true)); }}>{copied ? 'Copied!' : 'Copy code'}</button>
          <button className="btn ghost" onClick={onLeave}>Cancel</button>
        </div>
        <p className="small pulse">Waiting for an opponent to join…</p>
      </div>
    </div>
  );
}

export function SettingsFields() {
  const [p, setP] = useState(getPrefs());
  const upd = (x: Partial<typeof p>) => { setPrefs(x); setP(getPrefs()); };
  return (
    <div className="settings-fields">
      <label>Volume <input type="range" min={0} max={1} step={0.05} value={p.volume} onChange={(e) => upd({ volume: +e.target.value })} /></label>
      <label className="check"><input type="checkbox" checked={p.followShells} onChange={(e) => upd({ followShells: e.target.checked })} /> Camera follows shells</label>
      <label className="check"><input type="checkbox" checked={p.showGrid} onChange={(e) => upd({ showGrid: e.target.checked })} /> Show build grid</label>
      <label className="check"><input type="checkbox" checked={p.reducedMotion} onChange={(e) => upd({ reducedMotion: e.target.checked })} /> Reduced effects</label>
    </div>
  );
}
