/* =========================================================
   TURBO TAILS — GAME CLIENT (global lobby + quick race)
   Updates:
   - Sprite animation sync across players (start/stopAnimation)
   - Auto-assign safe names (server-side)
   - Auto-start when 4 join (server-side)
   - Sample-based SFX engine (wav/mp3) + crowd
   - Lobby chiptune music (in index.html)
   ========================================================= */

const socket = io();

/* ------------------------------
   1) GLOBAL STATE
------------------------------ */
var gameState = {
  players: {},                // { [id]: { id, name, socketId } }
  raceStarted: false,
  raceFinished: false,
  startTime: null,
  finishTimes: {},
  trackWidth: 1500,
  roomId: null,               // assigned by server via quickRace / roomAssigned
  positions: {},              // { [id]: x }
  speeds: {},                 // { [id]: speed }
  isResetting: false,
  countdownActive: false
};

var playerStates = {};        // local per-runner (animation interval, lastTap, etc.)
var timerInterval = null;
var gameLoopRunning = false;
var eventListenersSetup = false;

/* ------------------------------
   2) GRAPHICS / SPRITES
------------------------------ */
var gameGraphics = {
  characters: {
    1: { frames: [], loaded: false }, // Moose
    2: { frames: [], loaded: false }, // Wolf
    3: { frames: [], loaded: false }, // Horse
    4: { frames: [], loaded: false }  // Panda
  },

  loadCharacterFrames: function(characterId, frameUrls) {
    if (!this.characters[characterId]) return false;
    this.characters[characterId].frames = frameUrls.slice();
    this.characters[characterId].loaded = true;
    this.updateRunnerSprite(characterId);
    return true;
  },

  loadCharacter1Frames: function() {
    return this.loadCharacterFrames(1, [
      "images/moose_1.png","images/moose_2.png","images/moose_3.png",
      "images/moose_4.png","images/moose_5.png","images/moose_6.png"
    ]);
  },
  loadCharacter2Frames: function() {
    return this.loadCharacterFrames(2, [
      "images/wolf_1.png","images/wolf_2.png","images/wolf_3.png",
      "images/wolf_4.png","images/wolf_5.png","images/wolf_6.png"
    ]);
  },
  loadCharacter3Frames: function() {
    return this.loadCharacterFrames(3, [
      "images/horse_1.png","images/horse_2.png","images/horse_3.png",
      "images/horse_4.png","images/horse_5.png","images/horse_6.png"
    ]);
  },
  loadCharacter4Frames: function() {
    return this.loadCharacterFrames(4, [
      "images/panda_1.png","images/panda_2.png","images/panda_3.png",
      "images/panda_4.png","images/panda_5.png","images/panda_6.png"
    ]);
  },

  loadAllAnimalCharacters: function() {
    this.loadCharacter1Frames();
    this.loadCharacter2Frames();
    this.loadCharacter3Frames();
    this.loadCharacter4Frames();
  },




  // Apply first sprite frame + store frames on element for animation
  updateRunnerSprite: function(playerId) {
    var runner = document.getElementById('runner' + playerId);
    if (!runner) return;

    var character = this.characters[playerId];
    if (!character || !character.loaded || character.frames.length === 0) return;

    runner.style.width = '32px';
    runner.style.height = '32px';
    runner.style.backgroundImage = 'url(' + character.frames[0] + ')';
    runner.style.backgroundSize = 'cover';
    runner.style.backgroundRepeat = 'no-repeat';
    runner.textContent = '';
    runner.innerHTML = '';

    runner.dataset.frames = JSON.stringify(character.frames);
    runner.dataset.currentFrame = '0';
  },

  // Advance to next frame (used while "running")
  animateSprite: function(playerId) {
    var runner = document.getElementById('runner' + playerId);
    if (!runner || !runner.dataset.frames) return;

    var frames = JSON.parse(runner.dataset.frames);
    var currentFrame = parseInt(runner.dataset.currentFrame || '0', 10);
    var nextFrame = (currentFrame + 1) % frames.length;

    runner.style.backgroundImage = 'url(' + frames[nextFrame] + ')';
    runner.dataset.currentFrame = String(nextFrame);
  }
};



function launchTickerTape() {
  const container = document.querySelector('.track-container');
  if (!container) return;

  const tapes = [
    'images/ticker_red.png',
    'images/ticker_blue.png',
    'images/ticker_yellow.png',
    'images/ticker_green.png',
    'images/ticker_white.png'
  ];

  for (let i = 0; i < 30; i++) {
    const tape = document.createElement('div');
    tape.className = 'ticker-tape';
    tape.style.left = Math.random() * container.offsetWidth + 'px';
    tape.style.top = '-16px';
    tape.style.backgroundImage = `url(${tapes[Math.floor(Math.random() * tapes.length)]})`;
    container.appendChild(tape);

    const fallTime = 1800 + Math.random() * 1200;
    const drift = (Math.random() * 80 - 40);

    tape.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)' },
        { transform: `translate(${drift}px, ${container.offsetHeight + 40}px) rotate(${Math.random() * 360}deg)` }
      ],
      {
        duration: fallTime,
        easing: 'linear',
        fill: 'forwards'
      }
    ).onfinish = () => tape.remove();
  }
}


let audioCtx;
let tapBuffer = null;

async function initWebAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Load and decode tap sound
  const response = await fetch("sounds/button_press.wav");
  const arrayBuffer = await response.arrayBuffer();
  tapBuffer = await audioCtx.decodeAudioData(arrayBuffer);
}

function playTapWeb() {
  if (!tapBuffer || !audioCtx) return;
  const source = audioCtx.createBufferSource();
  source.buffer = tapBuffer;
  source.connect(audioCtx.destination);
  source.start(0);
}


/* SOUND (sample-based) */
var sounds = {
  initialized: false,
  sfx: {},
  playCountdown: function(){},
  playGo: function(){},
  playTap: function(){},
  playFinish: function(){},
  playVictory: function(){}
};

function pickFormat(baseName) {
  var audio = document.createElement('audio');
  if (audio.canPlayType('audio/ogg')) {
    return baseName + ".ogg";
  } else {
    return baseName + ".mp3";
  }
}

function initSounds() {
  if (sounds.initialized) return;

  // preload audio assets
  var files = {
    countdown: "sounds/countdown.wav",
    go:        "sounds/go.wav",
    tap:       "sounds/button_press.wav",
    finish:    "sounds/finish.wav",
    victory:   pickFormat("sounds/chiptune_victory_jingle") // NEW
  };

  Object.keys(files).forEach(function(k){
    var a = new Audio(files[k]);
    a.preload = 'auto';

    if (k === "victory") {
      a.volume = 0.7;  // make the jingle pop
    }

    sounds.sfx[k] = a;
  });

  // === SFX PLAYERS ===
  sounds.playCountdown = function(){ 
    try { sounds.sfx.countdown.currentTime = 0; sounds.sfx.countdown.play(); } catch(e){} 
  };

  sounds.playGo = function(){ 
    try { sounds.sfx.go.currentTime = 0; sounds.sfx.go.play(); } catch(e){} 
  };

sounds.playTap = function() {
  if (tapBuffer) {
    playTapWeb();   // use Web Audio (instant)
  } else if (sounds.sfx.tap) {
    // fallback: normal audio if Web Audio not ready
    try {
      const clone = sounds.sfx.tap.cloneNode();
      clone.volume = 0.8;
      clone.play().catch(()=>{});
    } catch(e) {
      console.warn("Tap sound error:", e);
    }
  }
};


  sounds.playFinish = function() {
    if (!sounds.sfx.finish) return;
    try {
      sounds.sfx.finish.currentTime = 0;
      var p = sounds.sfx.finish.play();
      if (p && p.catch) p.catch(err => console.warn('Finish sound failed:', err));
    } catch (e) { console.warn('Finish sound error:', e); }
  };

  sounds.playVictory = function() {
    if (!sounds.sfx.victory) return;
    try {
      sounds.sfx.victory.currentTime = 0;
      sounds.sfx.victory.play();
    } catch (e) { console.warn("Victory sound error:", e); }
  };

  sounds.initialized = true;
}


/* ------------------------------
   4) CAMERA / PARALLAX
------------------------------ */
var cameraState = {
  cameraOffset: 0
};

/* ------------------------------
   5) FINISH LINE STRIPE
------------------------------ */
function ensureFinishLine() {
  var track = document.getElementById('track');
  if (!track) return;

  var fl = document.getElementById('finishLine');
  if (!fl) {
    fl = document.createElement('div');
    fl.id = 'finishLine';
    var flag = document.createElement('div');
    flag.className = 'flag';
    flag.textContent = '🏁';
    fl.appendChild(flag);
    track.appendChild(fl);
  }

  var isMobile = window.innerWidth <= 480;
  var finishLineOffset = isMobile ? 50 : 80;  // keep in sync with checkFinish()
  var trackWidth = track.offsetWidth || gameState.trackWidth || 1500;
  var startPadding = 20;
  var finishX = trackWidth - finishLineOffset - startPadding;
  fl.style.left = (finishX > 0 ? finishX : 0) + 'px';
}

/* ------------------------------
   6) SCROLL LOCK (no scroll on lobby)
------------------------------ */
function lockScroll(shouldLock) {
  document.body.classList.toggle('no-scroll', !!shouldLock);
}

/* ------------------------------
   7) INITIALIZE
------------------------------ */
function initGame() {
  // user interaction primes audio on mobile
  document.addEventListener('click', function(){ initSounds(); }, { once: true });
  document.addEventListener('touchstart', function(){ initSounds(); }, { once: true });

  // load sprites
  gameGraphics.loadAllAnimalCharacters();

  if (eventListenersSetup) return;
  eventListenersSetup = true;

  document.body.addEventListener('touchstart', () => {
  initWebAudio();
}, { once: true });
document.body.addEventListener('click', () => {
  initWebAudio();
}, { once: true });


  // Set track width (longer on desktop)
  var raceLengthPx = isMobileDevice() ? 1200 : 1500;
  var track = document.getElementById('track');
  if (track) {
    track.style.width = raceLengthPx + 'px';
    gameState.trackWidth = raceLengthPx;
    ensureFinishLine();
  } else {
    gameState.trackWidth = Math.max(window.innerWidth - 60, 300);
  }

  // Track container hidden in lobby
  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active'); // hide until race
    container.style.overflow = 'hidden';
    container.style.position = 'relative';
  }

  // Buttons (declare once + guard bindings)
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn && !joinBtn._bound) {
    joinBtn.addEventListener('click', joinRoom);
    joinBtn._bound = true;
  }

  var startBtn = document.getElementById('startBtn');
  if (startBtn && !startBtn._bound) {
    startBtn.addEventListener('click', function () {
      if (gameState.raceStarted || gameState.isResetting) return;
      socket.emit('startGame', gameState.roomId);
    });
    startBtn._bound = true;
  }

  var quickBtn = document.getElementById('quickBtn');
  if (quickBtn && !quickBtn._bound) {
    quickBtn.addEventListener('click', function () {
      socket.emit('quickRace'); // server assigns us to a waiting room
    });
    quickBtn._bound = true;
  }

  // Hide loading, show lobby, lock scroll
  var loading = document.getElementById('loadingScreen');
  if (loading) {
    loading.style.opacity = '0';
    setTimeout(function(){ loading.style.display = 'none'; }, 400);
  }
  var lobby = document.getElementById('lobby');
  if (lobby) lobby.style.display = 'block';
  lockScroll(true);

  // 🔊 Resume lobby music
var bg = document.getElementById('bgMusic');
if (bg) bg.play().catch(()=>{});

  // auto-assign this socket to a waiting room so it receives roster updates
  if (!gameState.roomId) socket.emit('quickRace');

  // try to start lobby music if present and permitted
  var bg = document.getElementById('bgMusic');
  if (bg && bg.dataset.autoplay !== '1') {
    bg.play().catch(function(){ /* user gesture needed; mute button can trigger */ });
    bg.dataset.autoplay = '1';
  }
}

// === Animated Logo Loop ===
document.addEventListener('DOMContentLoaded', () => {
  const logo = document.querySelector('.logo'); // uses class, matches your index.html
  if (!logo) return;

  const frames = [
    'images/turbo_tails_logo_frame1.png',
    'images/turbo_tails_logo_frame2.png'
  ];

  let current = 0;
  setInterval(() => {
    current = (current + 1) % frames.length;
    logo.src = frames[current];
  }, 400); // ~2.5 fps wag
});


/* ------------------------------
   8) SOCKET EVENTS
------------------------------ */
socket.on('connect', function(){});
socket.on('disconnect', function(){});

// Assigned to a waiting room (global lobby)
socket.on('roomAssigned', function (data) {
  if (!data) return;
  gameState.roomId = data.roomId;
});

// Roster update
// Roster update
// Roster update
socket.on('playerJoined', function (data) {
  if (gameState.isResetting) return;

  gameState.players   = (data && data.players)   ? data.players   : {};
  gameState.positions = (data && data.positions) ? data.positions : {};
  gameState.speeds    = (data && data.speeds)    ? data.speeds    : {};

  setupLanes();
  setupMobileControls();
  applySlotAvailability();

  // === Add lobby roster UI update here ===
  var playerList = document.getElementById('playerList');
  if (playerList) {
    playerList.innerHTML = '';
    Object.keys(gameState.players).forEach(function(pid) {
      var player = gameState.players[pid];
var div = document.createElement('div');
div.className = 'player-entry';

// mark host visually
if (data.hostSocketId && player.socketId === data.hostSocketId) {
  div.classList.add('host');
}


      var avatar = document.createElement('img');
      avatar.style.width = '24px';
      avatar.style.height = '24px';
      avatar.style.imageRendering = 'pixelated';
      avatar.alt = player.name;

      var upper = player.name.toUpperCase();
if (upper.includes('HORSE')) avatar.src = 'images/horse_1.png';
else if (upper.includes('MOOSE')) avatar.src = 'images/moose_1.png';
else if (upper.includes('PANDA')) avatar.src = 'images/panda_1.png';
else if (upper.includes('WOLF'))  avatar.src = 'images/wolf_1.png';


      var label = document.createElement('span');
      label.textContent = player.name.toUpperCase();

      div.appendChild(avatar);
      div.appendChild(label);
      playerList.appendChild(div);
    });

    // Update counter
    var counterEl = document.getElementById('playerCounter');
    var max = (data && typeof data.maxPlayers === 'number') ? data.maxPlayers : 4;
    if (counterEl) counterEl.textContent = 'Players joined: ' + Object.keys(gameState.players).length + '/' + max;
  }

  // === 🔽 Place your Start button code right here ===
  var startBtn = document.getElementById('startBtn');
  var playerCount = Object.keys(gameState.players).length;
  var isHost = (data && data.hostSocketId) ? (socket.id === data.hostSocketId) : false;

  if (startBtn) {
    if (isHost && playerCount >= 2 && playerCount < 4) {
      startBtn.style.display = 'block';
      var img = startBtn.querySelector('img');
      if (playerCount === 2) {
        img.src = "images/turbo_tails_start_2p_button.png";
        img.alt = "Start with 2 Players";
      } else if (playerCount === 3) {
        img.src = "images/turbo_tails_start_3p_button.png";
        img.alt = "Start with 3 Players";
      }
    } else if (isHost && playerCount === 4) {
      startBtn.style.display = 'none'; // auto-start case
    } else {
      startBtn.style.display = 'none';
    }
  }
});



socket.on('roomFull', function (payload) {
  var max = payload && payload.max ? payload.max : 4;
  alert('Room is full (' + max + ').');
});

socket.on('slotTaken', function (payload) {
  var n = payload && payload.playerNum ? payload.playerNum : '?';
  alert('Runner ' + n + ' is already taken. Please choose another slot.');
});

socket.on('gameStarted', function (data) {
  if (gameState.isResetting) return;

  var track   = document.getElementById('track');
  var results = document.getElementById('results');

  // Hide results (and ad inside it)
  if (results) {
    results.classList.remove('active');
    results.style.display = 'none';
  }

  // Show track
  if (track) {
    track.style.display = 'block';
    track.classList.add('active');
  }

if (sounds.playGo) sounds.playGo();

  // Start ambience
  // sounds.playRaceMusic();

  // Pause lobby music if still playing
  var bg = document.getElementById('bgMusic');
  if (bg && !bg.paused) bg.pause();

  // Reset state
  cameraState.cameraOffset = 0;
  gameState.raceStarted = true;
  gameState.raceFinished = false;
  gameState.finishTimes = {};

  if (data && data.positions) gameState.positions = data.positions;
  if (data && data.speeds)    gameState.speeds    = data.speeds;

  // Toggle UI
  var lobby = document.getElementById('lobby');
  var statusBar = document.getElementById('statusBar');
  var container = document.querySelector('.track-container');
  var mobileControls = document.getElementById('mobileControls');
  var grandstand = document.getElementById('grandstand');

  if (lobby) lobby.style.display = 'none';
  if (statusBar) statusBar.classList.add('active');
  if (container) {
  container.style.display = 'block';   // fix here
  container.classList.add('active');
}
  if (mobileControls) mobileControls.classList.add('active');
  if (grandstand) grandstand.classList.add('active');

  // Setup race
  ensureFinishLine();
  setupLanes();
  startCountdown();
  lockScroll(false);

  console.log('🏁 Race starting…');
});



socket.on('updateState', function (data) {
  if (gameState.isResetting || gameState.raceFinished) return;
  if (data && data.positions) {
    for (var k in data.positions) gameState.positions[k] = data.positions[k];
  }
  if (data && data.speeds) {
    for (var s in data.speeds) gameState.speeds[s] = data.speeds[s];
  }
});

// 🔄 Animation sync from server
socket.on('startAnimation', function({ playerId }) {
  startRunnerAnimation(playerId);
});
socket.on('stopAnimation', function({ playerId }) {
  stopRunnerAnimation(playerId);
});

socket.on('endRace', function (finishTimes) {
  if (gameState.isResetting || gameState.raceFinished) return;

  gameState.finishTimes = finishTimes || {};
  gameState.raceFinished = true;
  gameLoopRunning = false;

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  setTimeout(function () { if (!gameState.isResetting) endRace(); }, 400);
});

socket.on('roomReset', function () {
  console.log("Room was reset by server");

  // clear local game state
  gameState.roomId = null;
  gameState.players = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;

  // re-enable join button
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
  }

  // you can let resetGame() handle the rest of the UI
});


/* ------------------------------
   9) LAYOUT / SETUP HELPERS
------------------------------ */
function setupLanes() {
  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);

    if (gameState.players[i]) {
      if (lane) lane.style.display = 'flex';
      if (runner) {
        var startPos = 20;
        var pos = (typeof gameState.positions[i] === 'number') ? gameState.positions[i] : startPos;
        runner.style.left = pos + 'px';
        runner.classList.add('active');
        gameGraphics.updateRunnerSprite(i);

        if (!playerStates[i]) {
          playerStates[i] = {
            speed: 0,
            position: pos,
            lastTap: 0,
            isRunning: false,
            tapCount: 0,
            animationInterval: null
          };
        }
        playerStates[i].position = pos;
      }
      if (nameLabel) {
        nameLabel.textContent = (gameState.players[i].name || ('Runner ' + i)).toUpperCase();
        nameLabel.style.color = getPlayerColor(i);
      }
    } else {
      if (lane) lane.style.display = 'none';
      if (runner) runner.classList.remove('active');
    }
  }
}

function getPlayerColor(i) {
  var colors = ['#FF4444', '#44FF44', '#4444FF', '#FFFF44'];
  return colors[i - 1] || '#FFFFFF';
}

/* ------------------------------
   10) MOBILE CONTROLS (my players only, dual buttons)
------------------------------ */
function setupMobileControls() {
  var controlLayout = document.getElementById('controlLayout');
  if (!controlLayout) return;

  controlLayout.innerHTML = '';

  // Only render controls for players belonging to THIS socket
  var myPlayers = [];
  for (var k in gameState.players) {
    var p = gameState.players[k];
    if (p && p.socketId === socket.id) myPlayers.push(p);
  }

  if (myPlayers.length === 0) {
    return; // spectator mode on this device
  }

  myPlayers.forEach(function(player){
    var wrapper = document.createElement('div');
    wrapper.className = 'player-touch-controls player' + player.id + ' dual';
    wrapper.innerHTML = ''
      + '<div class="control-player-label" style="color:'+ getPlayerColor(player.id) +'">'
      + (player.name || ('Runner ' + player.id)).toUpperCase()
      + '</div>'
      + '<div class="dual-buttons">'
      + '  <div class="touch-btn tap-btn small" data-player="'+player.id+'" data-side="L">TAP</div>'
      + '  <div class="touch-btn tap-btn small" data-player="'+player.id+'" data-side="R">TAP</div>'
      + '</div>';
    controlLayout.appendChild(wrapper);
  });

  var btns = controlLayout.querySelectorAll('.tap-btn');
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    if (btn._bound) continue;
    btn.style.touchAction = 'none';
    btn.style.userSelect = 'none';

    (function(b){
      var pid = parseInt(b.getAttribute('data-player'), 10);
      var tap = function (e) { tapOnce(e, pid); };
      var release = function (e) { tapRelease(e, pid); };

      b.addEventListener('touchstart', tap,   { passive:false });
      b.addEventListener('touchend',   release, { passive:false });
      b.addEventListener('mousedown',  tap);
      b.addEventListener('mouseup',    release);

      b.addEventListener('contextmenu', function(e){ e.preventDefault(); });
      b.addEventListener('dragstart',   function(e){ e.preventDefault(); });
      b._bound = true;
    })(btn);
  }
}

/* ------------------------------
   11) INPUT / ANIMATION CONTROL
------------------------------ */
function tapOnce(e, playerId) {
  e.preventDefault(); e.stopPropagation();

  if (gameState.countdownActive) {
    var btn = e.target.closest ? e.target.closest('.touch-btn') : null;
    if (btn) { btn.classList.add('active'); setTimeout(function(){ btn.classList.remove('active'); }, 120); }
    return;
  }
  if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) return;

  var btn2 = e.target.closest ? e.target.closest('.touch-btn') : null;
  if (btn2) btn2.classList.add('active');

  if (!playerStates[playerId]) playerStates[playerId] = {};
  playerStates[playerId].lastTap = Date.now();

  // locally start anim immediately (feels responsive) — server will broadcast too
  startRunnerAnimation(playerId);

  socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });

  spawnDust(playerId);

  if (sounds.initialized) sounds.playTap();
  if (navigator.vibrate) navigator.vibrate(10);
}

function tapRelease(e, playerId) {
  e.preventDefault(); e.stopPropagation();
  var btn = e.target.closest ? e.target.closest('.touch-btn') : null;
  if (btn) btn.classList.remove('active');

  var runner = document.getElementById('runner' + playerId);
  if (!runner) return;
  clearTimeout(runner._stopTimer);
  runner._stopTimer = setTimeout(function(){ stopRunnerAnimation(playerId); }, 300);
}

/* Animation helpers */
function startRunnerAnimation(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  if (!playerStates[playerId]) {
    playerStates[playerId] = { animationInterval: null, isRunning: false, lastTap: Date.now() };
  }
  if (playerStates[playerId].isRunning) return;

  runner.classList.add('running');
  playerStates[playerId].isRunning = true;

  if (runner.dataset.frames && !playerStates[playerId].animationInterval) {
    playerStates[playerId].animationInterval = setInterval(function () {
      if (playerStates[playerId] && playerStates[playerId].isRunning) gameGraphics.animateSprite(playerId);
    }, 80); // ~12.5 fps
  }
}

function stopRunnerAnimation(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  var lastTap = playerStates[playerId] ? (playerStates[playerId].lastTap || 0) : 0;
  if (Date.now() - lastTap < 280) return; // tapped again recently

  runner.classList.remove('running');
  if (playerStates[playerId]) {
    playerStates[playerId].isRunning = false;
    if (playerStates[playerId].animationInterval) {
      clearInterval(playerStates[playerId].animationInterval);
      playerStates[playerId].animationInterval = null;
    }
  }
}

function spawnDust(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner || !runner.parentElement) return;

  var dust = document.createElement('div');
  dust.className = 'dust';
  dust.textContent = '💨';
  dust.style.left = (runner.offsetLeft - 12) + 'px';
  dust.style.top  = runner.offsetTop + 'px';
  runner.parentElement.appendChild(dust);
  setTimeout(function(){ dust.remove(); }, 420);
}

/* ------------------------------
   12) COUNTDOWN / TIMER / GAMELOOP
------------------------------ */
function startCountdown() {
  if (gameState.isResetting) return;

  gameState.countdownActive = true;
  var count = 3;
  var countdownEl = document.getElementById('countdown');
  if (!countdownEl) return;

  countdownEl.style.display = 'block';
  countdownEl.textContent = String(count);

  var interval = setInterval(function () {
    if (gameState.isResetting) {
      clearInterval(interval);
      countdownEl.style.display = 'none';
      gameState.countdownActive = false;
      return;
    }

    count--;
    if (count > 0) {
      countdownEl.textContent = String(count);
      if (sounds.initialized) sounds.playCountdown();
    } else if (count === 0) {
      countdownEl.textContent = 'GO!';
      if (sounds.initialized) sounds.playGo();
      launchTickerTape();
    } else {
      clearInterval(interval);
      countdownEl.style.display = 'none';
      gameState.countdownActive = false;
      gameState.startTime = Date.now();
      startTimer();
      startGameLoop();
      console.log('⏱️ Race timer started');
    }
  }, 1000);
}

function startTimer() {
  var timerElement = document.getElementById('timer');
  if (!timerElement) return;

  timerInterval = setInterval(function () {
    if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) {
      clearInterval(timerInterval);
      return;
    }
    var elapsed = (Date.now() - gameState.startTime) / 1000;
    timerElement.textContent = elapsed.toFixed(3);
  }, 50);
}

function startGameLoop() {
  if (gameLoopRunning || gameState.isResetting) return;
  gameLoopRunning = true;
  requestAnimationFrame(gameLoop);
}

function gameLoop() {
  if (!gameLoopRunning || !gameState.raceStarted || gameState.raceFinished || gameState.isResetting) {
    gameLoopRunning = false;
    return;
  }
  updateGame();
  for (var pid in gameState.players) checkFinish(pid);
  requestAnimationFrame(gameLoop);
}

/* ------------------------------
   13) CORE UPDATE + CAMERA + PARALLAX
------------------------------ */
function updateGame() {
  if (gameState.isResetting) return;

  var leadingPlayerPosition = 0;
  var leadingPlayerId = null;

  // Apply positions to DOM; animation controlled by taps only (not speed)
  for (var playerId in gameState.players) {
    var position = (typeof gameState.positions[playerId] === 'number') ? gameState.positions[playerId] : 20;
    var runner = document.getElementById('runner' + playerId);

    if (runner) {
      runner.style.left = (position > 20 ? position : 20) + 'px';

      if (!playerStates[playerId]) {
        playerStates[playerId] = { speed:0, position:position, lastTap:0, isRunning:false, tapCount:0, animationInterval:null };
      }
      playerStates[playerId].position = position;
    }

    if ((playerStates[playerId] && playerStates[playerId].position || 0) > leadingPlayerPosition) {
      leadingPlayerPosition = playerStates[playerId].position;
      leadingPlayerId = playerId;
    }
  }

  // Camera follow: keep leader ~30% from left
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var grandstand = document.getElementById('grandstand');

  if (!track || !container || leadingPlayerId === null) return;

  var leadingRunnerElement = document.getElementById('runner' + leadingPlayerId);
  if (leadingRunnerElement) {
    var screenOffset = container.offsetWidth * 0.3;
    var currentRunnerX = leadingRunnerElement.offsetLeft;
    var newOffset = Math.max(0, currentRunnerX - screenOffset);
    cameraState.cameraOffset = Math.min(newOffset, gameState.trackWidth - container.offsetWidth);
  }

  // Apply transforms
  track.style.transform = 'translateX(-' + cameraState.cameraOffset + 'px)';

  // Parallax: background scroll (seamless)
  if (grandstand) {
    var parallaxOffset = cameraState.cameraOffset * 0.5;
    grandstand.style.backgroundPositionX = '-' + parallaxOffset + 'px';
  }
}

/* ------------------------------
   14) FINISH & RESULTS
------------------------------ */
function checkFinish(playerId) {
  if (!playerStates[playerId] || gameState.finishTimes[playerId] || gameState.isResetting) return;

  var trackElement = document.getElementById('track');
  if (trackElement) gameState.trackWidth = trackElement.offsetWidth;

  var isMobile = window.innerWidth <= 480;
  var finishLineOffset = isMobile ? 50 : 80;
  var finishLinePosition = gameState.trackWidth - finishLineOffset - 20;

  var currentPosition = (typeof gameState.positions[playerId] === 'number') ? gameState.positions[playerId] : 20;
  if (currentPosition >= finishLinePosition) {
    var finishTime = (Date.now() - gameState.startTime) / 1000;
    gameState.finishTimes[playerId] = finishTime;

    if (sounds.initialized) sounds.playFinish();

    socket.emit('checkFinish', { roomId: gameState.roomId, playerId: playerId, finishTime: finishTime });

    // Stop this runner's animation
    var runner = document.getElementById('runner' + playerId);
    if (runner) stopRunnerAnimation(playerId);

    // If every active player finished, end race
    var allFinished = true;
    for (var id in gameState.players) {
      if (typeof gameState.finishTimes[id] === 'undefined') { allFinished = false; break; }
    }
    if (allFinished) {
      setTimeout(function(){ socket.emit('endRace', gameState.roomId); }, 300);
    }
  }
}

function endRace() {
  showResults();
  console.log('🏆 Race finished — showing results.');
}

function showResults() {
  var mobileControls = document.getElementById('mobileControls');
  var track = document.getElementById('track');
  var results = document.getElementById('results');
  var statusBar = document.getElementById('statusBar');
  var grandstand = document.getElementById('grandstand');
  var container = document.querySelector('.track-container');

  // Hide all race UI hard (class + inline) so nothing overlays
  if (mobileControls) mobileControls.classList.remove('active');
  if (statusBar) statusBar.classList.remove('active');
  if (grandstand) grandstand.classList.remove('active');

  if (track)   { track.classList.remove('active');   track.style.display = 'none'; }
  if (container){container.classList.remove('active');container.style.display = 'none'; }

  // Show results hard (class + inline)
  if (results) {
  results.classList.add('active');
  results.style.display = ''; // make sure it's shown
}



  // Scroll to top so results are visible
  var screen = document.getElementById('screen');
  if (screen) screen.scrollTop = 0;
  window.scrollTo(0, 0);

  // ...keep your existing leaderboard-building code here ...



  var leaderboard = document.getElementById('leaderboard');
  if (!leaderboard) return;
  leaderboard.innerHTML = '';

  var sorted = Object.keys(gameState.finishTimes).map(function(pid){
    return { playerId: pid, time: gameState.finishTimes[pid], name: (gameState.players[pid] && gameState.players[pid].name) || ('Runner ' + pid) };
  }).sort(function(a,b){ return a.time - b.time; });

  console.log("Sorted results:", sorted);


  var medals = ['🥇','🥈','🥉','🏅'];
  sorted.forEach(function(r, index){
    var row = document.createElement('div');
    row.className = 'result-item';
    row.innerHTML = '<span>' + (medals[index] || '🏅') + ' ' + (index+1) + '. ' + r.name.toUpperCase() + '</span> <span>' + r.time.toFixed(3) + '</span>';
    leaderboard.appendChild(row);
  });

  // Winner celebration bounce
  var winner = sorted[0];
  if (winner) {
    var winnerRunner = document.getElementById('runner' + winner.playerId);
    if (winnerRunner) winnerRunner.classList.add('winner');
  }

  // if an ad placeholder exists, you can (re)request fill here
  // e.g., if using AdSense Auto Ads, nothing needed; for a manual slot, insert the script/snippet in index.html
}

/* ------------------------------
   15) RESET
------------------------------ */
function resetGame() {
  if (gameState.isResetting) return;
  gameState.isResetting = true;
  gameState.countdownActive = false;
  gameLoopRunning = false;

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  cameraState.cameraOffset = 0;

  // Clear animations
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }

  // Hide results
  const results = document.getElementById('results');
  if (results) {
    results.classList.remove('active');
    results.style.display = 'none';
  }

  // Reset state
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.finishTimes = {};
  gameState.positions = {};
  gameState.speeds = {};
  playerStates = {};
  sounds.stopCrowd();

  // Reset UI
  for (var i = 1; i <= 4; i++) {
    var runner = document.getElementById('runner' + i);
    if (runner) {
      runner.style.left = '20px';
      runner.classList.remove('running', 'active', 'winner');
      if (runner.dataset.frames) {
        var frames = JSON.parse(runner.dataset.frames);
        if (frames.length > 0) {
          runner.style.backgroundImage = 'url(' + frames[0] + ')';
          runner.dataset.currentFrame = '0';
        }
      }
    }
  }

  var lobby = document.getElementById('lobby');
  var statusBar = document.getElementById('statusBar');
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var mobileControls = document.getElementById('mobileControls');
  var grandstand = document.getElementById('grandstand');
  var timer = document.getElementById('timer');
  var countdown = document.getElementById('countdown');

  if (lobby) lobby.style.display = 'block';
  if (statusBar) statusBar.classList.remove('active');
  if (container) container.classList.remove('active');
  if (track) { track.classList.remove('active'); track.style.display = 'none'; track.style.transform = 'translateX(0px)'; }
  if (mobileControls) mobileControls.classList.remove('active');
  if (grandstand) { grandstand.classList.remove('active'); grandstand.style.backgroundPositionX = '0px'; }
  if (timer) timer.textContent = '00.000';
  if (countdown) countdown.style.display = 'none';

  lockScroll(true);

  // Clear lobby list
  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = "";

  // Tell server to reset
  socket.emit('resetRoom', gameState.roomId);

  setTimeout(function(){ gameState.isResetting = false; }, 800);
}


/* ------------------------------
   16) LOBBY HELPERS
------------------------------ */
function applySlotAvailability() {
  for (var i = 1; i <= 4; i++) {
    var label = document.querySelector('[data-player="' + i + '"] .control-player-label');
    var isTaken = !!(gameState.players && gameState.players[i]);
    if (label && isTaken) {
      label.textContent = (gameState.players[i].name || ('Runner ' + i)).toUpperCase();
    }
  }
}

/* ------------------------------
   17) JOIN ROOM (works with Quick Race)
------------------------------ */
function joinRoom() {
  if (gameState.isResetting) return;

  if (!gameState.roomId) {
    socket.once('roomAssigned', function (data) {
      if (data && data.roomId) {
        gameState.roomId = data.roomId;
        joinRoom();
      }
    });
    socket.emit('quickRace');
    return;
  }

  // Find first available slot automatically
  var slot = null;
  for (var i = 1; i <= 4; i++) {
    if (!gameState.players[i]) { slot = i; break; }
  }
  if (!slot) { alert('All runner slots are taken!'); return; }

  socket.emit('joinRoom', { roomId: gameState.roomId, playerNum: slot });

  // Hide Join button after success
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.style.display = 'none';
  var bg = document.getElementById('bgMusic');
if (bg) bg.play().catch(()=>{ /* waiting for user gesture is fine */ });

}


/* ------------------------------
   18) UTILITIES & INIT HOOKS
------------------------------ */
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && /MacIntel/.test(navigator.platform));
}

window.addEventListener('resize', function () {
  var raceLengthPx = isMobileDevice() ? 1200 : 1500;
  var trackElement = document.getElementById('track');
  if (trackElement) {
    trackElement.style.width = raceLengthPx + 'px';
    gameState.trackWidth = raceLengthPx;
  } else {
    gameState.trackWidth = Math.max(window.innerWidth - 60, 300);
  }
  ensureFinishLine();
});

// Initialize early for mobile Safari + on full load
document.addEventListener('DOMContentLoaded', initGame);
window.addEventListener('load', initGame);

// Expose for debugging
window.gameState = gameState;
window.playerStates = playerStates;
window.resetGame = resetGame;
window.gameGraphics = gameGraphics;
