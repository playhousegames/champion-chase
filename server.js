// --- Sushi Sprint server (Express + Socket.IO) - FIXED VERSION ---
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const path     = require('path');
const os       = require('os');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { 
  cors: { origin: "*", methods: ["GET", "POST"] },
  // Faster disconnect detection for refreshes
  pingTimeout: 5000,  // Reduced from default 20000
  pingInterval: 2000  // Reduced from default 25000
});
const SPEED_MULTIPLIER = 3;

// ---- Config ----
const MAX_PLAYERS  = 4;
const MIN_TO_START = 2;

// ---- Anti-Cheat Config ----
const MIN_POSSIBLE_TIME = 8;    // 8 seconds minimum (physically impossible to go faster)
const MAX_POSSIBLE_TIME = 300;  // 5 minutes maximum (prevent stale submissions)
const MIN_FINISH_POSITION = 7500; // Must be near finish line (tracks are 8000-12000px)

// ---- ONLINE PLAYERS TRACKING ----
let onlinePlayers = new Set(); // Track all connected sockets
let playersInRooms = new Set(); // Track players in lobbies
let playersInGame = new Set(); // Track players currently racing

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



// ADMIN: Verify disk setup (helpful for debugging Render configuration)
app.get('/admin/verify-disk', (req, res) => {
  const checks = {
    dataDir: {
      path: DATA_DIR,
      exists: fs.existsSync(DATA_DIR),
      writable: false
    },
    leaderboard: {
      path: LB_FILE,
      exists: fs.existsSync(LB_FILE),
      size: fs.existsSync(LB_FILE) ? fs.statSync(LB_FILE).size : 0,
      entries: Object.keys(countryLeaderboard).length
    },
    records: {
      path: REC_FILE,
      exists: fs.existsSync(REC_FILE),
      size: fs.existsSync(REC_FILE) ? fs.statSync(REC_FILE).size : 0,
      hasRecord: !!records.fastest
    }
  };
  
  // Test write permissions
  try {
    const testFile = path.join(DATA_DIR, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    checks.dataDir.writable = true;
  } catch (e) {
    checks.dataDir.writeError = e.message;
  }
  
  res.json(checks);
});

// NEW: API endpoint for online stats
app.get('/api/stats', (req, res) => {
  res.json({
    online: onlinePlayers.size,
    inLobby: playersInRooms.size,
    inGame: playersInGame.size,
    totalRooms: Object.keys(rooms).length,
    activeGames: Object.values(rooms).filter(r => r.gameStarted).length
  });
});

// ---- In-memory rooms ----
const rooms = {};

// ---- Bot System ----
const botIntervals = {};
const botFillTimers = {};
const countdownIntervals = {}; // Track countdown timers per room
const raceStartTimers = {}; // Track race start timers

// Track player lanes
const playerLanes = {};

// Broadcast online count to all clients
function broadcastOnlineCount() {
  io.emit('onlineCount', {
    total: onlinePlayers.size,
    inLobby: playersInRooms.size,
    inGame: playersInGame.size
  });
}

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
  console.log(`[COUNTDOWN] startRoomCountdown called for room ${roomId}`);
  const room = rooms[roomId];
  if (!room) {
    console.log(`[COUNTDOWN] ERROR: Room ${roomId} not found!`);
    return;
  }
  if (room.gameStarted) {
    console.log(`[COUNTDOWN] Game already started, skipping`);
    return;
  }
  if (countdownIntervals[roomId]) {
    console.log(`[COUNTDOWN] Countdown already running for room ${roomId}`);
    return;
  }

  let timeLeft = 8;
  
  console.log(`[COUNTDOWN] Starting 8-second countdown for room ${roomId}`);
  // Emit initial countdown
  io.to(roomId).emit('lobbyCountdown', { timeLeft });

  countdownIntervals[roomId] = setInterval(() => {
    timeLeft--;
    console.log(`[COUNTDOWN] Room ${roomId} countdown: ${timeLeft}`);
    
    if (timeLeft <= 0) {
      clearInterval(countdownIntervals[roomId]);
      delete countdownIntervals[roomId];
      console.log(`[COUNTDOWN] Countdown complete for room ${roomId}, calling fillWithBots`);
      
      // Fill with bots if room isn't full
      if (room && !room.gameStarted && Object.keys(room.players).length < MAX_PLAYERS) {
        fillWithBots(roomId);
      } else {
        console.log(`[COUNTDOWN] Not filling with bots - room full or game started`);
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
  console.log(`[BOTS] fillWithBots called for room ${roomId}`);
  const room = rooms[roomId];
  if (!room) {
    console.log(`[BOTS] ERROR: Room ${roomId} not found!`);
    return;
  }
  if (room.gameStarted) {
    console.log(`[BOTS] Game already started, skipping`);
    return;
  }

  const realPlayerCount = Object.keys(room.players).filter(
    pid => !room.players[pid].isBot
  ).length;
  
  console.log(`[BOTS] Real player count: ${realPlayerCount}`);
  console.log(`[BOTS] Current players:`, Object.keys(room.players));

  if (realPlayerCount < 1) {
    console.log(`[BOTS] No real players, aborting`);
    return;
  }

  let botsAdded = false;
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    if (!room.players[i]) {
      console.log(`[BOTS] Creating bot for slot ${i}`);
      createBot(roomId, i);
      botsAdded = true;
    }
  }

  console.log(`[BOTS] Bots added: ${botsAdded}`);
  console.log(`[BOTS] Total players now: ${Object.keys(room.players).length}`);

  if (botsAdded) {
    io.to(roomId).emit('playerJoined', {
      players: room.players,
      positions: room.positions,
      speeds: room.speeds,
      hostSocketId: room.hostSocketId,
      maxPlayers: MAX_PLAYERS,
      minToStart: MIN_TO_START
    });

    console.log(`[BOTS] Waiting 5 seconds before starting game...`);
    // FIXED: Wait for client countdown (3-2-1-GO) before starting game
    // The client needs time to show 3-2-1-GO countdown after bots join
    setTimeout(() => {
      console.log(`[BOTS] Timeout fired - checking conditions...`);
      console.log(`[BOTS] Room exists: ${!!room}`);
      console.log(`[BOTS] Game started: ${room ? room.gameStarted : 'N/A'}`);
      console.log(`[BOTS] Total players: ${room ? Object.keys(room.players).length : 'N/A'}`);
      
      if (room && !room.gameStarted && Object.keys(room.players).length >= MIN_TO_START) {
        console.log(`[BOTS] ✅ Starting game now!`);
        startGame(roomId);
      } else {
        console.log(`[BOTS] ❌ Game not started - conditions not met`);
      }
    }, 5000); // 5 seconds to match countdown timing
  }
}

// Start the game
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  room.gameStarted = true;
  room.finishTimes = {};
  room.winnerRecorded = false;

  // Move all real players from lobby to game
  for (const player of Object.values(room.players)) {
    if (!player.isBot) {
      playersInRooms.delete(player.socketId);
      playersInGame.add(player.socketId);
    }
  }
  broadcastOnlineCount();

  io.to(roomId).emit('gameStart', {
    players: room.players,
    positions: room.positions,
    speeds: room.speeds
  });

  console.log(`Game started in room ${roomId}`);

  // Start bot AI after countdown (3-2-1-GO = ~4 seconds)
  setTimeout(() => {
    startBotAI(roomId);
    console.log(`Bot AI started in room ${roomId} after countdown`);
  }, 4000);
}

// Bot AI system
function startBotAI(roomId) {
  const room = rooms[roomId];
  if (!room || botIntervals[roomId]) return;

  botIntervals[roomId] = setInterval(() => {
    if (!room.gameStarted) {
      stopBotAI(roomId);
      return;
    }

    Object.entries(room.players).forEach(([pid, player]) => {
      if (!player.isBot) return;

      // Smart bot behavior based on position
      const pos = room.positions[pid] || 20;
      const avgPos = Object.values(room.positions).reduce((a, b) => a + b, 0) / Object.keys(room.positions).length;
      
      // Bots get more aggressive when behind
      let tapChance = 0.25; // Base 25% chance
      if (pos < avgPos - 100) tapChance = 0.4; // 40% when behind
      if (pos < avgPos - 200) tapChance = 0.5; // 50% when far behind
      
      // Add some personality - some bots are faster
      const personalityBoost = (parseInt(pid) % 2 === 0) ? 0.1 : 0;
      tapChance += personalityBoost;

      if (Math.random() < tapChance) {
        // Simulate tap with varying strength
        const boost = (8 + Math.random() * 8) * SPEED_MULTIPLIER;
        room.positions[pid] = (room.positions[pid] || 20) + boost;
        room.speeds[pid] = boost;

        io.to(roomId).emit('updateState', {
          positions: room.positions,
          speeds: room.speeds
        });

        io.to(roomId).emit('startAnimation', { playerId: pid });
        
        setTimeout(() => {
          io.to(roomId).emit('stopAnimation', { playerId: pid });
        }, 300);
      }
    });
  }, 100); // Update every 100ms for smooth bot movement
}

// Stop bot AI
function stopBotAI(roomId) {
  if (botIntervals[roomId]) {
    clearInterval(botIntervals[roomId]);
    delete botIntervals[roomId];
  }
}

// Record a win for a country
function recordWin(countryCode) {
  if (!countryCode) return;
  
  const cc = countryCode.toUpperCase();
  if (!countryLeaderboard[cc]) {
    countryLeaderboard[cc] = 0;
  }
  countryLeaderboard[cc]++;
  
  saveLeaderboard();
  console.log(`🏆 Win recorded for ${cc} (Total: ${countryLeaderboard[cc]})`);
}

// Generate name for players
const prefixes = ['Blazing', 'Lightning', 'Thunder', 'Turbo', 'Speed', 'Rocket', 
                 'Sonic', 'Flash', 'Rapid', 'Swift', 'Quick', 'Nitro', 'Hyper'];
const suffixes = ['Tuna', 'Tamago', 'Salmon', 'Saba', 'Ika', 'Tako', 
                 'Tempura', 'Wasabi', 'Maki', 'Roll', 'Nori', 'Rice', 'Sushi'];

function generatePlayerName(slotNum) {
  // If generating for a bot, return a bot-themed name
  if (slotNum && typeof slotNum === 'number') {
    const botPrefixes = ['Auto', 'Robo', 'Cyber', 'Mecha', 'Digital', 'AI'];
    const botSuffixes = ['Runner', 'Sprinter', 'Racer', 'Dash', 'Speed'];
    const prefix = botPrefixes[Math.floor(Math.random() * botPrefixes.length)];
    const suffix = botSuffixes[Math.floor(Math.random() * botSuffixes.length)];
    return `${prefix} ${suffix} ${slotNum}`;
  }
  
  // Regular player name
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${prefix} ${suffix} ${num}`;
}

// Reset a room
function resetRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Move players back from inGame to playersInRooms
  for (const player of Object.values(room.players)) {
    if (!player.isBot) {
      playersInGame.delete(player.socketId);
    }
  }
  broadcastOnlineCount();

  stopBotAI(roomId);
  stopRoomCountdown(roomId);

  if (room.autoResetTimer) {
    clearTimeout(room.autoResetTimer);
    room.autoResetTimer = null;
  }

  delete rooms[roomId];
  console.log(`Room ${roomId} has been reset`);
}

// FIX: Helper function to check if a socket is already in a room as a player
function isSocketInRoom(socketId, roomId) {
  const room = rooms[roomId];
  if (!room) return false;
  
  for (const player of Object.values(room.players)) {
    if (player.socketId === socketId && !player.isBot) {
      return true;
    }
  }
  return false;
}

// SOCKET CONNECTION
io.on('connection', (socket) => {
  console.log('Runner connected:', socket.id);
  
  // Add to online players
  onlinePlayers.add(socket.id);
  broadcastOnlineCount();

  socket.on('quickRace', (data) => {
    // Extract countryCode safely, default to 'UN' if not provided
    const countryCode = data && data.countryCode ? data.countryCode : 'UN';
    
    // Find or create an available room
    let rid = null;
    
    // First, check if socket is already in a room
    for (const [roomId, room] of Object.entries(rooms)) {
      if (isSocketInRoom(socket.id, roomId)) {
        console.log(`Socket ${socket.id} is already in room ${roomId}`);
        rid = roomId;
        
        socket.emit('roomAssigned', { roomId: rid });
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
    
    // Find an available room (not full, not started, has real players)
    for (const [roomId, room] of Object.entries(rooms)) {
      // Clean up disconnected players first
      for (const [pid, player] of Object.entries(room.players)) {
        if (!player.isBot) {
          const playerSocket = io.sockets.sockets.get(player.socketId);
          if (!playerSocket || !playerSocket.connected) {
            console.log(`[CLEANUP] Removing stale player ${pid} from room ${roomId}`);
            delete room.players[pid];
            delete room.positions[pid];
            delete room.speeds[pid];
            playersInRooms.delete(player.socketId);
          }
        }
      }
      
      // Check if room is available
      const playerCount = Object.keys(room.players).length;
      if (!room.gameStarted && playerCount < MAX_PLAYERS) {
        rid = roomId;
        console.log(`Found available room: ${rid} (${playerCount}/${MAX_PLAYERS} players)`);
        break;
      }
    }
    
    // If no available room found, create a new one
    if (!rid) {
      rid = 'ROOM-' + Date.now();
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
        autoResetTimer: null,
        winnerRecorded: false
      };
      console.log(`Created new room: ${rid}`);
    }

    const room = rooms[rid];

    let availableSlot = null;
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!room.players[i]) {
        availableSlot = i;
        break;
      }
    }
    if (!availableSlot) {
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

    // Add to playersInRooms
    playersInRooms.add(socket.id);
    broadcastOnlineCount();

    console.log(`✅ Player ${socket.id} joined room ${rid} in slot ${availableSlot} (${cc})`);

    // FIX: Send room assignment first
    socket.emit('roomAssigned', { roomId: rid });
    
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
      // Give time for UI to update before starting
      setTimeout(() => {
        startGame(rid);
      }, 1000);
    }
  });

  // FIX: Add joinRoom handler for when client already has a roomId
  socket.on('joinRoom', (data) => {
    const { roomId, countryCode } = data;
    
    if (!roomId || !rooms[roomId]) {
      socket.emit('roomNotFound');
      return;
    }
    
    const room = rooms[roomId];
    
    // Clean up any disconnected players before processing join
    for (const [pid, player] of Object.entries(room.players)) {
      if (!player.isBot) {
        const socket = io.sockets.sockets.get(player.socketId);
        if (!socket || !socket.connected) {
          console.log(`Removing disconnected player ${pid} (${player.socketId}) from room ${roomId}`);
          delete room.players[pid];
          delete room.positions[pid];
          delete room.speeds[pid];
          playersInRooms.delete(player.socketId);
        }
      }
    }
    
    // Check if socket is already in this room
    if (isSocketInRoom(socket.id, roomId)) {
      console.log(`Socket ${socket.id} is already in room ${roomId}, sending current state`);
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
    
    // Otherwise treat it like a quickRace but for the specific room
    // This shouldn't normally happen but handle it gracefully
    socket.emit('quickRace', { countryCode });
  });

  socket.on('playerAction', ({ roomId: rid, playerId }) => {
    const room = rooms[rid];
    if (!room) return;
    
    // FIXED: Convert playerId to string to match room.players keys
    const playerIdStr = String(playerId);
    if (!room.players[playerIdStr]) {
      console.log(`Player ${playerIdStr} not found in room ${rid}`);
      return;
    }

    // Don't process actions if game hasn't started
    if (!room.gameStarted) {
      console.log(`Game not started yet in room ${rid}`);
      return;
    }

    const now  = Date.now();
    const last = room.tapStreaks[playerIdStr] || 0;
    const diff = now - last;

    let boost = 8 * SPEED_MULTIPLIER;
    if (diff < 200) boost = 12 * SPEED_MULTIPLIER;
    if (diff < 120) boost = 16 * SPEED_MULTIPLIER;

    room.positions[playerIdStr] = (room.positions[playerIdStr] || 20) + boost;
    room.speeds[playerIdStr] = boost;
    room.tapStreaks[playerIdStr] = now;

    io.to(rid).emit('updateState', {
      positions: room.positions,
      speeds: room.speeds
    });

    io.to(rid).emit('startAnimation', { playerId: playerIdStr });
    clearTimeout(room.stopTimers[playerIdStr]);
    room.stopTimers[playerIdStr] = setTimeout(() => {
      io.to(rid).emit('stopAnimation', { playerId: playerIdStr });
    }, 300);
  });

  socket.on('checkFinish', ({ roomId: rid, playerId, finishTime }) => {
    const room = rooms[rid];
    if (!room || room.isResetting) return;

    const playerIdStr = String(playerId);
    const player = room.players[playerIdStr];
    
    if (!player) {
      console.log(`[ANTI-CHEAT] Invalid player ${playerIdStr} in room ${rid}`);
      return;
    }
    
    const playerPosition = room.positions[playerIdStr] || 0;
    
    // Validation checks
    if (finishTime < MIN_POSSIBLE_TIME) {
      console.log(`[ANTI-CHEAT] 🚨 Player ${player.name} (${player.country}) submitted impossible time: ${finishTime}s (min: ${MIN_POSSIBLE_TIME}s)`);
      // Disqualify cheater - set to DNF
      finishTime = 999.999;
    } else if (finishTime > MAX_POSSIBLE_TIME) {
      console.log(`[ANTI-CHEAT] Player ${player.name} submitted too-slow time: ${finishTime}s (max: ${MAX_POSSIBLE_TIME}s)`);
      finishTime = 999.999;
    } else if (playerPosition < MIN_FINISH_POSITION) {
      console.log(`[ANTI-CHEAT] 🚨 Player ${player.name} (${player.country}) finished but position too low: ${playerPosition}px (min: ${MIN_FINISH_POSITION}px)`);
      // They didn't actually reach the finish line
      finishTime = 999.999;
    } else {
      console.log(`[FINISH] ✅ Valid finish: ${player.name} - ${finishTime.toFixed(3)}s at position ${playerPosition}px`);
    }
    
    room.finishTimes[playerIdStr] = finishTime;

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

        // NEW: update fastest run (only if legitimate time)
        if (!records.fastest || (bestTime > 0 && bestTime < records.fastest.time)) {
          // Extra validation: don't record obviously cheated times
          if (bestTime >= MIN_POSSIBLE_TIME && bestTime <= MAX_POSSIBLE_TIME) {
            records.fastest = {
              time: bestTime,
              country: winner && winner.country ? winner.country : null,
              name: winner && winner.name ? winner.name : null,
              dateISO: new Date().toISOString()
            };
            saveRecords();
            console.log(`🚀 New fastest run: ${bestTime.toFixed(3)}s by ${records.fastest.name} (${records.fastest.country || '??'})`);
          } else {
            console.log(`[ANTI-CHEAT] 🚨 Blocked suspicious world record: ${bestTime.toFixed(3)}s (outside valid range)`);
          }
        }
      }

      io.to(rid).emit('endRace', {
        players: room.players,
        positions: room.positions,
        speeds: room.speeds,
        finishTimes: room.finishTimes
      });

      // Move players back to lobby after race ends
      for (const player of Object.values(room.players)) {
        if (!player.isBot) {
          playersInGame.delete(player.socketId);
        }
      }
      broadcastOnlineCount();
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

      // NEW: update fastest run (only if legitimate time)
      if (!records.fastest || (bestTime > 0 && bestTime < records.fastest.time)) {
        // Extra validation: don't record obviously cheated times
        if (bestTime >= MIN_POSSIBLE_TIME && bestTime <= MAX_POSSIBLE_TIME) {
          records.fastest = {
            time: bestTime,
            country: winner && winner.country ? winner.country : null,
            name: winner && winner.name ? winner.name : null,
            dateISO: new Date().toISOString()
          };
          saveRecords();
          console.log(`🚀 New fastest run: ${bestTime.toFixed(3)}s by ${records.fastest.name} (${records.fastest.country || '??'})`);
        } else {
          console.log(`[ANTI-CHEAT] 🚨 Blocked suspicious world record: ${bestTime.toFixed(3)}s (outside valid range)`);
        }
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
    if (!room) return;
    
    const playerIdStr = String(playerId);
    if (!room.players[playerIdStr]) return;
    
    playerLanes[rid + '_' + playerIdStr] = lane;
    socket.to(rid).emit('playerChangedLane', { playerId: playerIdStr, lane });
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

    // Update online counts
    playersInGame.delete(socket.id);
    playersInRooms.delete(socket.id);
    broadcastOnlineCount();

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

  socket.on('disconnect', (reason) => {
    console.log('Runner disconnected:', socket.id, 'Reason:', reason);
    
    // Remove from all tracking sets
    onlinePlayers.delete(socket.id);
    playersInRooms.delete(socket.id);
    playersInGame.delete(socket.id);
    broadcastOnlineCount();

    for (const [rid, room] of Object.entries(rooms)) {
      let changed = false;

      for (const [pid, player] of Object.entries(room.players)) {
        if (player.socketId === socket.id) {
          console.log(`Removing player ${pid} from room ${rid} due to disconnect`);
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
        console.log(`Host disconnected, new host:`, room.hostSocketId);
      }

      io.to(rid).emit('playerJoined', {
        players: room.players,
        positions: room.positions,
        speeds: room.speeds,
        hostSocketId: room.hostSocketId,
        maxPlayers: MAX_PLAYERS,
        minToStart: MIN_TO_START
      });

      // If last player left, clean up countdown and delete empty room
      if (Object.keys(room.players).length === 0) {
        stopRoomCountdown(rid);
        console.log(`Last player left room ${rid}, stopping countdown`);
        
        // Clean up empty room after a delay
        setTimeout(() => {
          if (rooms[rid] && Object.keys(rooms[rid].players).length === 0) {
            delete rooms[rid];
            console.log(`Deleted empty room ${rid}`);
          }
        }, 30000); // Delete after 30 seconds if still empty
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