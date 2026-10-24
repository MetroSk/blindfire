import { io, type Socket } from 'socket.io-client';
import { Match, other } from '../../../shared/match';
import { aiBuild, aiChooseAction, newAIMemory, AI_NAMES, type AIMemory } from '../../../shared/ai';
import { Rng, randomSeed } from '../../../shared/rng';
import type { MatchSettings } from '../../../shared/config';
import type { Difficulty, PlayerAction, PlayerView, Seat, ShotOutcome, ShotReport } from '../../../shared/types';
import { resolveServerUrl } from '../prefs';

export type Mode = 'ai' | 'hotseat' | 'online' | 'tutorial';
export type NetStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface RoomInfo {
  code: string;
  seat: Seat;
  players: ({ name: string; connected: boolean } | null)[];
  status: 'waiting' | 'playing' | 'over';
  rematch: Seat[];
  settings: MatchSettings;
}

export interface Controller {
  mode: Mode;
  view: PlayerView | null;
  /** Hot-seat: the device must be passed to this seat before continuing. */
  handoff: Seat | null;
  room: RoomInfo | null;
  net: NetStatus;
  send(a: PlayerAction): Promise<{ ok: boolean; error?: string }>;
  /** Renderer calls this once a shot animation has finished. */
  animationDone(): void;
  acceptHandoff(): void;
  rematch(): void;
  dispose(): void;
  on(ev: 'view' | 'change', fn: () => void): () => void;
  on(ev: 'shot', fn: (r: ShotReport) => void): () => void;
}

type Listener = (...a: any[]) => void;

abstract class Base {
  view: PlayerView | null = null;
  handoff: Seat | null = null;
  room: RoomInfo | null = null;
  net: NetStatus = 'connected';
  private listeners: Record<string, Set<Listener>> = {};
  on(ev: string, fn: Listener) {
    (this.listeners[ev] ??= new Set()).add(fn);
    return () => this.listeners[ev].delete(fn);
  }
  protected emit(ev: string, ...a: any[]) {
    this.listeners[ev]?.forEach((f) => f(...a));
  }
  acceptHandoff() {}
  rematch() {}
  dispose() {}
}

// ---------------------------------------------------------------- vs computer
export class LocalAIController extends Base implements Controller {
  mode: Mode;
  match!: Match;
  private aiMem: AIMemory = newAIMemory();
  private aiRng = new Rng(randomSeed());
  private animating = 0;
  private aiTimer: number | null = null;

  constructor(private settings: Partial<MatchSettings>, private diff: Difficulty, private playerName: string, tutorial = false) {
    super();
    this.mode = tutorial ? 'tutorial' : 'ai';
    this.start();
  }

  private start() {
    this.match = Match.create(this.settings, randomSeed(), [this.playerName || 'You', AI_NAMES[this.diff]]);
    this.aiMem = newAIMemory();
    aiBuild(this.match, 1, this.diff, new Rng(randomSeed()));
    this.push();
  }

  private push() {
    this.view = this.match.viewFor(0);
    this.emit('view');
    this.maybeAI();
  }

  private emitShot(shot: ShotOutcome) {
    this.animating++;
    this.emit('shot', this.match.reportFor(shot, 0));
  }

  async send(a: PlayerAction) {
    if (this.match.state.phase === 'combat' && this.match.state.active !== 0) return { ok: false, error: 'Not your turn' };
    const r = this.match.apply(0, a);
    if (r.shot) this.emitShot(r.shot);
    if (r.ok) this.push();
    return { ok: r.ok, error: r.error };
  }

  animationDone() {
    this.animating = Math.max(0, this.animating - 1);
    this.maybeAI();
  }

  private maybeAI() {
    const st = this.match.state;
    if (st.phase !== 'combat' || st.active !== 1 || this.animating > 0 || this.aiTimer !== null) return;
    this.aiTimer = window.setTimeout(() => {
      this.aiTimer = null;
      if (st.phase !== 'combat' || this.match.state.active !== 1 || this.animating > 0) return;
      const act = aiChooseAction(this.match.viewFor(1), this.aiMem, this.diff, this.aiRng);
      let r = this.match.apply(1, act);
      if (!r.ok) r = this.match.apply(1, { t: 'endTurn' });
      if (r.shot) this.emitShot(r.shot);
      this.push();
    }, 900);
  }

  rematch() {
    if (this.aiTimer !== null) clearTimeout(this.aiTimer);
    this.aiTimer = null;
    this.animating = 0;
    this.start();
  }

  dispose() {
    if (this.aiTimer !== null) clearTimeout(this.aiTimer);
  }
}

// ------------------------------------------------------------ local hot-seat
export class HotseatController extends Base implements Controller {
  mode: Mode = 'hotseat';
  match!: Match;
  private viewer: Seat = 0;
  private pendingIncoming: Record<Seat, ShotReport[]> = { 0: [], 1: [] };
  private animating = 0;

  constructor(private settings: Partial<MatchSettings>, private names: [string, string]) {
    super();
    this.start();
  }

  private start() {
    this.match = Match.create(this.settings, randomSeed(), this.names);
    this.viewer = 0;
    this.pendingIncoming = { 0: [], 1: [] };
    this.handoff = null;
    this.push();
  }

  private push() {
    this.view = this.handoff === null ? this.match.viewFor(this.viewer) : null;
    this.emit('view');
    this.emit('change');
  }

  async send(a: PlayerAction) {
    const st = this.match.state;
    const before = st.phase;
    const r = this.match.apply(this.viewer, a);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.shot) {
      this.animating++;
      this.emit('shot', this.match.reportFor(r.shot, this.viewer));
      this.pendingIncoming[other(this.viewer)].push(this.match.reportFor(r.shot, other(this.viewer)));
    }
    // building: hand over once this player is done
    if (before === 'build' && a.t === 'ready' && a.ready) {
      const o = other(this.viewer);
      if (!st.players[o].ready) this.handoff = o;
      else if (st.phase === 'combat' && st.active !== this.viewer) this.handoff = st.active;
    }
    this.push();
    if (!r.shot) this.checkTurnHandoff();
    return { ok: true };
  }

  animationDone() {
    this.animating = Math.max(0, this.animating - 1);
    if (this.animating === 0) this.checkTurnHandoff();
  }

  private checkTurnHandoff() {
    const st = this.match.state;
    if (this.animating > 0 || this.handoff !== null) return;
    if (st.phase === 'combat' && st.active !== this.viewer) {
      this.handoff = st.active;
      this.push();
    }
  }

  acceptHandoff() {
    if (this.handoff === null) return;
    this.viewer = this.handoff;
    this.handoff = null;
    this.push();
    // replay what the previous player's fire looked like from this side
    const q = this.pendingIncoming[this.viewer];
    this.pendingIncoming[this.viewer] = [];
    for (const rep of q) {
      this.animating++;
      this.emit('shot', rep);
    }
  }

  rematch() {
    this.animating = 0;
    this.start();
  }
}

// --------------------------------------------------------------------- online
export class OnlineController extends Base implements Controller {
  mode: Mode = 'online';
  socket: Socket;
  private session: { code: string; token: string } | null = null;
  error: string | null = null;

  constructor(url = resolveServerUrl()) {
    super();
    this.net = 'connecting';
    this.socket = io(url, { transports: ['websocket', 'polling'], reconnectionDelayMax: 4000, timeout: 20000 });
    this.socket.on('connect', () => {
      this.net = 'connected';
      if (this.session) {
        this.socket.emit('room:rejoin', this.session, (r: any) => {
          if (!r.ok) {
            this.error = r.error;
            this.session = null;
            sessionStorage.removeItem('blindfire.session');
          }
          this.emit('change');
        });
      }
      this.emit('change');
    });
    this.socket.on('disconnect', () => {
      this.net = this.session ? 'reconnecting' : 'disconnected';
      this.emit('change');
    });
    this.socket.on('connect_error', () => {
      this.net = this.session ? 'reconnecting' : 'disconnected';
      this.emit('change');
    });
    this.socket.on('room', (info: RoomInfo) => {
      this.room = info;
      this.emit('change');
    });
    this.socket.on('view', (v: PlayerView) => {
      this.view = v;
      this.emit('view');
      this.emit('change');
    });
    this.socket.on('shot', (r: ShotReport) => this.emit('shot', r));
  }

  /** Try to resume a session saved in this tab (page reload). */
  tryResume(): boolean {
    try {
      const s = JSON.parse(sessionStorage.getItem('blindfire.session') || 'null');
      if (s?.code && s?.token) {
        this.session = s;
        if (this.socket.connected) this.socket.emit('room:rejoin', s, (r: any) => { if (!r.ok) this.session = null; this.emit('change'); });
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  private remember(r: any) {
    this.session = { code: r.code, token: r.token };
    sessionStorage.setItem('blindfire.session', JSON.stringify(this.session));
  }

  create(name: string, settings: Partial<MatchSettings>): Promise<{ ok: boolean; error?: string; code?: string }> {
    return new Promise((res) =>
      this.socket.timeout(10000).emit('room:create', { name, settings }, (err: any, r: any) => {
        if (err) return res({ ok: false, error: 'Server did not respond' });
        if (r.ok) this.remember(r);
        res(r);
      }),
    );
  }

  join(code: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((res) =>
      this.socket.timeout(10000).emit('room:join', { code, name }, (err: any, r: any) => {
        if (err) return res({ ok: false, error: 'Server did not respond' });
        if (r.ok) this.remember(r);
        res(r);
      }),
    );
  }

  send(a: PlayerAction): Promise<{ ok: boolean; error?: string }> {
    return new Promise((res) =>
      this.socket.timeout(8000).emit('action', a, (err: any, r: any) => res(err ? { ok: false, error: 'Connection problem' } : r)),
    );
  }

  animationDone() {}

  rematch() {
    this.socket.emit('rematch');
  }

  dispose() {
    this.socket.emit('room:leave');
    sessionStorage.removeItem('blindfire.session');
    this.socket.close();
  }
}
