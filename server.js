
// --- Sushi Sprint server (Express + Socket.IO) ---
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const path     = require('path');
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const SPEED_MULTIPLIER = 3; // try 2, 3, or 4 until it feels right

// ---- Config ----
const MAX_PLAYERS  = 4;   // hard cap
const MIN_TO_START = 2;   // host can start with 2+

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- In-memory rooms ----
const rooms = {};

// ---- Bot System ----
const BOT_NAMES = [
  'Turbo Bot', 'Speed Bot', 'Fast Bot', 'Quick Bot',
  'Robo Racer', 'CPU Sprinter', 'AI Runner', 'Bot Dasher'
];

const botIntervals = {}; // Store bot tap intervals
const botFillTimers = {}; // Store timers for filling rooms with bots

// Create a bot player
function createBot(roomId, slotNum) {
  const room = rooms[roomId];
  if (!room || room.players[slotNum]) return null;

  const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' ' + slotNum;
  const botId = 'bot_' + slotNum + '_' + Date.now();

  room.players[slotNum] = {
    name: botName,
    id: slotNum,
    socketId: botId,
    isBot: true
  };
  room.positions[slotNum] = 20;
  room.speeds[slotNum] = 0;

  console.log(`Bot ${botName} added to room ${roomId} in slot ${slotNum}`);
  return room.players[slotNum];
}

// Fill empty slots with bots
function fillWithBots(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  const realPlayerCount = Object.keys(room.players).filter(
    pid => !room.players[pid].isBot
  ).length;

  // Only fill if we have at least 1 real player
  if (realPlayerCount < 1) return;

  let botsAdded = false;
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    if (!room.players[i]) {
      createBot(roomId, i);
      botsAdded = true;
    }
  }

  if (botsAdded) {
    // Broadcast updated roster
    io.to(roomId).emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });

    // Auto-start the game after bots are added
    setTimeout(() => {
      if (room && !room.gameStarted && Object.keys(room.players).length >= MIN_TO_START) {
        startGame(roomId);
      }
    }, 2000); // Give players 2 seconds to see the bots joined
  }
}

// Start bot AI after race begins
function startBotAI(roomId, playerId, delay = 0) {
  const room = rooms[roomId];
  if (!room || !room.players[playerId] || !room.players[playerId].isBot) return;

  // Clear any existing interval
  const intervalKey = roomId + '_' + playerId;
  if (botIntervals[intervalKey]) {
    clearInterval(botIntervals[intervalKey]);
  }

  // Randomize bot skill: tap every 150-400ms (varies per bot)
  const botSpeed = 150 + Math.random() * 250;
  const variance = 50; // Add randomness to each tap

  // Wait for countdown to finish before starting bot
  setTimeout(() => {
    botIntervals[intervalKey] = setInterval(() => {
    if (!room.gameStarted || room.finishTimes[playerId]) {
      clearInterval(botIntervals[intervalKey]);
      delete botIntervals[intervalKey];
      return;
    }

    // Simulate tap with slight randomness
    const tapDelay = Math.random() * variance - variance/2;
    
    setTimeout(() => {
      if (room.gameStarted && !room.finishTimes[playerId]) {
        // Simulate the same tap logic as real players
        const now = Date.now();
        const last = room.tapStreaks[playerId] || 0;
        const diff = now - last;

        let boost = 24;
        if (diff < 200) boost = 48;
        if (diff < 120) boost = 64;

        room.positions[playerId] = (room.positions[playerId] || 20) + boost;
        room.speeds[playerId] = boost;
        room.tapStreaks[playerId] = now;

        io.to(roomId).emit('updateState', {
          positions: room.positions,
          speeds: room.speeds
        });

        io.to(roomId).emit('startAnimation', { playerId });
        clearTimeout(room.stopTimers[playerId]);
        room.stopTimers[playerId] = setTimeout(() => {
          io.to(roomId).emit('stopAnimation', { playerId });
        }, 300);
      }
    }, Math.max(0, tapDelay));
    }, botSpeed);
  }, delay); // Wait for countdown before starting bot tapping
}

// Stop all bot AI in a room
function stopBotAI(roomId) {
  Object.keys(botIntervals).forEach(key => {
    if (key.startsWith(roomId + '_')) {
      clearInterval(botIntervals[key]);
      delete botIntervals[key];
    }
  });
}

// Automatically reset a room a few seconds after race ends
function scheduleAutoReset(rid, delayMs = 10000) {
  const room = rooms[rid];
  if (!room) return;

  // Prevent multiple resets stacking
  if (room.autoResetTimer) {
    clearTimeout(room.autoResetTimer);
  }

  room.autoResetTimer = setTimeout(() => {
    console.log(`Auto-resetting room ${rid} after race`);
    io.to(rid).emit('resetRoom', rid);

    rooms[rid] = {
      players: {},
      positions: {},
      speeds: {},
      gameStarted: false,
      finishTimes: {},
      isResetting: false,
      hostSocketId: null,
      tapStreaks: {},
      stopTimers: {},
      autoResetTimer: null
    };
  }, delayMs);
}


// Helper function to start game
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  room.gameStarted = true;
  room.finishTimes = {};
  const startPos = 20;
  
  Object.keys(room.players).forEach(pid => {
    room.positions[pid] = startPos;
    room.speeds[pid] = 0;
    
    // Start bot AI with 4 second delay (3 second countdown + 1 second "GO!")
    if (room.players[pid].isBot) {
      startBotAI(roomId, pid, 4000);
    }
  });
  
  io.to(roomId).emit('gameStarted', {
    positions: room.positions,
    speeds: room.speeds,
    players: room.players
  });
  
  console.log(`Race started in ${roomId} with ${Object.keys(room.players).length} players`);
}

// ---- Helpers (global lobby → assign to a waiting room) ----
function generateRoomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[(Math.random() * chars.length) | 0];
  return code;
}

// --- Sushi Sprint Racer Naming ---
const SUSHIS = ['Tamago', 'Salmon', 'Maki', 'Maguro'];
const ADJS   = ['Speedy', 'Spicy', 'Rolling', 'Flying', 'Rocket', 'Neon', 'Mega', 'Hyper'];

function generatePlayerName(slotNum) {
  const a = ADJS[Math.floor(Math.random() * ADJS.length)];
  const b = SUSHIS[(slotNum - 1) % SUSHIS.length];
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

    // Tell only this socket which room it's in (kept internal)
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

    // Set timer to fill with bots after 8 seconds if not enough players
    if (botFillTimers[rid]) {
      clearTimeout(botFillTimers[rid]);
    }
    botFillTimers[rid] = setTimeout(() => {
      if (room && !room.gameStarted && Object.keys(room.players).length < MAX_PLAYERS) {
        console.log(`Filling room ${rid} with bots after timeout`);
        fillWithBots(rid);
      }
      delete botFillTimers[rid];
    }, 8000);
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

    // Slot guard: if another socket already owns this playerNum, reject
    const existing = room.players[playerNum];
    if (existing && existing.socketId !== socket.id && !existing.isBot) {
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
      startGame(rid);
    }
  });

  // Host starts the race (needs at least 2 players)
  socket.on('startGame', (rid) => {
    const room = rooms[rid];
    if (!room || room.gameStarted) return;

    const playerCount = Object.keys(room.players).length;
    if (playerCount < 2) {
      socket.emit('errorMessage', { text: 'Need at least 2 players to start.' });
      return;
    }

    startGame(rid);
  });

  // Tap action (boost based on tap cadence) + ANIMATION SYNC
// Tap action (boost based on tap cadence) + ANIMATION SYNC
socket.on('playerAction', ({ roomId: rid, playerId }) => {
  const room = rooms[rid];
  if (!room || !room.players[playerId]) return;

  const now  = Date.now();
  const last = room.tapStreaks[playerId] || 0;
  const diff = now - last;

  let boost = 8 * SPEED_MULTIPLIER;
  if (diff < 200) boost = 12 * SPEED_MULTIPLIER;   // quick taps
  if (diff < 120) boost = 16 * SPEED_MULTIPLIER;   // frantic taps

  room.positions[playerId] = (room.positions[playerId] || 20) + boost;
  room.speeds[playerId] = boost;
  room.tapStreaks[playerId] = now;

  io.to(rid).emit('updateState', {
    positions: room.positions,
    speeds: room.speeds
  });

  io.to(rid).emit('startAnimation', { playerId });
  clearTimeout(room.stopTimers[playerId]);
  room.stopTimers[playerId] = setTimeout(() => {
    io.to(rid).emit('stopAnimation', { playerId });
  }, 300);
});

  // Client reports a finish time
  // Client reports a finish time
socket.on('checkFinish', ({ roomId: rid, playerId, finishTime }) => {
  const room = rooms[rid];
  if (!room) return;

  room.finishTimes[playerId] = finishTime;

  io.to(rid).emit('endRace', {
    players: room.players,
    positions: room.positions,
    speeds: room.speeds,
    finishTimes: room.finishTimes
  });
});


  // Force end (e.g., all finished)
// Force end (e.g., all finished)
socket.on('endRace', (rid) => {
  const room = rooms[rid];
  if (!room) return;

  io.to(rid).emit('endRace', {
    players: room.players,
    positions: room.positions,
    speeds: room.speeds,
    finishTimes: room.finishTimes
  });
});



  // Reset a room back to lobby (PROPER IMPLEMENTATION)
 // Reset a room back to lobby (PROPER IMPLEMENTATION)
// Reset a room back to lobby
socket.on('resetRoom', (rid) => {
  const room = rooms[rid];
  if (!room) return;
  
  // Stop all bots
  stopBotAI(rid);

  // Clear bot fill timer if exists
  if (botFillTimers[rid]) {
    clearTimeout(botFillTimers[rid]);
    delete botFillTimers[rid];
  }

  // Reset room state
  rooms[rid] = {
    players: {},
    positions: {},
    speeds: {},
    gameStarted: false,
    finishTimes: {},
    isResetting: false,
    hostSocketId: null,
    tapStreaks: {},
    stopTimers: {},
    autoResetTimer: null
  };

  // Tell clients to reset UI and state
  io.to(rid).emit('resetRoom', {
    roomId: rid,
    players: {},
    positions: {},
    speeds: {},
    finishTimes: {}
  });

  console.log(`Room ${rid} has been reset and clients notified`);
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
        const next = Object.values(room.players).find(p => !p.isBot);
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
  console.log(`Sushi Sprint server running on http://localhost:${PORT}`);

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
