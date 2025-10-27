// --- Sushi Sprint server (Express + Socket.IO) - FIXED VERSION ---
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
  saveLeaderboard();
  console.log(`🏆 Win recorded for ${cc}. Total: ${countryLeaderboard[cc]}`);
}

function generatePlayerName(slotId) {
  const adjectives = ['Speedy','Swift','Turbo','Rapid','Lightning','Flash','Blazing','Rocket'];
  const nouns = ['Sushi','Tuna','Salmon','Nigiri','Maki','Wasabi','Tempura','Ramen'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adj + ' ' + noun;
}

function startGame(rid) {
  const room = rooms[rid];
  if (!room || room.gameStarted) return;

  const playerCount = Object.keys(room.players).length;
  if (playerCount < MIN_TO_START) {
    console.log(`Cannot start room ${rid}, only ${playerCount} players`);
    return;
  }

  room.gameStarted = true;
  console.log(`🏁 Starting game in room ${rid} with ${playerCount} players`);

  io.to(rid).emit('gameStarted', {
    players: room.players,
    positions: room.positions,
    speeds: room.speeds,
    finishTimes: room.finishTimes
  });

  // Start bot AI for each bot player AFTER countdown (3-2-1-GO = ~3.5 seconds)
  for (const [playerId, player] of Object.entries(room.players)) {
    if (player.isBot) {
      // Wait for countdown to finish (3 seconds) + small random delay
      const countdownDelay = 3500; // 3.5 seconds for countdown
      const randomDelay = Math.random() * 500; // 0-500ms variance
      const totalDelay = countdownDelay + randomDelay;
      startBotAI(rid, playerId, totalDelay);
      console.log(`🤖 Bot ${player.name} will start in ${totalDelay}ms (after countdown)`);
    }
  }
}

// ---- Socket.io ----
io.on('connection', (socket) => {
  console.log('New runner connected:', socket.id);

  // FIXED: Handle Quick Race - automatically find or create a room with space
  socket.on('quickRace', () => {
    console.log('Quick race requested by:', socket.id);

    // Find a room with space or create new one
    let assignedRoom = null;
    
    // Look for existing room with space
    for (const [rid, room] of Object.entries(rooms)) {
      if (!room.gameStarted && Object.keys(room.players).length < MAX_PLAYERS) {
        assignedRoom = rid;
        console.log(`Assigning player to existing room: ${rid}`);
        break;
      }
    }

    // Create new room if none available
    if (!assignedRoom) {
      assignedRoom = 'ROOM_' + Date.now();
      rooms[assignedRoom] = {
        players: {},
        positions: {},
        speeds: {},
        gameStarted: false,
        finishTimes: {},
        isResetting: false,
        hostSocketId: null,
        tapStreaks: {},
        stopTimers: {},
        autoResetTimer: null,
        winnerRecorded: false
      };
      console.log(`Created new room: ${assignedRoom}`);
    }

    socket.emit('roomAssigned', { roomId: assignedRoom });
  });

  // FIXED: Join room with automatic slot assignment - NO MORE "slot taken" errors!
  socket.on('joinRoom', ({ roomId: rid, countryCode }) => {
    const room = rooms[rid];
    if (!room) {
      console.log(`Room ${rid} does not exist`);
      socket.emit('roomNotFound');
      return;
    }

    // Check if this socket is already in the room
    for (const [pid, player] of Object.entries(room.players)) {
      if (player.socketId === socket.id) {
        console.log(`Socket ${socket.id} already in room ${rid} as player ${pid}`);
        // Re-send player joined so client syncs
        socket.emit('playerJoined', {
          players: room.players,
          positions: room.positions,
          speeds: room.speeds,
          hostSocketId: room.hostSocketId,
          maxPlayers: MAX_PLAYERS,
          minToStart: MIN_TO_START
        });
        return;
      }
    }

    // AUTOMATICALLY find first available slot - no more manual selection!
    let availableSlot = null;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!room.players[i]) {
        availableSlot = i;
        break;
      }
    }

    // If room is full, notify user
    if (!availableSlot) {
      console.log(`Room ${rid} is full`);
      socket.emit('roomFull');
      return;
    }

    const ALLOWED3 = new Set(['ENG','SCO','WAL','NIR','JE','GG','UN']);
   const raw = (countryCode || '').toString().toUpperCase();
    const cc = (/^[A-Z]{2}$/.test(raw) || ALLOWED3.has(raw)) ? raw : 'UN';

    const safeName = generatePlayerName(availableSlot);
    room.players[availableSlot] = { 
      name: safeName, 
      id: availableSlot, 
      socketId: socket.id, 
      country: cc 
    };
    room.positions[availableSlot] = 20;
    room.speeds[availableSlot] = 0;

    if (!room.hostSocketId) room.hostSocketId = socket.id;

    socket.join(rid);
    socket.roomId = rid;

    console.log(`✅ Player ${socket.id} joined room ${rid} in slot ${availableSlot} (${cc})`);

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

socket.on('resetRoom', (rid) => {
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
    autoResetTimer: null,
    winnerRecorded: false
  };

  // Keep sockets in the same Socket.IO room; just reset game state
  io.to(roomId).emit('resetRoom', {
    roomId,
    players: {},
    positions: {},
    speeds: {},
    finishTimes: {}
  });

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