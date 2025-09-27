/* =========================================================
   SUSHI SPRINT – GAME CLIENT (global lobby + quick race)
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
   KANJI EFFECTS SYSTEM - FIXED UNICODE
------------------------------ */
var kanjiEffects = {
  // Kanji with meanings for different events
  characters: {
    speed: { kanji: '速', meaning: 'SPEED', color: '#00FF88' },
    power: { kanji: '力', meaning: 'POWER', color: '#FFD700' },
    victory: { kanji: '勝', meaning: 'VICTORY', color: '#FF3366' },
    start: { kanji: '始', meaning: 'START', color: '#FFFFFF' },
    finish: { kanji: '終', meaning: 'FINISH', color: '#FF3366' },
    boost: { kanji: '加速', meaning: 'BOOST', color: '#00FFFF' },
    slow: { kanji: '遅', meaning: 'SLOW', color: '#8B4513' }
  },

  showKanji: function(type, playerId = null) {
    const char = this.characters[type];
    if (!char) return;

    const kanji = document.createElement('div');
    kanji.className = 'kanji-effect';
    kanji.innerHTML = `
      <div class="kanji-main">${char.kanji}</div>
      <div class="kanji-meaning">${char.meaning}</div>
    `;

    // Position based on whether it's for a specific player or global
    if (playerId) {
      const runner = document.getElementById('runner' + playerId);
      if (runner && runner.parentElement) {  // Check parentElement exists
        kanji.style.cssText = `
          position: absolute;
          left: ${runner.offsetLeft + 16}px;
          top: ${runner.offsetTop - 40}px;
          color: ${char.color};
          font-family: 'Noto Sans JP', serif;
          text-align: center;
          font-weight: bold;
          z-index: 200;
          animation: kanjiPlayerPop 2s ease-out forwards;
          pointer-events: none;
        `;
        
        // Use the track container instead of track directly
        const track = document.getElementById('track') || runner.parentElement;
        if (track) track.appendChild(kanji);
      }
    } else {
      // Global/screen-center kanji
      kanji.style.cssText = `
        position: fixed;
        top: 30%;
        left: 50%;
        transform: translateX(-50%);
        color: ${char.color};
        font-family: 'Noto Sans JP', serif;
        text-align: center;
        font-weight: bold;
        z-index: 9999;
        animation: kanjiGlobalPop 3s ease-out forwards;
        pointer-events: none;
      `;
      document.body.appendChild(kanji);
    }

    setTimeout(() => {
      if (kanji && kanji.parentElement) {
        kanji.remove();
      }
    }, 3000);
  }
};

/* =========================================================
   ENHANCED SUSHI SPRINT - Dynamic Elements & Power-ups
   New Features:
   - Dynamic track obstacles and speed zones
   - Power-ups and special abilities
   - Tokyo atmosphere effects
   ========================================================= */

/* ------------------------------
   POWER-UP SYSTEM - FIXED
------------------------------ */
var powerUpSystem = {
  types: {
    SOY_SPLASH: { 
      id: 'soy', 
      name: 'Soy Splash', 
      color: '#8B4513', 
      icon: '🍶',
      duration: 2000,
      effect: 'slowOpponents'
    },
    GINGER_BOOST: { 
      id: 'ginger', 
      name: 'Ginger Rush', 
      color: '#FFD700', 
      icon: '🫚',
      duration: 3000,
      effect: 'speedBoost'
    },
    CHOPSTICK_GRAB: { 
      id: 'chopsticks', 
      name: 'Chopstick Pull', 
      color: '#8B4513', 
      icon: '🥢',
      duration: 1000,
      effect: 'instantForward'
    },
    RICE_SHIELD: { 
      id: 'rice', 
      name: 'Rice Shield', 
      color: '#FFFFFF', 
      icon: '🍚',
      duration: 5000,
      effect: 'shield'
    }
  },

  activePowerUps: {}, // playerId -> powerup data

  createPowerUp: function(type, x, y) {
    const powerUp = document.createElement('div');
    powerUp.className = 'power-up';
    powerUp.dataset.type = type.id;
    powerUp.style.left = x + 'px';
    powerUp.style.top = y + 'px';
    powerUp.style.backgroundColor = type.color;
    powerUp.textContent = type.icon;
    powerUp.style.cssText += `
      position: absolute;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      border: 2px solid #FFD700;
      animation: powerUpFloat 2s ease-in-out infinite;
      z-index: 10;
    `;
    
    const track = document.getElementById('track');
    if (track) track.appendChild(powerUp);
    return powerUp;
  },

  spawnRandomPowerUps: function() {
    if (!gameState.raceStarted || gameState.raceFinished) return;
    
    const track = document.getElementById('track');
    if (!track) return;

    // Spawn power-up every 3-5 seconds during race
    if (Math.random() < 0.3) {
      const types = Object.values(this.types);
      const randomType = types[Math.floor(Math.random() * types.length)];
      
      const x = Math.random() * (gameState.trackWidth - 100) + 50;
      const laneHeight = track.offsetHeight / 4;
      const lane = Math.floor(Math.random() * 4);
      const y = lane * laneHeight + laneHeight/2 - 12;
      
      this.createPowerUp(randomType, x, y);
    }
  },

checkCollisions: function(playerId) {
  const runner = document.getElementById('runner' + playerId);
  if (!runner) return;
  
  const powerUps = document.querySelectorAll('.power-up');
  powerUps.forEach(powerUp => {
    const runnerRect = runner.getBoundingClientRect();
    const powerUpRect = powerUp.getBoundingClientRect();
    
    if (this.isColliding(runnerRect, powerUpRect)) {
      const typeId = powerUp.dataset.type;
      console.log('Power-up collision detected! Type:', typeId); // DEBUG
      
      let matchedType = null;
      for (const [key, type] of Object.entries(this.types)) {
        if (type.id === typeId) {
          matchedType = type;
          break;
        }
      }
      
      if (matchedType) {
        console.log('Matched type found:', matchedType.name, 'Effect:', matchedType.effect); // DEBUG
        
        // Play sound and animate removal
        this.playPowerUpSound(matchedType.effect);
        this.removePowerUpWithEffect(powerUp);
        
        this.activatePowerUp(playerId, matchedType);
        this.showPowerUpEffect(playerId, matchedType);
      } else {
        console.log('No matching type found for typeId:', typeId); // DEBUG
      }
    }
  });
},

  isColliding: function(rect1, rect2) {
    return !(rect1.right < rect2.left || 
             rect1.left > rect2.right || 
             rect1.bottom < rect2.top || 
             rect1.top > rect2.bottom);
  },

  activatePowerUp: function(playerId, type) {
    this.activePowerUps[playerId] = {
      type: type,
      startTime: Date.now(),
      duration: type.duration
    };

    switch(type.effect) {
      case 'speedBoost':
        this.applySpeedBoost(playerId);
        break;
      case 'slowOpponents':
        this.slowOpponents(playerId);
        break;
      case 'instantForward':
        this.instantForward(playerId);
        break;
      case 'shield':
        this.activateShield(playerId);
        break;
    }

    // Remove power-up after duration
    setTimeout(() => {
      delete this.activePowerUps[playerId];
      this.removePowerUpEffects(playerId);
    }, type.duration);
  },

playPowerUpSound: function(effectType) {
  console.log('playPowerUpSound called with:', effectType); // DEBUG
  
  if (!audioCtx) {
    console.log('No audioCtx available'); // DEBUG
    return;
  }
  
  console.log('AudioCtx state:', audioCtx.state); // DEBUG
  
  try {
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    let frequency = 500;
    switch(effectType) {
      case 'speedBoost': frequency = 800; break;
      case 'slowOpponents': frequency = 200; break;
      case 'shield': frequency = 600; break;
      case 'instantForward': frequency = 1000; break;
    }
    
    console.log('Playing frequency:', frequency); // DEBUG
    
    oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    oscillator.type = 'sine';
    
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.2);
    
    console.log('Power-up sound should have played'); // DEBUG
  } catch(e) {
    console.warn("Power-up sound failed:", e);
  }
},

removePowerUpWithEffect: function(powerUp) {
  console.log('Removing power-up with effect'); // Debug log
  
  // Immediately hide the power-up to prevent multiple collisions
  powerUp.style.pointerEvents = 'none';
  powerUp.style.opacity = '0.5';
  
  // Add collection animation
  powerUp.style.animation = 'powerUpCollect 0.3s ease-out forwards';
  
  // Remove after animation
  setTimeout(() => {
    if (powerUp && powerUp.parentElement) {
      powerUp.remove();
      console.log('Power-up removed from DOM'); // Debug log
    }
  }, 300);
},

  applySpeedBoost: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('speed-boost');
      // Server will handle actual speed increase through normal tap mechanics
    }
  },

  slowOpponents: function(playerId) {
    Object.keys(gameState.players).forEach(pid => {
      if (pid != playerId) {
        const runner = document.getElementById('runner' + pid);
        if (runner) runner.classList.add('slowed');
      }
    });
    
    setTimeout(() => {
      document.querySelectorAll('.runner.slowed').forEach(r => r.classList.remove('slowed'));
    }, 2000);
  },

  instantForward: function(playerId) {
    // Emit multiple quick taps for instant forward movement
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      }, i * 50);
    }
  },

  activateShield: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('shielded');
    }
  },

  removePowerUpEffects: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.remove('speed-boost', 'shielded');
    }
  },

  showPowerUpEffect: function(playerId, type) {
    const runner = document.getElementById('runner' + playerId);
    if (!runner) return;

    const effect = document.createElement('div');
    effect.className = 'power-up-text';
    effect.textContent = type.name;
    effect.style.cssText = `
      position: absolute;
      top: -30px;
      left: 50%;
      transform: translateX(-50%);
      color: ${type.color};
      font-weight: bold;
      font-size: 12px;
      animation: powerUpText 2s ease-out forwards;
      z-index: 100;
      text-shadow: 1px 1px 0 #000;
    `;
    
    runner.appendChild(effect);
    setTimeout(() => effect.remove(), 2000);

    // Add kanji effects AFTER the existing effect code
    if (type.effect === 'speedBoost' && typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('speed', playerId);
    } else if (type.effect === 'instantForward' && typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('power', playerId);
    }
  }
};

/* ------------------------------
   DYNAMIC TRACK ELEMENTS
------------------------------ */
var trackElements = {
  obstacles: [],
  speedZones: [],
  
  createObstacle: function(type, x, lane) {
    const obstacle = document.createElement('div');
    obstacle.className = 'track-obstacle ' + type;
    obstacle.style.left = x + 'px';
    
    const laneHeight = 80; // approximate lane height
    obstacle.style.top = (lane * laneHeight + laneHeight/2 - 16) + 'px';
    
    switch(type) {
      case 'chopsticks':
        obstacle.textContent = '🥢';
        obstacle.style.cssText += `
          width: 32px;
          height: 32px;
          font-size: 24px;
          animation: chopstickSway 1s ease-in-out infinite;
        `;
        break;
      case 'soy-spill':
        obstacle.textContent = '🌊';
        obstacle.style.cssText += `
          width: 60px;
          height: 20px;
          background: rgba(139, 69, 19, 0.6);
          border-radius: 10px;
          font-size: 16px;
        `;
        break;
    }
    
    const track = document.getElementById('track');
    if (track) track.appendChild(obstacle);
    
    this.obstacles.push({
      element: obstacle,
      type: type,
      x: x,
      lane: lane
    });
  },

  createSpeedZone: function(x, width, lane) {
    const zone = document.createElement('div');
    zone.className = 'speed-zone';
    zone.style.cssText = `
      position: absolute;
      left: ${x}px;
      top: ${lane * 80 + 10}px;
      width: ${width}px;
      height: 60px;
      background: linear-gradient(90deg, 
        rgba(0, 255, 136, 0.3), 
        rgba(0, 255, 136, 0.6), 
        rgba(0, 255, 136, 0.3));
      border: 2px dashed #00FF88;
      animation: speedZonePulse 1s ease-in-out infinite;
      z-index: 1;
    `;
    
    const track = document.getElementById('track');
    if (track) track.appendChild(zone);
    
    this.speedZones.push({
      element: zone,
      x: x,
      width: width,
      lane: lane
    });
  },

  spawnRandomElements: function() {
    if (!gameState.raceStarted || gameState.raceFinished) return;
    
    // Remove chopsticks - only spawn soy spills now
    if (Math.random() < 0.15) {  // Reduced frequency since only one obstacle type
      const x = Math.random() * (gameState.trackWidth - 200) + 100;
      const lane = Math.floor(Math.random() * 4);
      this.createObstacle('soy-spill', x, lane);  // Always soy-spill
    }
    
    // Keep speed zones as they are
    if (Math.random() < 0.15) {
      const x = Math.random() * (gameState.trackWidth - 300) + 150;
      const width = 80 + Math.random() * 60;
      const lane = Math.floor(Math.random() * 4);
      this.createSpeedZone(x, width, lane);
    }
  },

  checkCollisions: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (!runner) return;
    
    const runnerRect = runner.getBoundingClientRect();
    
    // Check speed zones
    this.speedZones.forEach(zone => {
      const zoneRect = zone.element.getBoundingClientRect();
      if (powerUpSystem.isColliding(runnerRect, zoneRect)) {
        this.triggerSpeedZone(playerId);
        this.showSpeedZoneEffect(runner);
      }
    });
    
    // Check obstacles
    this.obstacles.forEach(obstacle => {
      const obstacleRect = obstacle.element.getBoundingClientRect();
      if (powerUpSystem.isColliding(runnerRect, obstacleRect)) {
        this.triggerObstacle(playerId, obstacle.type);
      }
    });
  },

  triggerSpeedZone: function(playerId) {
    // Emit extra movement for speed boost
    socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
  },

  triggerObstacle: function(playerId, type) {
    switch(type) {
      case 'soy-spill':
        // Slow down effect
        const runner = document.getElementById('runner' + playerId);
        if (runner) {
          runner.classList.add('slowed');
          // FIXED: Check if kanjiEffects exists before calling
          if (typeof kanjiEffects !== 'undefined') {
            kanjiEffects.showKanji('slow', playerId);
          }
          setTimeout(() => runner.classList.remove('slowed'), 1500);
        }
        break;
    }
  },

  showSpeedZoneEffect: function(runner) {
    const effect = document.createElement('div');
    effect.textContent = 'WASABI BOOST!';
    effect.style.cssText = `
      position: absolute;
      top: -25px;
      left: 50%;
      transform: translateX(-50%);
      color: #00FF88;
      font-weight: bold;
      font-size: 10px;
      animation: speedBoostText 1s ease-out forwards;
      z-index: 100;
    `;
    
    runner.appendChild(effect);
    setTimeout(() => effect.remove(), 1000);
    
    // FIXED: Get playerId properly AND check if kanjiEffects exists
    const playerId = runner.id.replace('runner', '');
    if (playerId && typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('boost', playerId);
    }
  },

  clearElements: function() {
    document.querySelectorAll('.track-obstacle, .speed-zone, .power-up').forEach(el => el.remove());
    this.obstacles = [];
    this.speedZones = [];
  }
};

/* ------------------------------
   TOKYO ATMOSPHERE EFFECTS
------------------------------ */
var tokyoAtmosphere = {
  cherryBlossoms: [],
  
  startCherryBlossoms: function() {
    setInterval(() => {
      if (gameState.raceStarted && !gameState.raceFinished) {
        this.createCherryBlossom();
      }
    }, 2500);
  },

  createCherryBlossom: function() {
    // Use the full viewport instead of just the track container
    const blossom = document.createElement('div');
    blossom.className = 'cherry-blossom';
    blossom.textContent = '🌸';
    blossom.style.cssText = `
      position: fixed;
      left: ${Math.random() * window.innerWidth}px;
      top: -20px;
      font-size: ${12 + Math.random() * 8}px;
      z-index: 5;
      pointer-events: none;
      animation: cherryFallFullScreen ${4 + Math.random() * 3}s linear forwards;
    `;
    
    // Append to body instead of track container
    document.body.appendChild(blossom);
    
    setTimeout(() => blossom.remove(), 7000);
  },

  addTokyoSounds: function() {
    // Add these to your sound system
    const tokyoSounds = {
      crowd_cheer: new Audio("sounds/tokyo_crowd.wav"),
      train_pass: new Audio("sounds/subway_train.wav"),
      ganbatte: new Audio("sounds/ganbatte_cheer.wav")
    };
    
    Object.keys(tokyoSounds).forEach(key => {
      tokyoSounds[key].volume = 0.3;
      sounds.sfx[key] = tokyoSounds[key];
    });
    
    // Play crowd cheers randomly during race
    if (gameState.raceStarted && !gameState.raceFinished) {
      if (Math.random() < 0.1) {
        try {
          tokyoSounds.crowd_cheer.currentTime = 0;
          tokyoSounds.crowd_cheer.play().catch(() => {});
        } catch(e) {}
      }
    }
  },

  showPositionAnnouncement: function(playerId, position) {
    const player = gameState.players[playerId];
    if (!player) return;
    
    const announcement = document.createElement('div');
    announcement.className = 'position-announcement';
    announcement.innerHTML = `
      <span style="color: #FFD700;">${player.name.toUpperCase()}</span>
      <br>
      <span style="color: #FF3366;">${position === 1 ? 'TAKES THE LEAD!' : 'IN POSITION ' + position}</span>
    `;
    announcement.style.cssText = `
      position: fixed;
      top: 20%;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 10px 20px;
      border-radius: 10px;
      font-family: 'Press Start 2P', monospace;
      font-size: 12px;
      text-align: center;
      z-index: 9999;
      animation: announceSlide 3s ease-out forwards;
    `;
    
    document.body.appendChild(announcement);
    setTimeout(() => announcement.remove(), 3000);
  }
};

/* Continue with the rest of your game.js code... */

/* ------------------------------
   2) GRAPHICS / SPRITES
------------------------------ */
var gameGraphics = {
  characters: {
    1: { frames: [], loaded: false }, // Tamago
    2: { frames: [], loaded: false }, // Salmon
    3: { frames: [], loaded: false }, // Maki
    4: { frames: [], loaded: false }  // Maguro
  },

  
  // ADD THIS NEW METHOD HERE:
  preloadImages: function(playerId) {
    var character = this.characters[playerId];
    if (!character || !character.frames) return;
    
    character.frames.forEach(function(frameUrl) {
      var img = new Image();
      img.src = frameUrl;
    });
  },

  // UPDATE THIS EXISTING METHOD:
  loadCharacterFrames: function(characterId, frameUrls) {
    if (!this.characters[characterId]) return false;
    this.characters[characterId].frames = frameUrls.slice();
    this.characters[characterId].loaded = true;
    
    // ADD THIS LINE:
    this.preloadImages(characterId);
    
    this.updateRunnerSprite(characterId);
    return true;
  },
  // Tamago
  loadCharacter1Frames: function() {
    return this.loadCharacterFrames(1, [
      "images/tamago_nigri_1.png",
      "images/tamago_nigri_2.png",
      "images/tamago_nigri_3.png",
      "images/tamago_nigri_4.png"
    ]);
  },

  // Salmon
  loadCharacter2Frames: function() {
    return this.loadCharacterFrames(2, [
      "images/salmon_nigiri_1.png",
      "images/salmon_nigiri_2.png",
      "images/salmon_nigiri_3.png",
      "images/salmon_nigiri_4.png"
    ]);
  },

  // Maki
  loadCharacter3Frames: function() {
    return this.loadCharacterFrames(3, [
      "images/maki_roll_1.png",
      "images/maki_roll_2.png",
      "images/maki_roll_3.png",
      "images/maki_roll_4.png"
    ]);
  },

  // Maguro (Tuna)
  loadCharacter4Frames: function() {
    return this.loadCharacterFrames(4, [
      "images/tuna_sushi_1.png",
      "images/tuna_sushi_2.png",
      "images/tuna_sushi_3.png",
      "images/tuna_sushi_4.png"
    ]);
  },

  loadAllSushiCharacters: function() {
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
   3) CONFETTI / VISUAL EFFECTS
------------------------------ */
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
    tape.className = 'confetti-tape';
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

/* ------------------------------
   4) WEB AUDIO SYSTEM
------------------------------ */
let audioCtx;
let tapBuffer = null;

async function initWebAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!tapBuffer) {
      const response = await fetch("sounds/button_press.wav");
      const arrayBuffer = await response.arrayBuffer();
      tapBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      console.log("Tap sound loaded successfully");
    }
  } catch (error) {
    console.warn("Web Audio initialization failed:", error);
    // Fall back to HTML audio only
  }
}

function playTapWeb() {
  if (!tapBuffer || !audioCtx) return;
  try {
    const source = audioCtx.createBufferSource();
    source.buffer = tapBuffer;
    source.connect(audioCtx.destination);
    source.start(0);
  } catch (error) {
    console.warn("Web Audio playback failed:", error);
  }
}

/* ------------------------------
   5) SOUND SYSTEM (HTML AUDIO FALLBACK)
------------------------------ */
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
    victory:   pickFormat("sounds/chiptune_victory_jingle")
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
    if (tapBuffer && audioCtx) {
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
   6) CAMERA / PARALLAX
------------------------------ */
var cameraState = {
  cameraOffset: 0
};

/* ------------------------------
   7) FINISH LINE STRIPE
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
  var finishLineOffset = isMobile ? 150 : 200;  // Same values as checkFinish
  var trackWidth = track.offsetWidth || gameState.trackWidth || 1500;
  var startPadding = 20;
  var finishX = trackWidth - finishLineOffset - startPadding;
  fl.style.left = (finishX > 0 ? finishX : 0) + 'px';
}

/* ------------------------------
   8) SCROLL LOCK
------------------------------ */
function lockScroll(shouldLock) {
  document.body.classList.toggle('no-scroll', !!shouldLock);
}

/* ------------------------------
   9) UI RESET HELPER
------------------------------ */
function resetAllUIElements() {
  // Hide race elements
  var elements = [
    { id: 'statusBar', action: el => el.classList.remove('active') },
    { id: 'grandstand', action: el => el.classList.remove('active') },
    { id: 'mobileControls', action: el => el.classList.remove('active') },
    { id: 'results', action: el => { el.classList.remove('active'); el.style.display = 'none'; } },
    { id: 'countdown', action: el => el.style.display = 'none' },
    { id: 'timer', action: el => el.textContent = '00.000' }
  ];

  elements.forEach(({ id, action }) => {
    var el = document.getElementById(id);
    if (el) action(el);
  });

  // Reset track
  var track = document.getElementById('track');
  if (track) {
    track.classList.remove('active');
    track.style.display = 'none';
    track.style.transform = 'translateX(0px)';
    track.innerHTML = ''; // Clear old elements
  }

  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active');
    container.style.display = 'none';
  }

  // Reset runners
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

  // Re-lock scroll for lobby
  lockScroll(true);
  
  // Rebuild track structure for next game
  ensureFinishLine();
  setupLanes();
}

/* ------------------------------
   10) INITIALIZE
------------------------------ */
function initGame() {
  // user interaction primes audio on mobile
  document.addEventListener('click', function(){ initSounds(); initWebAudio(); }, { once: true });
  document.addEventListener('touchstart', function(){ initSounds(); initWebAudio(); }, { once: true });

  // load sprites
  gameGraphics.loadAllSushiCharacters();

  function initEnhancedFeatures() {
    // Start Tokyo atmosphere effects
    tokyoAtmosphere.startCherryBlossoms();
    console.log('Enhanced Sushi Sprint features initialized!');
  }

  initEnhancedFeatures();

  if (eventListenersSetup) return;
  eventListenersSetup = true;

  // Set track width (longer on desktop)
  var raceLengthPx = isMobileDevice() ? 2500 : 4000;
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
    container.classList.remove('active');
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

  // Hide loading, show lobby, lock scroll
  var loading = document.getElementById('loadingScreen');
  if (loading) {
    loading.style.opacity = '0';
    setTimeout(function(){ loading.style.display = 'none'; }, 400);
  }
  var lobby = document.getElementById('lobby');
  if (lobby) lobby.style.display = 'block';
  lockScroll(true);

  // Resume lobby music
  // Music setup - only try to play after user interaction
  var bg = document.getElementById('bgMusic');
  if (bg) {
    bg.volume = 0.35;
    bg.dataset.autoplay = '1';
    
    // Don't try to play immediately - wait for user interaction
    document.addEventListener('click', function() {
      if (bg.paused) {
        bg.play().catch(err => console.log('Music play failed:', err));
      }
    }, { once: true });
    
    document.addEventListener('touchstart', function() {
      if (bg.paused) {
        bg.play().catch(err => console.log('Music play failed:', err));
      }
    }, { once: true });
  }

  // auto-assign this socket to a waiting room so it receives roster updates
  if (!gameState.roomId) socket.emit('quickRace');
}

/* ------------------------------
   11) SOCKET EVENTS
------------------------------ */
socket.on('connect', function(){
  console.log('Connected to server');
});

socket.on('disconnect', function(){
  console.log('Disconnected from server');
});

// Handle reset starting notification
socket.on('resetStarting', function() {
  console.log("Reset starting - clearing local state");
  
  // Immediately stop all ongoing processes
  gameState.isResetting = true;
  gameState.countdownActive = false;
  gameLoopRunning = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Clear all animations immediately
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }
});

// Assigned to a waiting room (global lobby)
socket.on('roomAssigned', function (data) {
  if (!data) return;
  gameState.roomId = data.roomId;
  console.log('Assigned to room:', data.roomId);
});

// Roster update
socket.on('playerJoined', function (data) {
  if (gameState.isResetting) return;

  gameState.players   = (data && data.players)   ? data.players   : {};
  gameState.positions = (data && data.positions) ? data.positions : {};
  gameState.speeds    = (data && data.speeds)    ? data.speeds    : {};
  gameState.hostSocketId = data.hostSocketId;

  setupLanes();

  // Only rebuild mobile controls if *you* are one of the players
  if (Object.values(gameState.players).some(p => p.socketId === socket.id)) {
    setupMobileControls();
  }

  applySlotAvailability();

  // Update lobby roster UI
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

      // Assign sushi avatar based on player name
      var upper = player.name.toUpperCase();
      if (upper.includes('TAMAGO')) {
        avatar.src = 'images/tamago_nigri_1.png';
      } else if (upper.includes('SALMON')) {
        avatar.src = 'images/salmon_nigiri_1.png';
      } else if (upper.includes('MAKI')) {
        avatar.src = 'images/maki_roll_1.png';
      } else if (upper.includes('MAGURO')) {
        avatar.src = 'images/tuna_sushi_1.png';
      } else {
        // fallback if name doesn't match
        avatar.src = 'images/maki_roll_1.png';
      }

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

  // Start button logic
  var startBtn = document.getElementById('startBtn');
  var playerCount = Object.keys(gameState.players).length;
  var isHost = (data && data.hostSocketId) ? (socket.id === data.hostSocketId) : false;

  if (startBtn) {
    if (isHost && playerCount >= 2 && playerCount < 4) {
      startBtn.style.display = 'block';
      if (playerCount === 2) {
        startBtn.textContent = "Start (2 Players)";
      } else if (playerCount === 3) {
        startBtn.textContent = "Start (3 Players)";
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

  if (results) {
    results.classList.remove('active');
    results.style.display = 'none';
  }

  if (track) {
    track.style.display = 'block';
    track.classList.add('active');
  }

  if (sounds.playGo) sounds.playGo();

  var bg = document.getElementById('bgMusic');
  if (bg && !bg.paused) bg.pause();

  cameraState.cameraOffset = 0;
  gameState.raceStarted = true;
  gameState.raceFinished = false;
  gameState.finishTimes = {};

  if (data && data.positions) gameState.positions = data.positions;
  if (data && data.speeds)    gameState.speeds    = data.speeds;

  var lobby = document.getElementById('lobby');
  var statusBar = document.getElementById('statusBar');
  var container = document.querySelector('.track-container');
  var mobileControls = document.getElementById('mobileControls');
  var grandstand = document.getElementById('grandstand');

  if (lobby) lobby.style.display = 'none';
  if (statusBar) statusBar.classList.add('active');
  if (container) {
    container.style.display = 'block';
    container.classList.add('active');
  }
  if (mobileControls) {
    mobileControls.classList.add('active');
    setupMobileControls();
  }
  if (grandstand) grandstand.classList.add('active');

  ensureFinishLine();
  setupLanes();
  startCountdown();
  lockScroll(false);

  console.log('Race starting...');
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

// Animation sync from server
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

// Updated roomReset handler
socket.on('roomReset', function(data) {
  console.log("Room reset confirmed by server", data);
  
  // Complete the reset process
  gameState.isResetting = false;
  gameState.roomId = null; // Force new room assignment
  gameState.players = {};
  gameState.positions = {};
  gameState.speeds = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.finishTimes = {};
  playerStates = {};

  // Reset all UI elements
  resetAllUIElements();
  
  // Re-enable join button
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Game';
  }

  // Hide start button
  var startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.style.display = 'none';

  // Clear player list
  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '';
  
  var counterEl = document.getElementById('playerCounter');
  if (counterEl) counterEl.textContent = 'Players joined: 0/4';

  // Show lobby
  var lobby = document.getElementById('lobby');
  if (lobby) lobby.style.display = 'block';
  
  console.log("Reset complete - ready for new game");
});

/* ------------------------------
   12) LAYOUT / SETUP HELPERS
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
   13) MOBILE CONTROLS
------------------------------ */
function setupMobileControls() {
  var controlLayout = document.getElementById('controlLayout');
  if (!controlLayout) return;

  controlLayout.innerHTML = '';

  // Find my players
  var myPlayers = [];
  for (var k in gameState.players) {
    var p = gameState.players[k];
    if (p && p.socketId === socket.id) myPlayers.push(p);
  }
  if (myPlayers.length === 0) return;

  myPlayers.forEach(function(player){
    var wrapper = document.createElement('div');
    wrapper.className = 'player-touch-controls player' + player.id + ' dual';
    wrapper.style.marginBottom = "20px";

    wrapper.innerHTML = `
      <div class="control-player-label" style="margin-bottom:10px;">
        ${(player.name || ('Runner ' + player.id)).toUpperCase()}
      </div>
      <div class="dual-buttons">
        <button class="touch-btn" data-player="${player.id}" data-side="L">L</button>
        <button class="touch-btn" data-player="${player.id}" data-side="R">R</button>
      </div>`;
    controlLayout.appendChild(wrapper);
  });

  // Hook up press/release
  var btns = controlLayout.querySelectorAll('.touch-btn');
  btns.forEach(function(btn){
    if (btn._bound) return;

    var pid = parseInt(btn.getAttribute('data-player'), 10);
    var press = function(e){ tapPress(e, pid, btn); };
    var release = function(e){ tapRelease(e, pid, btn); };

    btn.addEventListener('touchstart', press, { passive:false });
    btn.addEventListener('touchend', release, { passive:false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);

    btn._bound = true;
  });
}

function tapPress(e, playerId, btn) {
  e.preventDefault(); 
  e.stopPropagation();
  
  if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) return;

  btn.classList.add('pressed'); // visually pressed

  if (!playerStates[playerId]) playerStates[playerId] = {};
  playerStates[playerId].lastTap = Date.now();

  startRunnerAnimation(playerId);
  socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });

  // Add this line to spawn dust trails:
  spawnDust(playerId);

  // Play tap sound + vibration
  if (sounds.initialized) sounds.playTap();
  if (navigator.vibrate) navigator.vibrate(10);
}

function tapRelease(e, playerId, btn) {
  e.preventDefault();
  e.stopPropagation();

  const targetBtn = btn || (e.target.closest ? e.target.closest('.touch-btn') : null);
  if (targetBtn) {
    targetBtn.classList.remove('pressed');
    targetBtn.classList.remove('active');
  }

  const runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  clearTimeout(runner._stopTimer);
  runner._stopTimer = setTimeout(() => {
    stopRunnerAnimation(playerId);
  }, 200);
}

/* ------------------------------
   14) ANIMATION CONTROL
------------------------------ */
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
  // Add the runner's height to move dust to the bottom (feet)
  dust.style.top = (runner.offsetTop + runner.offsetHeight - 17) + 'px';
  runner.parentElement.appendChild(dust);
  setTimeout(function(){ dust.remove(); }, 420);
}

/* ------------------------------
   15) COUNTDOWN / TIMER / GAMELOOP
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
      // FIXED: Check if kanjiEffects exists
      if (typeof kanjiEffects !== 'undefined') {
        kanjiEffects.showKanji('start'); // Global kanji, no playerId
      }
      launchTickerTape();
    } else {
      clearInterval(interval);
      countdownEl.style.display = 'none';
      gameState.countdownActive = false;
      gameState.startTime = Date.now();
      startTimer();
      startGameLoop();
      console.log('Race timer started');
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
  
  // ADD THIS: Spawn new elements periodically
  if (Math.random() < 0.1) {
    if (typeof powerUpSystem !== 'undefined') {
      powerUpSystem.spawnRandomPowerUps();
    }
    if (typeof trackElements !== 'undefined') {
      trackElements.spawnRandomElements();
    }
  }
  
  for (var pid in gameState.players) checkFinish(pid);
  requestAnimationFrame(gameLoop);
}

/* ------------------------------
   16) CORE UPDATE + CAMERA + PARALLAX
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
// Camera follow: each player follows their own character
var myPlayerId = null;
for (var pid in gameState.players) {
  if (gameState.players[pid].socketId === socket.id) {
    myPlayerId = pid;
    break;
  }
}

if (myPlayerId) {
  var myRunner = document.getElementById('runner' + myPlayerId);
  if (myRunner) {
    var screenOffset = container.offsetWidth * 0.3;
    var currentRunnerX = myRunner.offsetLeft;
    var newOffset = Math.max(0, currentRunnerX - screenOffset);
    cameraState.cameraOffset = Math.min(newOffset, gameState.trackWidth - container.offsetWidth);
  }
}
  
  // Apply transforms
  track.style.transform = 'translateX(-' + cameraState.cameraOffset + 'px)';
  
  // Parallax: background scroll (seamless)
  if (grandstand) {
    var parallaxOffset = cameraState.cameraOffset * 0.5;
    grandstand.style.backgroundPositionX = '-' + parallaxOffset + 'px';
  }

  // ADD THESE ENHANCED COLLISION CHECKS:
  Object.keys(gameState.players).forEach(function(playerId) {
    if (typeof powerUpSystem !== 'undefined') {
      powerUpSystem.checkCollisions(playerId);
    }
    if (typeof trackElements !== 'undefined') {
      trackElements.checkCollisions(playerId);
    }
  });
}

/* ------------------------------
   17) FINISH & RESULTS
------------------------------ */
function checkFinish(playerId) {
  if (!playerStates[playerId] || gameState.finishTimes[playerId] || gameState.isResetting) return;

  var trackElement = document.getElementById('track');
  if (trackElement) gameState.trackWidth = trackElement.offsetWidth;

  var isMobile = window.innerWidth <= 480;
  // INCREASE THESE VALUES to make race longer:
  var finishLineOffset = isMobile ? 80 : 100;  // Was 50/80, now 150/200
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
  console.log('Race finished - showing results.');
}

function showResults() {
  var mobileControls = document.getElementById('mobileControls');
  var track = document.getElementById('track');
  var results = document.getElementById('results');
  var statusBar = document.getElementById('statusBar');
  var grandstand = document.getElementById('grandstand');
  var container = document.querySelector('.track-container');

  // Hide all race UI
  if (mobileControls) mobileControls.classList.remove('active');
  if (statusBar) statusBar.classList.remove('active');
  if (grandstand) grandstand.classList.remove('active');

  if (track)   { track.classList.remove('active');   track.style.display = 'none'; }
  if (container){container.classList.remove('active');container.style.display = 'none'; }

  // Show results
  if (results) {
    results.classList.add('active');
    results.style.display = '';
  }

  // Scroll to top so results are visible
  var screen = document.getElementById('screen');
  if (screen) screen.scrollTop = 0;
  window.scrollTo(0, 0);

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
    if (sounds.initialized) sounds.playVictory();
    // FIXED: Check if kanjiEffects exists
    if (typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('victory'); // Global kanji
    }
  }
}

/* ------------------------------
   18) RESET
------------------------------ */
function resetGame() {
  if (gameState.isResetting) return;
  trackElements.clearElements();
  powerUpSystem.activePowerUps = {};
  document.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect').forEach(el => el.remove());
  console.log("Initiating game reset...");
  socket.emit('resetRoom', gameState.roomId);
}

/* ------------------------------
   19) LOBBY HELPERS
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
   20) JOIN ROOM
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
}

/* ------------------------------
   21) UTILITIES & INIT HOOKS
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