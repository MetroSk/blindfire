import { randomBytes, randomInt } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { Match } from '../shared/match';
import { sanitizeSettings, type MatchSettings } from '../shared/config';
import type { PlayerAction, Seat } from '../shared/types';

const RECONNECT_GRACE_MS = 90_000;
const ROOM_IDLE_MS = 60 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface SeatInfo {
  token: string;
  name: string;
  socketId: string | null;
  dropTimer: NodeJS.Timeout | null;
}

interface Room {
  code: string;
  settings: MatchSettings;
  seats: [SeatInfo | null, SeatInfo | null];
  match: Match | null;
  turnTimer: NodeJS.Timeout | null;
  timerKey: string;
  rematch: Set<Seat>;
  lastActivity: number;
}

export interface RoomInfo {
  code: string;
  seat: Seat;
  players: ({ name: string; connected: boolean } | null)[];
  status: 'waiting' | 'playing' | 'over';
  rematch: Seat[];
  settings: MatchSettings;
}

const cleanName = (n: unknown, fallback: string) =>
  (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 18) : '') || fallback;

export class RoomManager {
  private rooms = new Map<string, Room>();
  private socketSeat = new Map<string, { code: string; seat: Seat }>();
  private rate = new Map<string, { t: number; n: number }>();

  constructor(private io: Server) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  get roomCount() {
    return this.rooms.size;
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  attach(socket: Socket) {
    socket.on('room:create', (p: { name?: string; settings?: Partial<MatchSettings> }, cb: Function) => {
      if (typeof cb !== 'function') return;
      this.leave(socket);
      const code = this.newCode();
      const token = randomBytes(16).toString('hex');
      const room: Room = {
        code, settings: sanitizeSettings(p?.settings), seats: [null, null], match: null,
        turnTimer: null, timerKey: '', rematch: new Set(), lastActivity: Date.now(),
      };
      room.seats[0] = { token, name: cleanName(p?.name, 'Commander A'), socketId: socket.id, dropTimer: null };
      this.rooms.set(code, room);
      this.bind(socket, code, 0);
      cb({ ok: true, code, seat: 0, token });
      this.broadcastRoom(room);
    });

    socket.on('room:join', (p: { code?: string; name?: string }, cb: Function) => {
      if (typeof cb !== 'function') return;
      const code = String(p?.code ?? '').toUpperCase().trim();
      const room = this.rooms.get(code);
      if (!room) return cb({ ok: false, error: 'Room not found' });
      if (room.seats[1]) return cb({ ok: false, error: 'Room is full' });
      this.leave(socket);
      const token = randomBytes(16).toString('hex');
      room.seats[1] = { token, name: cleanName(p?.name, 'Commander B'), socketId: socket.id, dropTimer: null };
      this.bind(socket, code, 1);
      cb({ ok: true, code, seat: 1, token });
      this.startMatch(room);
    });

    socket.on('room:rejoin', (p: { code?: string; token?: string }, cb: Function) => {
      if (typeof cb !== 'function') return;
      const room = this.rooms.get(String(p?.code ?? '').toUpperCase());
      if (!room) return cb({ ok: false, error: 'Room expired' });
      const seat = room.seats.findIndex((s) => s && s.token === p?.token);
      if (seat < 0) return cb({ ok: false, error: 'Not a member of this room' });
      const info = room.seats[seat]!;
      if (info.dropTimer) clearTimeout(info.dropTimer);
      info.dropTimer = null;
      if (info.socketId && info.socketId !== socket.id) this.socketSeat.delete(info.socketId);
      info.socketId = socket.id;
      this.bind(socket, room.code, seat as Seat);
      cb({ ok: true, code: room.code, seat, token: info.token });
      this.broadcastRoom(room);
      if (room.match) this.sendView(room, seat as Seat);
    });

    socket.on('action', (a: PlayerAction, cb: Function) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      if (!this.allow(socket.id)) return reply({ ok: false, error: 'Too many actions' });
      const ref = this.socketSeat.get(socket.id);
      const room = ref && this.rooms.get(ref.code);
      if (!ref || !room || !room.match) return reply({ ok: false, error: 'No active match' });
      if (!a || typeof a !== 'object' || typeof (a as any).t !== 'string') return reply({ ok: false, error: 'Bad action' });
      room.lastActivity = Date.now();
      const m = room.match;
      let res;
      try {
        res = m.apply(ref.seat, a);
      } catch (e) {
        console.error(`[${room.code}] action failed`, a, e);
        return reply({ ok: false, error: 'Server error' });
      }
      if (!res.ok) return reply({ ok: false, error: res.error });
      reply({ ok: true });
      if (res.shot) {
        // estimate animation length so the next turn timer starts after the shell lands
        const longest = Math.max(...res.shot.projectiles.map((p) => p.points.length));
        m.state.turnStartedAt = Date.now() + Math.min(12000, longest * 25 + 1800);
        for (const s of [0, 1] as Seat[]) {
          const sid = room.seats[s]?.socketId;
          if (sid) this.io.to(sid).emit('shot', m.reportFor(res.shot, s));
        }
      }
      this.sendViews(room);
      this.scheduleTurnTimer(room);
      if (m.state.phase === 'over') this.broadcastRoom(room);
    });

    socket.on('rematch', () => {
      const ref = this.socketSeat.get(socket.id);
      const room = ref && this.rooms.get(ref.code);
      if (!ref || !room || !room.match || room.match.state.phase !== 'over') return;
      room.rematch.add(ref.seat);
      if (room.rematch.size === 2 && room.seats[0] && room.seats[1]) this.startMatch(room);
      else this.broadcastRoom(room);
    });

    socket.on('room:leave', () => this.leave(socket, true));
    socket.on('disconnect', () => this.leave(socket, false));
  }

  /** Token bucket: bursts of up to 150 actions (fast drag-building), refilling at 30/s. */
  private allow(id: string): boolean {
    const now = Date.now();
    const r = this.rate.get(id) ?? { t: now, n: 150 };
    r.n = Math.min(150, r.n + ((now - r.t) / 1000) * 30);
    r.t = now;
    this.rate.set(id, r);
    if (r.n < 1) return false;
    r.n--;
    return true;
  }

  private bind(socket: Socket, code: string, seat: Seat) {
    this.socketSeat.set(socket.id, { code, seat });
  }

  private startMatch(room: Room) {
    const seed = randomBytes(4).readUInt32LE(0);
    room.match = Match.create(room.settings, seed, [room.seats[0]!.name, room.seats[1]!.name]);
    room.rematch.clear();
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.timerKey = '';
    this.broadcastRoom(room);
    this.sendViews(room);
  }

  private scheduleTurnTimer(room: Room) {
    const m = room.match;
    if (!m) return;
    const st = m.state;
    const k = st.phase === 'combat' ? `${st.turn}:${st.active}` : '';
    if (k === room.timerKey) return;
    room.timerKey = k;
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    if (!k || !st.settings.turnTime) return;
    const ms = Math.max(0, st.turnStartedAt - Date.now()) + st.settings.turnTime * 1000 + 500;
    room.turnTimer = setTimeout(() => {
      if (room.match !== m || `${m.state.turn}:${m.state.active}` !== k || m.state.phase !== 'combat') return;
      m.timeoutTurn();
      this.sendViews(room);
      this.scheduleTurnTimer(room);
      if ((m.state.phase as string) === 'over') this.broadcastRoom(room);
    }, ms);
  }

  private sendView(room: Room, seat: Seat) {
    const sid = room.seats[seat]?.socketId;
    if (sid && room.match) this.io.to(sid).emit('view', room.match.viewFor(seat));
  }

  private sendViews(room: Room) {
    this.sendView(room, 0);
    this.sendView(room, 1);
  }

  private info(room: Room, seat: Seat): RoomInfo {
    return {
      code: room.code,
      seat,
      players: room.seats.map((s) => (s ? { name: s.name, connected: !!s.socketId } : null)),
      status: !room.match ? 'waiting' : room.match.state.phase === 'over' ? 'over' : 'playing',
      rematch: [...room.rematch],
      settings: room.settings,
    };
  }

  private broadcastRoom(room: Room) {
    for (const s of [0, 1] as Seat[]) {
      const sid = room.seats[s]?.socketId;
      if (sid) this.io.to(sid).emit('room', this.info(room, s));
    }
  }

  private leave(socket: Socket, explicit = false) {
    const ref = this.socketSeat.get(socket.id);
    this.socketSeat.delete(socket.id);
    this.rate.delete(socket.id);
    if (!ref) return;
    const room = this.rooms.get(ref.code);
    if (!room) return;
    const info = room.seats[ref.seat];
    if (!info || info.socketId !== socket.id) return;
    info.socketId = null;
    const m = room.match;
    const live = m && m.state.phase !== 'over';
    if (explicit || !live) {
      if (live) {
        m!.forfeit(ref.seat, `${info.name} left the match`);
        this.sendViews(room);
      }
      if (explicit) room.seats[ref.seat] = null;
      if (!room.seats[0]?.socketId && !room.seats[1]?.socketId) {
        this.destroy(room);
        return;
      }
      if (!m) {
        // waiting room: promote remaining player to host seat
        if (!room.seats[0] && room.seats[1]) {
          room.seats[0] = room.seats[1];
          room.seats[1] = null;
          const sid = room.seats[0].socketId;
          if (sid) this.socketSeat.set(sid, { code: room.code, seat: 0 });
        }
      }
      this.broadcastRoom(room);
      return;
    }
    // unexpected drop mid-match: hold the seat for a while
    info.dropTimer = setTimeout(() => {
      if (info.socketId) return;
      if (room.match && room.match.state.phase !== 'over') {
        room.match.forfeit(ref.seat, `${info.name} disconnected`);
        this.sendViews(room);
      }
      this.broadcastRoom(room);
      if (!room.seats[0]?.socketId && !room.seats[1]?.socketId) this.destroy(room);
    }, RECONNECT_GRACE_MS);
    this.broadcastRoom(room);
  }

  private destroy(room: Room) {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    for (const s of room.seats) if (s?.dropTimer) clearTimeout(s.dropTimer);
    this.rooms.delete(room.code);
  }

  private sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) if (now - room.lastActivity > ROOM_IDLE_MS) this.destroy(room);
  }
}
