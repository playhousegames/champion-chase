// --- Turbo Tails server (Express + Socket.IO) ---
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const path     = require('path');
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ---- Config ----
const MAX_PLAYERS  = 4;   // hard cap
const MIN_TO_START = 2;   // host can start with 2+

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- In-memory rooms ----
const rooms = {};

// ---- Helpers (global lobby → assign to a waiting room) ----
function generateRoomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[(Math.random() * chars.length) | 0];
  return code;
}

// safer: server assigns names; clients can't inject rude words
const ANIMALS = ['Moose', 'Wolf', 'Horse', 'Panda'];
const ADJS    = ['Turbo', 'Speedy', 'Pixel', 'Retro', 'Hyper', 'Rocket', 'Mega', 'Neon'];
function generatePlayerName(slotNum) {
  const a = ADJS[Math.floor(Math.random() * ADJS.length)];
  const b = ANIMALS[(slotNum - 1) % ANIMALS.length];
  const n = (Math.random() * 90 + 10) | 0; // 10–99
  return `${a} ${b} ${n}`;
}

function getOrCreateWaitingRoom() {
  // Reuse the first room that hasn't started and has space
  for (const [rid, room] of Object.entries(rooms)) {
    const count = Object.keys(room.players).length;
    if (!room.gameStarted && !room.isResetting && count < MAX_PLAYERS) {
      return rid;
    }
  }
  // Otherwise create a new one
  let rid = generateRoomCode();
  while (rooms[rid]) rid = generateRoomCode();
  rooms[rid] = {
    players: {},
    positions: {},
    speeds: {},
    gameStarted: false,
    finishTimes: {},
    isResetting: false,
    hostSocketId: null,
    tapStreaks: {},
    stopTimers: {}
  };
  return rid;
}

// ---- Sockets ----
io.on('connection', (socket) => {
  console.log('Runner connected:', socket.id);

  // GLOBAL LOBBY → assign this socket to an open room (no code shown to the user)
  socket.on('quickRace', () => {
    const rid = getOrCreateWaitingRoom();

    socket.join(rid);
    socket.roomId = rid;

    // Tell only this socket which room it’s in (kept internal)
    socket.emit('roomAssigned', { roomId: rid, maxPlayers: MAX_PLAYERS, minToStart: MIN_TO_START });

    // Send current roster so client can grey out taken slots immediately
    const room = rooms[rid];
    socket.emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });
  });

  // Player claims a runner slot and joins the room roster
  socket.on('joinRoom', (data) => {
    const { roomId, playerNum } = data;
    // Prefer server-assigned room (from quickRace); fall back to provided; final fallback dev default
    const rid = ((socket.roomId || roomId || 'ABC124') + '').toUpperCase();

    // Create room if needed (should exist if quickRace was used)
    if (!rooms[rid]) {
      rooms[rid] = {
        players: {},
        positions: {},
        speeds: {},
        gameStarted: false,
        finishTimes: {},
        isResetting: false,
        hostSocketId: null,
        tapStreaks: {},
        stopTimers: {}
      };
    }
    const room = rooms[rid];
    if (room.isResetting) return;

    // Capacity check (4 max)
    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      socket.emit('roomFull', { max: MAX_PLAYERS });
      return;
    }

    // 🔒 Slot guard: if another socket already owns this playerNum, reject
    const existing = room.players[playerNum];
    if (existing && existing.socketId !== socket.id) {
      socket.emit('slotTaken', { playerNum });
      return;
    }

    // Server assigns a *safe* fun name (ignores client-provided text)
    const safeName = generatePlayerName(playerNum);

    // Register / update player
    room.players[playerNum]   = { name: safeName, id: playerNum, socketId: socket.id };
    room.positions[playerNum] = 20;
    room.speeds[playerNum]    = 0;

    // First actual player becomes host
    if (!room.hostSocketId) room.hostSocketId = socket.id;

    socket.join(rid);
    socket.roomId = rid;

    // Broadcast updated roster (include host + caps)
    io.to(rid).emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });

    // Auto-start when the room is full (still allow host-start for 2–3)
    if (Object.keys(room.players).length === MAX_PLAYERS && !room.gameStarted) {
      room.gameStarted = true;
      room.finishTimes = {};
      const startPos = 20;
      Object.keys(room.players).forEach(pid => {
        room.positions[pid] = startPos;
        room.speeds[pid] = 0;
      });
      io.to(rid).emit('gameStarted', {
        positions: room.positions,
        speeds: room.speeds
      });
      console.log(`Race auto-started in ${rid} (room full)`);
    }
  });

  // Host starts the race (server-enforced host check)
  socket.on('startGame', (rid) => {
    const room = rooms[rid];
    if (!room || room.isResetting) return;

    // Only host can start
    if (room.hostSocketId && room.hostSocketId !== socket.id) {
      console.log(`Non-host tried to start room ${rid}`);
      return;
    }

    // Enforce minimum players
    if (Object.keys(room.players).length < MIN_TO_START) {
      console.log(`Race NOT started in ${rid} — need at least ${MIN_TO_START} players`);
      return;
    }

    room.gameStarted = true;
    room.finishTimes = {};
    const startPos = 20;
    Object.keys(room.players).forEach(pid => {
      room.positions[pid] = startPos;
      room.speeds[pid] = 0;
    });

    io.to(rid).emit('gameStarted', {
      positions: room.positions,
      speeds: room.speeds
    });

    console.log(`Race started in ${rid} with ${Object.keys(room.players).length} runners`);
  });

  // Tap action (boost based on tap cadence) + ANIMATION SYNC
  socket.on('playerAction', ({ roomId: rid, playerId }) => {
    const room = rooms[rid];
    if (!room || !room.players[playerId]) return;

    const now  = Date.now();
    const last = room.tapStreaks[playerId] || 0;
    const diff = now - last;

    let boost = 8;
    if (diff < 200) boost = 12;    // quick
    if (diff < 120) boost = 16;    // frantic

    room.positions[playerId] = (room.positions[playerId] || 20) + boost;
    room.speeds[playerId] = boost;
    room.tapStreaks[playerId] = now;

    // broadcast state
    io.to(rid).emit('updateState', {
      positions: room.positions,
      speeds: room.speeds
    });

    // start/stop animation notifications to *all* clients
    io.to(rid).emit('startAnimation', { playerId });
    clearTimeout(room.stopTimers[playerId]);
    room.stopTimers[playerId] = setTimeout(() => {
      io.to(rid).emit('stopAnimation', { playerId });
    }, 300);
  });

  // Client reports a finish time (simple: trust client for now)
  socket.on('checkFinish', ({ roomId: rid, playerId, finishTime }) => {
    const room = rooms[rid];
    if (!room) return;
    room.finishTimes[playerId] = finishTime;
    io.to(rid).emit('endRace', room.finishTimes);
  });

  // Force end (e.g., all finished)
  socket.on('endRace', (rid) => {
    const room = rooms[rid];
    if (!room) return;
    io.to(rid).emit('endRace', room.finishTimes);
  });

  // Reset a room back to lobby
  socket.on('resetRoom', (rid) => {
    const room = rooms[rid];
    if (!room) return;
    room.isResetting = true;

    setTimeout(() => {
      rooms[rid] = {
        players: {},
        positions: {},
        speeds: {},
        gameStarted: false,
        finishTimes: {},
        isResetting: false,
        hostSocketId: null,
        tapStreaks: {},
        stopTimers: {}
      };
      io.to(rid).emit('roomReset', {});
      console.log(`Room ${rid} reset`);
    }, 500);
  });

  // Handle disconnects (remove players, reassign host, rebroadcast roster)
  socket.on('disconnect', () => {
    console.log('Runner disconnected:', socket.id);

    for (const [rid, room] of Object.entries(rooms)) {
      let changed = false;

      for (const [pid, player] of Object.entries(room.players)) {
        if (player.socketId === socket.id) {
          delete room.players[pid];
          delete room.positions[pid];
          delete room.speeds[pid];
          changed = true;
        }
      }

      if (!changed) continue;

      // Reassign host if host left
      if (room.hostSocketId === socket.id) {
        const next = Object.values(room.players)[0];
        room.hostSocketId = next ? next.socketId : null;
      }

      io.to(rid).emit('playerJoined', {
        players: room.players,
        positions: room.positions,
        speeds: room.speeds,
        hostSocketId: room.hostSocketId,
        maxPlayers: MAX_PLAYERS,
        minToStart: MIN_TO_START
      });
    }
  });
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Turbo Tails server running on http://localhost:${PORT}`);

  // Print LAN URL for phones on same Wi-Fi
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`On your LAN:  http://${net.address}:${PORT}`);
      }
    }
  }
});
