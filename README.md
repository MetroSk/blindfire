# BLINDFIRE — Fortify · Conceal · Bombard

A turn-based browser strategy game. You build a hidden fortress on a points budget, then hunt the enemy's base with indirect artillery fire.

You never see the enemy base. You infer it from where your shells stop, from craters, collapses, radar ghosts and the arcs of incoming shells.

- **Single player** against three AI commanders (Cadet / Sergeant / Colonel).
- **Online multiplayer** with private room codes and a server-authoritative Node + Socket.IO backend.
- **Local hot-seat** with a pass-the-device screen that hides each player's base.
- **Interactive tutorial**, sound (synthesised with WebAudio), and a responsive layout.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/MetroSk/blindfire)

---

## Rules in one minute

1. **Build.** Both sides build at the same time and in secret, inside their own zone, with the same budget (1000 pts by default). You must place a **Command Core** (free) and at least one weapon. Blocks need support: ground, a block directly below, or a sideways link within the material's **span** (wood 2, stone 1, steel 3…). When a support is destroyed in combat, everything it held collapses and takes fall damage.
2. **Aim.** Players alternate turns. Pick a weapon, ammo, **angle** and **power**. The dashed preview simulates the shell against terrain, your own base and the wind you can read (exact only with a Radar Station). It never shows the enemy base. **Solve power** computes the power for a typed range. Shift-click the field to measure a range.
3. **Observe.** A shell that stops in mid-air hit something hidden. Damaged enemy cells are marked (`?`), the core as `★`, destroyed cells as `✕`. Recon flares reveal an area. Radar estimates enemy launch sites, and decoys fake those sightings. Smoke hides impacts and launches inside it.
4. **Win.** Destroy the enemy Command Core (default). Optional rules also end the game when all artillery is destroyed or base integrity falls below 35%. At the turn limit, or when both sides are out of firepower, the higher **value destroyed** wins.

### Controls
| | |
|---|---|
| Pan / zoom | drag, WASD, mouse wheel; minimap click |
| Build | click/drag to place, right-click to remove, **R** rotate, **X** remove tool, **Ctrl+Z / Ctrl+Y** undo/redo, Move tool to reposition |
| Combat | **↑/↓** angle, **←/→** power (Shift = fine), **Space** fire, **Q/E** switch weapon, Shift-click to measure range |
| Menu | **Esc** |

### Catalog (balance lives in [`shared/config.ts`](shared/config.ts))
| Item | Cost | Role |
|---|---|---|
| Wooden / Stone / Steel block | 10 / 20 / 35 | Structure; spans 2 / 1 / 3 |
| Foundation | 15 | Ground only; stays anchored when the ground beneath is cratered |
| Reinforced armor | 50 | Takes ×0.45 from blast, but AP still punches through |
| Concrete bunker | 45 | Best blast protection (×0.4) |
| Sandbag wall | 12 | Nearly immune to fragments; supports nothing |
| Sloped armor | 30 | Rotatable; direct hits on the slope deal 40% less |
| Light mortar / Heavy mortar | 100 / 180 | High arc; short range / huge blast, slow reload |
| Field cannon | 150 | Flat, precise, small blast; takes AP rounds |
| Heavy howitzer | 250 | Long range, heavy damage, 2 rounds per shot |
| Rocket launcher | 200 | 3-rocket salvo, boost-phase flight, wind-sensitive |
| Anti-artillery turret | 180 | 30% (rockets 45%) chance to intercept shells passing nearby |
| Radar station | 120 | Exact wind and estimated enemy launch sites |
| Decoy | 40 | Fake radar flashes; looks like a gun to recon |
| Repair station | 100 | +15 HP to up to 3 nearby blocks each turn |
| Ammunition crate | 50 | +12 HE cheaply, but explodes and loses its rounds if hit |

Ammo: **HE** (blast, craters), **AP** (pierces 2 blocks), **FRAG** (wide burst, shreds light targets), **Smoke** (screen), **Recon** (reveal).

---

## Run locally

Requires Node 18+.

```bash
npm install
npm run dev        # client on http://localhost:5173 + server on :3001 (hot reload)
```

Production-style (one process serves the client and the multiplayer server):

```bash
npm run build
npm start          # http://localhost:3001
```

Tests:

```bash
npm test           # engine unit tests: ballistics, budget, collision, damage, collapse, turns, visibility, victory, AI-vs-AI
npm start & npm run test:mp   # end-to-end: two socket clients create/join a room and play a full match + rematch
npx tsx scripts/balance.ts    # AI-vs-AI balance report
```

## Free hosting

| What | Where | Cost |
|---|---|---|
| Static client (single player, hot-seat, tutorial) | **GitHub Pages**, via `.github/workflows/pages.yml` on every push to `main` | free |
| Full game + multiplayer server | **Render** free web service via `render.yaml` (button above) | free (sleeps after 15 min idle; the first visit takes ~50 s to wake up) |

1. Click **Deploy to Render** above, sign in with GitHub and accept the blueprint. You get a URL like `https://blindfire-xxxx.onrender.com` with the complete game, multiplayer included.
2. Optional: point the GitHub Pages build at that server. In the repo, go to *Settings → Secrets and variables → Actions → Variables*, add `SERVER_URL = https://blindfire-xxxx.onrender.com`, then re-run the *Deploy to GitHub Pages* workflow. Players can also paste a server address under *Online → Advanced*.

Any Node host with WebSocket support works the same way (`npm install --include=dev && npm run build`, then `npm start`; it honours `PORT`). Set `CORS_ORIGIN` to restrict which sites may connect.

## Architecture

```
shared/          deterministic game engine, used by both browser and server
  config.ts        all balance data (items, weapons, ammo, rules, match settings)
  terrain.ts       heightmap generation, craters, ground rows
  ballistics.ts    fixed-step projectile sim (gravity, wind, rocket boost), swept collision, power solver
  construction.ts  placement / removal validation
  structure.ts     support propagation (0-1 BFS with material spans) and collapse
  damage.ts        material resistances, blast falloff, sloped armor
  match.ts         match state, economy, turns, firing, AA, radar, smoke, victory, per-player view filtering
  ai.ts            heuristic builder and gunner (sees only its own PlayerView)
  botBuild.ts      turns an AI base plan into normal player actions (used by remote bots)
server/          Express + Socket.IO: rooms, codes, reconnect tokens, turn timers, rate limiting
client/src/      React UI + Canvas renderer
  game/renderer.ts   battlefield drawing, camera, input, shot animation, particles, minimap
  game/controller.ts LocalAI / Hotseat / Online controllers behind one interface
  ui/                HUD, build catalog, aiming panel, tutorial, results
tests/           vitest suites
scripts/         multiplayer smoke test, balance probe, match tracer
```

**Hidden information.** The authoritative `MatchState` never leaves the server. Each client receives only `Match.viewFor(seat)`: its own blocks, public terrain and smoke, its own intel (revealed cells, radar detections, observed incoming arcs) and the log entries addressed to it. Shot results are filtered per viewer by `Match.reportFor(shot, seat)`. The shooter sees their shell's full path and what it revealed. The target sees only the part of the arc over its own half, plus its own damage. The enemy layout is sent only after the match ends, for the battlefield review. The AI gets the same filtered view, so it cannot cheat.

**Server authority.** The server validates every action: membership, phase, turn, weapon ownership, operational state, barrel clearance, ammo compatibility and count, angle and power limits, budget, placement and support rules. It runs the simulation with a server-side RNG (spread, wind, interception, radar error), decides victory, and enforces turn timers. A disconnected player has 90 s to reconnect (page reloads resume automatically) before forfeiting.

## Implemented

- Point-based construction with live budget, catalog categories, ghost preview, invalid-placement reasons, drag painting, rotate, move, remove, undo/redo, and an ammo shop
- Grid structural integrity with spans, collapse, fall and landing damage, and foundations anchored against cratering
- 5 weapons with distinct arcs, ranges, blast radii, reloads and ammo use. Rockets have boost-phase flight. 5 ammo types
- Wind (exact vs. estimated), destructible terrain, AA interception, radar with decoys, smoke screens, recon flares, repair stations, exploding ammo crates, friendly fire
- Hidden bases with configurable reveal rules (`none` / `hit` / `area`), plus a casual open-bases mode
- Victory modes, a stalemate and turn-limit tiebreak, and a results screen with accuracy, damage per round, battlefield review and rematch
- AI with 3 difficulty levels. It builds with the same rules and budget, learns aim corrections from its misses, extrapolates incoming arcs, uses radar sightings, sweeps the enemy zone systematically, and targets known guns, the core and supports. Balance over 40 games per pairing: Colonel beats Sergeant 22–18 and Sergeant beats Cadet 30–10
- Online rooms (5-character codes), waiting / connected / opponent-disconnected / reconnecting states, rematch voting, forfeit on quit
- Hot-seat with a cover screen and a replay of the incoming fire for the next player
- Skippable interactive tutorial with 13 steps

## Known limitations

- The turn timer is displayed using the server's timestamp, so a client with a badly skewed clock shows a slightly wrong countdown. The server still enforces the correct time.
- Rooms live in server memory. Restarting the server (or Render's free tier going to sleep) ends rooms that are in progress.
- There is no frame-by-frame replay. The end screen offers a full battlefield review (both bases revealed, your impact markers) instead.
- No accounts or persistent match history. Settings and tutorial progress are stored in `localStorage`.
