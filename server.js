// --- Sushi Sprint server (Express + Socket.IO) ---
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const SPEED_MULTIPLIER = 3;

// ---- Config ----
const MAX_PLAYERS  = 4;
const MIN_TO_START = 2;

// ---- Leaderboard Storage (persistent on disk) ----
const DATA_DIR = path.join(__dirname, 'data');
const LB_FILE  = path.join(DATA_DIR, 'leaderboard.json');
let countryLeaderboard = {};
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
 if (fs.existsSync(LB_FILE)) {
    countryLeaderboard = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {};
 } else {
    countryLeaderboard = {};
  }
} catch (e) {
  console.warn('Failed to load leaderboard, starting fresh:', e);
  countryLeaderboard = {};
}

// Debounced saver
let _saveTimer = null;
function saveLeaderboard() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(LB_FILE, JSON.stringify(countryLeaderboard, null, 2));
      console.log('💾 Leaderboard saved');
    } catch (e) {
      console.warn('Failed to save leaderboard:', e);
    }
  }, 500);
}

// ---- Static ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// API endpoint for leaderboard data
app.get('/api/leaderboard', (req, res) => {
  const sorted = Object.entries(countryLeaderboard)
    .map(([country, wins]) => ({ country, wins }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 50); // Top 50 countries
  res.json(sorted);
});

app.get('/api/records', (req, res) => {
  res.json(records);
});


// ---- In-memory rooms ----
const rooms = {};

// ---- Bot System ----
const botIntervals = {};
const botFillTimers = {};
const countdownIntervals = {}; // Track countdown timers per room

// Track player lanes
const playerLanes = {};

// Create a bot player
function createBot(roomId, slotNum) {
  const room = rooms[roomId];
  if (!room || room.players[slotNum]) return null;

  const botName = generatePlayerName(slotNum);
  const botId = 'bot_' + slotNum + '_' + Date.now();
  
  // Random country for bots - globally diverse selection
  const BOT_COUNTRIES = [
    'US','CA','MX','BR','AR',  // Americas
    'GB','FR','DE','ES','IT','NL','SE','NO','PL','PT','IE','CH',  // Europe
    'JP','CN','IN','KR','AU','NZ','SG','MY','TH','VN','ID','PH',  // Asia-Pacific
    'ZA','NG','EG','KE','GH','MA',  // Africa
    'AE','SA','TR','IL',  // Middle East
    'ENG','SCO','WAL','NIR'  // UK subdivisions for variety
  ];
  const randomCountry = BOT_COUNTRIES[Math.floor(Math.random() * BOT_COUNTRIES.length)];

  room.players[slotNum] = {
    name: botName,
    id: slotNum,
    socketId: botId,
    isBot: true,
    country: randomCountry
  };
  room.positions[slotNum] = 20;
  room.speeds[slotNum] = 0;

  console.log(`Bot ${botName} (${randomCountry}) added to room ${roomId} in slot ${slotNum}`);
  return room.players[slotNum];
}

// ---- Records Storage (fastest time) ----
const REC_FILE = path.join(DATA_DIR, 'records.json');
let records = { fastest: null }; // { time, country, name, dateISO }

try {
  if (fs.existsSync(REC_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(REC_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') records = parsed;
  }
} catch (e) {
  console.warn('Failed to load records, starting fresh:', e);
  records = { fastest: null };
}

function saveRecords() {
  try {
    fs.writeFileSync(REC_FILE, JSON.stringify(records, null, 2));
    console.log('💾 Records saved');
  } catch (e) {
    console.warn('Failed to save records:', e);
  }
}


// Start countdown and fill with bots after
function startRoomCountdown(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted || countdownIntervals[roomId]) return;

  let timeLeft = 8;
  
  // Emit initial countdown
  io.to(roomId).emit('lobbyCountdown', { timeLeft });

  countdownIntervals[roomId] = setInterval(() => {
    timeLeft--;
    
    if (timeLeft <= 0) {
      clearInterval(countdownIntervals[roomId]);
      delete countdownIntervals[roomId];
      
      // Fill with bots if room isn't full
      if (room && !room.gameStarted && Object.keys(room.players).length < MAX_PLAYERS) {
        fillWithBots(roomId);
      }
      return;
    }

    io.to(roomId).emit('lobbyCountdown', { timeLeft });
  }, 1000);
}

// Stop countdown if room fills or game starts
function stopRoomCountdown(roomId) {
  if (countdownIntervals[roomId]) {
    clearInterval(countdownIntervals[roomId]);
    delete countdownIntervals[roomId];
    io.to(roomId).emit('lobbyCountdown', { timeLeft: -1 }); // Signal to hide countdown
  }
}

// Fill empty slots with bots
function fillWithBots(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  const realPlayerCount = Object.keys(room.players).filter(
    pid => !room.players[pid].isBot
  ).length;

  if (realPlayerCount < 1) return;

  let botsAdded = false;
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    if (!room.players[i]) {
      createBot(roomId, i);
      botsAdded = true;
    }
  }

  if (botsAdded) {
    io.to(roomId).emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });

    setTimeout(() => {
      if (room && !room.gameStarted && Object.keys(room.players).length >= MIN_TO_START) {
        startGame(roomId);
      }
    }, 2000);
  }
}

// Start bot AI after race begins
function startBotAI(roomId, playerId, delay = 0) {
  const room = rooms[roomId];
  if (!room || !room.players[playerId] || !room.players[playerId].isBot) return;

  const intervalKey = roomId + '_' + playerId;
  if (botIntervals[intervalKey]) {
    clearInterval(botIntervals[intervalKey]);
  }

  const botSpeed = 150 + Math.random() * 250;
  const variance = 50;

  setTimeout(() => {
    botIntervals[intervalKey] = setInterval(() => {
      if (!room.gameStarted || room.finishTimes[playerId]) {
        clearInterval(botIntervals[intervalKey]);
        delete botIntervals[intervalKey];
        return;
      }

      const tapDelay = Math.random() * variance - variance/2;
      
      setTimeout(() => {
        if (room.gameStarted && !room.finishTimes[playerId]) {
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
  }, delay);
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

// Record winner's country to leaderboard
function recordWin(countryCode) {
  if (!countryCode) return;
  const ALLOWED3 = new Set(['ENG','SCO','WAL','NIR','JE','GG','UN']);
  const cc = countryCode.toUpperCase();
  // Allow 2-letter ISO or our 3-letter/territory codes; do not count UN
  const valid = ((/^[A-Z]{2}$/.test(cc) || ALLOWED3.has(cc)) && cc !== 'UN');
  if (!valid) return;
  countryLeaderboard[cc] = (countryLeaderboard[cc] || 0) + 1;
  console.log(`📊 Leaderboard updated: ${cc} now has ${countryLeaderboard[cc]} wins`);
  saveLeaderboard();
}

// Automatically reset a room a few seconds after race ends
function scheduleAutoReset(rid, delayMs = 10000) {
  const room = rooms[rid];
  if (!room) return;

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

  // Stop countdown when game starts
  stopRoomCountdown(roomId);

  room.gameStarted = true;
  room.finishTimes = {};
  const startPos = 20;
  
  Object.keys(room.players).forEach(pid => {
    room.positions[pid] = startPos;
    room.speeds[pid] = 0;
    
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

// ---- Helpers ----
function generateRoomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[(Math.random() * chars.length) | 0];
  return code;
}

const SUSHIS = ['Tamago', 'Salmon', 'Maki', 'Maguro'];
const ADJS   = ['Speedy', 'Spicy', 'Rolling', 'Flying', 'Rocket', 'Neon', 'Mega', 'Hyper'];

function generatePlayerName(slotNum) {
  const a = ADJS[Math.floor(Math.random() * ADJS.length)];
  const b = SUSHIS[(slotNum - 1) % SUSHIS.length];
  const n = (Math.random() * 90 + 10) | 0;
  return `${a} ${b} ${n}`;
}

function getOrCreateWaitingRoom() {
  for (const [rid, room] of Object.entries(rooms)) {
    const count = Object.keys(room.players).length;
    if (!room.gameStarted && !room.isResetting && count < MAX_PLAYERS) {
      return rid;
    }
  }
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

  socket.on('quickRace', () => {
    const rid = getOrCreateWaitingRoom();

    socket.join(rid);
    socket.roomId = rid;

    socket.emit('roomAssigned', { roomId: rid, maxPlayers: MAX_PLAYERS, minToStart: MIN_TO_START });

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

  socket.on('joinRoom', (data = {}) => {
    const { roomId, playerNum, countryCode } = data;
    const rid = ((socket.roomId || roomId || 'ABC123') + '').toUpperCase();

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

    if (Object.keys(room.players).length >= MAX_PLAYERS) {
      socket.emit('roomFull', { max: MAX_PLAYERS });
      return;
    }

    const existing = room.players[playerNum];
    if (existing && existing.socketId !== socket.id && !existing.isBot) {
      socket.emit('slotTaken', { playerNum });
      return;
    }

    const ALLOWED3 = new Set(['ENG','SCO','WAL','NIR','JE','GG','UN']);
   const raw = (countryCode || '').toString().toUpperCase();
    const cc = (/^[A-Z]{2}$/.test(raw) || ALLOWED3.has(raw)) ? raw : 'UN';

    const safeName = generatePlayerName(playerNum);
    room.players[playerNum] = { name: safeName, id: playerNum, socketId: socket.id, country: cc };
    room.positions[playerNum] = 20;
    room.speeds[playerNum] = 0;

    if (!room.hostSocketId) room.hostSocketId = socket.id;

    socket.join(rid);
    socket.roomId = rid;

    io.to(rid).emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });

    // Start countdown when first player joins
    const playerCount = Object.keys(room.players).length;
    if (playerCount === 1 && !room.gameStarted) {
      startRoomCountdown(rid);
    }

    // Stop countdown and auto-start if room is full
    if (playerCount === MAX_PLAYERS && !room.gameStarted) {
      stopRoomCountdown(rid);
      startGame(rid);
    }
  });

  socket.on('playerAction', ({ roomId: rid, playerId }) => {
    const room = rooms[rid];
    if (!room || !room.players[playerId]) return;

    const now  = Date.now();
    const last = room.tapStreaks[playerId] || 0;
    const diff = now - last;

    let boost = 8 * SPEED_MULTIPLIER;
    if (diff < 200) boost = 12 * SPEED_MULTIPLIER;
    if (diff < 120) boost = 16 * SPEED_MULTIPLIER;

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

socket.on('checkFinish', ({ roomId: rid, playerId, finishTime }) => {
  const room = rooms[rid];
  if (!room || room.isResetting) return;

  room.finishTimes[playerId] = finishTime;

  const total = Object.keys(room.players).length;
  const done  = Object.keys(room.finishTimes).length;

  if (done >= total && !room.winnerRecorded) {
    const finishArray = Object.entries(room.finishTimes)
      .map(([pid, time]) => ({ playerId: pid, time }))
      .sort((a, b) => a.time - b.time);

if (finishArray.length) {
  const winnerId = finishArray[0].playerId;
  const bestTime  = finishArray[0].time;
  const winner    = room.players[winnerId];

  // Existing: record win by country
  if (winner && winner.country) {
    recordWin(winner.country);
    room.winnerRecorded = true;
  }

  // NEW: update fastest run
  if (!records.fastest || (bestTime > 0 && bestTime < records.fastest.time)) {
    records.fastest = {
      time: bestTime,
      country: winner && winner.country ? winner.country : null,
      name: winner && winner.name ? winner.name : null,
      dateISO: new Date().toISOString()
    };
    saveRecords();
    console.log(`🚀 New fastest run: ${bestTime.toFixed(3)}s by ${records.fastest.country || '??'}`);
  }
}


    io.to(rid).emit('endRace', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      finishTimes: room.finishTimes
    });
  }
});


  socket.on('endRace', (rid) => {
    const room = rooms[rid];
    if (!room) return;

    // Find the winner (player with lowest finish time)
    const finishArray = Object.entries(room.finishTimes)
      .map(([pid, time]) => ({ playerId: pid, time }))
      .sort((a, b) => a.time - b.time);

if (finishArray.length) {
  const winnerId = finishArray[0].playerId;
  const bestTime  = finishArray[0].time;
  const winner    = room.players[winnerId];

  // Existing: record win by country
  if (winner && winner.country) {
    recordWin(winner.country);
    room.winnerRecorded = true;
  }

  // NEW: update fastest run
  if (!records.fastest || (bestTime > 0 && bestTime < records.fastest.time)) {
    records.fastest = {
      time: bestTime,
      country: winner && winner.country ? winner.country : null,
      name: winner && winner.name ? winner.name : null,
      dateISO: new Date().toISOString()
    };
    saveRecords();
    console.log(`🚀 New fastest run: ${bestTime.toFixed(3)}s by ${records.fastest.country || '??'}`);
  }
}


    io.to(rid).emit('endRace', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      finishTimes: room.finishTimes
    });
  });

  socket.on('changeLane', ({ roomId: rid, playerId, lane }) => {
    const room = rooms[rid];
    if (!room || !room.players[playerId]) return;
    
    playerLanes[rid + '_' + playerId] = lane;
    socket.to(rid).emit('playerChangedLane', { playerId, lane });
  });

// Replace your current handler:
socket.on('resetRoom', (rid) => {
  // NEW: fallback to socket.roomId
  const roomId = (rid || socket.roomId || '').toUpperCase();
  const room = rooms[roomId];
  if (!room) return;

  stopBotAI(roomId);
  stopRoomCountdown(roomId);

  if (botFillTimers[roomId]) {
    clearTimeout(botFillTimers[roomId]);
    delete botFillTimers[roomId];
  }

  rooms[roomId] = {
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

  // Keep sockets in the same Socket.IO room; just reset game state
  io.to(roomId).emit('resetRoom', {
    roomId,
    players: {},
    positions: {},
    speeds: {},
    finishTimes: {}
  });

  // NEW: lightweight ACK so clients can clear UI locks
  io.to(roomId).emit('roomReset', { roomId });

  console.log(`Room ${roomId} has been reset and clients notified`);
});


  socket.on('startGame', (rid) => {
    const room = rooms[rid];
    if (!room || room.gameStarted) return;
    
    // Only host can start
    if (room.hostSocketId !== socket.id) return;
    
    const playerCount = Object.keys(room.players).length;
    if (playerCount < MIN_TO_START) return;
    
    stopRoomCountdown(rid);
    startGame(rid);
  });

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

      // If last player left, clean up countdown
      if (Object.keys(room.players).length === 0) {
        stopRoomCountdown(rid);
      }
    }
  });
});

// ---- Start server ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sushi Sprint server running on http://localhost:${PORT}`);

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`On your LAN:  http://${net.address}:${PORT}`);
      }
    }
  }
});