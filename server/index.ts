import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomManager } from './rooms';

const PORT = Number(process.env.PORT) || 3001;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const app = express();
const http = createServer(app);
const io = new Server(http, {
  // The static client may be hosted elsewhere (e.g. GitHub Pages), so allow cross-origin sockets.
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' },
  pingInterval: 10_000,
  pingTimeout: 15_000,
});
const rooms = new RoomManager(io);

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.roomCount, uptime: Math.round(process.uptime()) }));

if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
} else {
  app.get('/', (_req, res) => res.send('BLINDFIRE server running. Build the client with `npm run build` to serve it from here.'));
}

io.on('connection', (socket) => rooms.attach(socket));

http.listen(PORT, () => console.log(`BLINDFIRE server listening on :${PORT}`));
