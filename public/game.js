/* =========================================================
   TURBO TAILS — GAME CLIENT (global lobby + quick race)
   - 4-player private rooms (invisible to users)
   - Quick Race assigns you to a waiting room
   - Host-only Start, min players = 2
   - Pixel sprites: start/stop on tap, dust puffs
   - Parallax grandstand + camera follow
   - Finish line stripe + correct z-order
   - Greys out taken runner slots
   - Renders controls only for *my* player(s)
   - Safari-safe (no optional chaining / nullish coalescing)
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


/* ===================== 8-bit SFX engine ===================== */
const SFX = (() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = 0.6;
  master.connect(ctx.destination);

  let muted = false;
  const now = () => ctx.currentTime;

  // resume on first interaction (iOS requires a gesture)
  const resume = () => { if (ctx.state === 'suspended') ctx.resume(); };

  // simple envelopes
  function envNode(duration=0.2, {attack=0.005, decay=0.1, sustain=0.6, release=0.05, peak=1.0, end=0.0}={}) {
    const g = ctx.createGain();
    const t = now();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.linearRampToValueAtTime(peak*sustain, t + attack + decay);
    g.gain.setValueAtTime(peak*sustain, t + duration);
    g.gain.linearRampToValueAtTime(end, t + duration + release);
    return g;
  }

  // 8-bit blip (square/triangle)
  function blip({freq=440, dur=0.08, type='square', vol=0.4, slide=0}={}) {
    if (muted) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, now() + dur);
    const g = envNode(dur, {attack:0.002, decay:0.07, sustain:0.3, release:0.03, peak:vol});
    o.connect(g).connect(master);
    o.start(); o.stop(now() + dur + 0.05);
  }

  // white/pink noise burst (whoosh, tape snap, crowd)
  function noise({dur=0.2, vol=0.4, color='white', lp=8000, hp=200}={}) {
    if (muted) return;
    const bufferSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i=0;i<bufferSize;i++){
      const white = Math.random()*2-1;
      // pink-ish
      lastOut = color==='pink' ? (lastOut + 0.02*white) / 1.02 : white;
      data[i] = color==='pink' ? lastOut*3.5 : white;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const lpf = ctx.createBiquadFilter(); lpf.type='lowpass';  lpf.frequency.value = lp;
    const hpf = ctx.createBiquadFilter(); hpf.type='highpass'; hpf.frequency.value = hp;

    const g = envNode(dur, {attack:0.005, decay:dur*0.7, sustain:0.2, release:0.03, peak:vol});
    src.connect(hpf).connect(lpf).connect(g).connect(master);
    src.start(); src.stop(now()+dur+0.1);
  }

  // chord helper for GO/fanfare
  function chord(freqs=[440,550,660], dur=0.2, vol=0.35, type='square'){
    if (muted) return;
    const g = envNode(dur, {attack:0.01, decay:0.12, sustain:0.4, release:0.06, peak:vol});
    g.connect(master);
    freqs.forEach(f=>{
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f;
      o.connect(g); o.start(); o.stop(now()+dur+0.08);
    });
  }

  // arpeggio jingle (win)
  function arpeggio(root=440, steps=[0,7,12,19,24], rate=0.07){
    if (muted) return;
    steps.forEach((st,i)=>{
      const f = root * Math.pow(2, st/12);
      setTimeout(()=> blip({freq:f, dur:0.09, type:'triangle', vol:0.5}), i*rate*1000);
    });
  }

  // public presets
  let lastStepAt = 0;
  function step(){
    const t = performance.now();
    if (t - lastStepAt < 65) return; // throttle
    lastStepAt = t;
    blip({freq: Math.random()<.5? 420:480, dur:0.06, type:'square', vol:0.35});
  }
  const tapBoost = () => noise({dur:0.12, vol:0.35, color:'white', lp:4000, hp:300});
  const overtake = () => noise({dur:0.18, vol:0.28, color:'white', lp:5000, hp:1000});
  const checkpoint = () => blip({freq:700, dur:0.04, type:'square', vol:0.25});
  const tapeSnap   = () => noise({dur:0.08, vol:0.45, color:'white', lp:7000, hp:1200});
  const crowdCheer = () => noise({dur:1.2, vol:0.18, color:'pink', lp:3500, hp:200});

  // countdown set
  function countdownTick(n){
    blip({freq: 360 + n*60, dur:0.08, type:'square', vol:0.45});
  }
  function goHorn(){
    chord([440,554,659], 0.18, 0.45, 'square');
    setTimeout(()=>noise({dur:0.18, vol:0.28, color:'white', lp:3000, hp:200}), 40);
  }

  function winJingle(){ arpeggio(330, [0,7,12,19,24,31], 0.065); crowdCheer(); }
  function loseBeep(){ blip({freq:220,dur:0.25,type:'square',vol:0.35,slide:-80}); }

  function setMute(v){
    muted = !!v;
    master.gain.value = muted ? 0.0 : 0.6;
    const mb = document.getElementById('muteBtn');
    if (mb) mb.textContent = muted ? '🔇' : '🔊';
  }

  // UI hookup for mute + resume on gesture
  window.addEventListener('pointerdown', resume, { once:true, passive:true });
  window.addEventListener('touchstart', resume, { once:true, passive:true });
  document.addEventListener('click', (e)=>{
    if (e.target && e.target.id === 'muteBtn') setMute(!muted);
  });

  return {
    resume, setMute, step, tapBoost, overtake, checkpoint, tapeSnap, crowdCheer,
    countdownTick, goHorn, winJingle, loseBeep, blip, chord, noise
  };
})();


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

/* ------------------------------
   3) SOUND (tiny retro bleeps)
------------------------------ */
var sounds = {
  initialized: false,
  playCountdown: null,
  playGo: null,
  playTap: null,
  playFinish: null,
  playCrowd: null
};

function initSounds() {
  if (sounds.initialized) return;
  var AudioContext = window.AudioContext || window.webkitAudioContext;
  try {
    var audioContext = new AudioContext();

    var mkBeep = function(freq, dur, vol, type) {
      dur = dur || 0.1; vol = vol || 0.3; type = type || 'square';
      var osc = audioContext.createOscillator();
      var gain = audioContext.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioContext.destination);
      gain.gain.setValueAtTime(vol, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + dur);
      osc.start(audioContext.currentTime);
      osc.stop(audioContext.currentTime + dur);
    };

    sounds.playCountdown = function() { mkBeep(800, 0.1, 0.3, 'square'); };
    sounds.playGo       = function() { mkBeep(1200, 0.3, 0.4, 'square'); };
    sounds.playTap      = function() { mkBeep(200 + Math.random() * 100, 0.05, 0.1, 'triangle'); };

    sounds.playFinish = function() {
      [800, 1000, 1200].forEach(function(f, i) { setTimeout(function(){ mkBeep(f, 0.2, 0.3, 'square'); }, i * 100); });
    };

    // simple crowd noise (short)
    sounds.playCrowd = function() {
      var seconds = 1.2;
      var noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * seconds, audioContext.sampleRate);
      var output = noiseBuffer.getChannelData(0);
      for (var i = 0; i < output.length; i++) output[i] = (Math.random() * 2 - 1) * 0.05;

      var src = audioContext.createBufferSource();
      src.buffer = noiseBuffer;

      var filter = audioContext.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000;
      filter.Q.value = 0.6;

      var gain = audioContext.createGain();
      gain.gain.setValueAtTime(0.12, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + seconds);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(audioContext.destination);
      src.start();
    };

    sounds.initialized = true;
  } catch (e) {
    // no audio (ok)
  }
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
  // auto-assign this socket to a waiting room so it receives roster updates
if (!gameState.roomId) socket.emit('quickRace');

}

/* ------------------------------
   8) SOCKET EVENTS
------------------------------ */
socket.on('connect', function(){});
socket.on('disconnect', function(){});

// Assigned to a waiting room (global lobby)
socket.on('roomAssigned', function (data) {
  if (!data) return;
  gameState.roomId = data.roomId;
  // no visible room numbers; just store for joinRoom()
});

// Roster update
socket.on('playerJoined', function (data) {
  var count = Object.keys(gameState.players).length;
  if (gameState.isResetting) return;

  gameState.players   = (data && data.players)   ? data.players   : {};
  gameState.positions = (data && data.positions) ? data.positions : {};
  gameState.speeds    = (data && data.speeds)    ? data.speeds    : {};

  setupLanes();
  setupMobileControls();  // render controls only for my socket
  applySlotAvailability();

  // update the counter text
var counterEl = document.getElementById('playerCounter');
var max = (data && typeof data.maxPlayers === 'number') ? data.maxPlayers : 4;
if (counterEl) counterEl.textContent = 'Players joined: ' + count + '/' + max;


  // Host-only Start logic
  var startBtn = document.getElementById('startBtn');
  var count = Object.keys(gameState.players).length;
  var minToStart = (data && typeof data.minToStart === 'number') ? data.minToStart : 2;
  var isHost = (data && data.hostSocketId) ? (socket.id === data.hostSocketId) : false;
  if (startBtn) startBtn.style.display = (isHost && count >= minToStart) ? 'block' : 'none';

  var waitingEl = document.getElementById('waitingLabel');
  if (waitingEl) waitingEl.style.display = isHost ? 'none' : 'block';

  // hide loader if still visible
  var loading = document.getElementById('loadingScreen');
  if (loading) {
    loading.style.opacity = '0';
    setTimeout(function(){ loading.style.display = 'none'; }, 400);
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

  // Reset camera
  cameraState.cameraOffset = 0;

  gameState.raceStarted = true;
  gameState.raceFinished = false;
  gameState.finishTimes = {};

  if (data && data.positions) gameState.positions = data.positions;
  if (data && data.speeds) gameState.speeds = data.speeds;

  // UI toggles
  var lobby = document.getElementById('lobby');
  var statusBar = document.getElementById('statusBar');
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var mobileControls = document.getElementById('mobileControls');
  var grandstand = document.getElementById('grandstand');

  if (lobby) lobby.style.display = 'none';
  if (statusBar) statusBar.classList.add('active');
  if (container) container.classList.add('active');
  if (track) { track.style.display = 'block'; track.classList.add('active'); }
  if (mobileControls) mobileControls.classList.add('active');
  if (grandstand) grandstand.classList.add('active');

  //SFX.crowdCheer();
//setTimeout(() => SFX.crowdCheer(), 900);  // quick second swell

 if (sounds.initialized) sounds.playCrowd();

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

socket.on('endRace', function (finishTimes) {
  if (gameState.isResetting || gameState.raceFinished) return;

  gameState.finishTimes = finishTimes || {};
  gameState.raceFinished = true;
  gameLoopRunning = false;

  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  setTimeout(function () { if (!gameState.isResetting) endRace(); }, 400);
});

socket.on('roomReset', function () {
  // UI reset will be handled by resetGame()
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
        nameLabel.textContent = (gameState.players[i].name || '').toUpperCase();
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
   (Sprite start/stop + dust)
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

  if (mobileControls) mobileControls.classList.remove('active');
  if (container) container.classList.remove('active');
  if (track) track.classList.remove('active');
  if (statusBar) statusBar.classList.remove('active');
  if (grandstand) grandstand.classList.remove('active');
  if (results) results.classList.add('active');

  var leaderboard = document.getElementById('leaderboard');
  if (!leaderboard) return;
  leaderboard.innerHTML = '';

  var sorted = Object.keys(gameState.finishTimes).map(function(pid){
    return { playerId: pid, time: gameState.finishTimes[pid], name: (gameState.players[pid] && gameState.players[pid].name) || ('Runner ' + pid) };
  }).sort(function(a,b){ return a.time - b.time; });

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

  // Reset camera
  cameraState.cameraOffset = 0;

  // Clear animation intervals
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }

  // Reset game state
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.finishTimes = {};
  gameState.positions = {};
  gameState.speeds = {};
  playerStates = {};

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
    var input = document.getElementById('player' + i + '-name');
    if (input) { input.value = ''; input.disabled = false; input.style.opacity = '1'; input.placeholder = 'NAME'; }
    var card = document.querySelector('[data-player="' + i + '"]');
    if (card) card.classList.remove('active');
  }

  var lobby = document.getElementById('lobby');
  var statusBar = document.getElementById('statusBar');
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var mobileControls = document.getElementById('mobileControls');
  var results = document.getElementById('results');
  var grandstand = document.getElementById('grandstand');
  var timer = document.getElementById('timer');
  var countdown = document.getElementById('countdown');

  if (lobby) lobby.style.display = 'block';
  if (statusBar) statusBar.classList.remove('active');
  if (container) container.classList.remove('active');
  if (track) { track.classList.remove('active'); track.style.display = 'none'; track.style.transform = 'translateX(0px)'; }
  if (mobileControls) mobileControls.classList.remove('active');
  if (results) results.classList.remove('active');
  if (grandstand) { grandstand.classList.remove('active'); grandstand.style.backgroundPositionX = '0px'; }
  if (timer) timer.textContent = '00.000';
  if (countdown) countdown.style.display = 'none';

  // We *keep* gameState.roomId so Quick Race/room stays; or set to null to force fresh room next time.
  // gameState.roomId = null;

  lockScroll(true);

  socket.emit('resetRoom', gameState.roomId);

  setTimeout(function(){ gameState.isResetting = false; }, 800);
}

/* ------------------------------
   16) LOBBY HELPERS
------------------------------ */
function applySlotAvailability() {
  for (var i = 1; i <= 4; i++) {
    var input = document.getElementById('player' + i + '-name');
    var label = document.querySelector('[data-player="' + i + '"] .control-player-label');
    var isTaken = !!(gameState.players && gameState.players[i]);

    if (input) {
      input.disabled = isTaken;
      input.placeholder = isTaken ? 'TAKEN' : 'NAME';
      input.style.opacity = isTaken ? '0.5' : '1';
    }
    if (label && isTaken) {
      label.textContent = (gameState.players[i].name || ('Runner ' + i)).toUpperCase();
    }
  }
}

/* ------------------------------
   17) JOIN ROOM (works with/without Quick Race)
------------------------------ */
function joinRoom() {
  if (gameState.isResetting) return;

  // If no room assigned yet (user hit Join first), ask server for one and retry.
  if (!gameState.roomId) {
    socket.once('roomAssigned', function (data) {
      if (data && data.roomId) {
        gameState.roomId = data.roomId;
        joinRoom(); // re-run with a real room id
      }
    });
    socket.emit('quickRace');
    return;
  }

  // Collect player names from inputs (slots 1–4)
  for (var i = 1; i <= 4; i++) {
    var input = document.getElementById('player' + i + '-name');
    var name = (input && input.value ? input.value : '').trim();
    if (name) {
      if (!gameState.players[i]) gameState.players[i] = { id: i, name: name, active: false };
      else gameState.players[i].name = name;
    } else {
      delete gameState.players[i];
    }
  }

  // Require at least one runner
  var toJoin = [];
  for (var k in gameState.players) { if (gameState.players[k] && !gameState.players[k].active) toJoin.push(gameState.players[k]); }
  if (toJoin.length === 0) {
    alert('Enter at least one runner name!');
    return;
  }

  // Emit a join for each named runner
  toJoin.forEach(function(p){
    socket.emit('joinRoom', {
      roomId: gameState.roomId,      // uses server-assigned room
      playerName: p.name,
      playerNum: p.id
    });
    p.active = true; // mark locally to avoid double-join
  });

  // Hide Join button (avoid repeats)
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.style.display = 'none';
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
