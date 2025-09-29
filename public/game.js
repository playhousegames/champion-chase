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

// SIMULTANEOUS PRESS DEFENSE SYSTEM
// Replace the defense system with this version

var defenseSystem = {
  activeAttacks: {},
  blockWindows: {},
  pressStates: {}, // Track which buttons are currently pressed
  
initiateAttack: function(targetPlayerId, attackType, duration) {
  console.log(`Attack ${attackType} incoming for player ${targetPlayerId}`);
  
  const targetPlayer = gameState.players[targetPlayerId];
  
  // Don't show warning for bots
  if (targetPlayer && targetPlayer.isBot) {
    // Just apply the effect directly to bots without showing UI
    setTimeout(() => {
      if (this.blockWindows[targetPlayerId] && !this.blockWindows[targetPlayerId].blocked) {
        this.applyAttackEffect(targetPlayerId, attackType, duration);
        delete this.blockWindows[targetPlayerId];
      }
    }, 1300);
    return;
  }
  
  // Only show warning if this is the local player (not a bot, not other players)
  const isLocalPlayer = targetPlayer && targetPlayer.socketId === socket.id;
  
  if (isLocalPlayer) {
    this.showAttackWarning(targetPlayerId, attackType);
  }
  
  const blockWindowStart = Date.now() + 800;
  const blockWindowEnd = blockWindowStart + 500;
  
  this.blockWindows[targetPlayerId] = {
    start: blockWindowStart,
    end: blockWindowEnd,
    attackType: attackType,
    duration: duration,
    blocked: false
  };
  
  setTimeout(() => {
    if (this.blockWindows[targetPlayerId] && !this.blockWindows[targetPlayerId].blocked) {
      console.log(`Player ${targetPlayerId} failed to block!`);
      this.applyAttackEffect(targetPlayerId, attackType, duration);
      delete this.blockWindows[targetPlayerId];
    }
  }, 1300);
},
  
  // Track button press state
  registerPress: function(playerId, side) {
    if (!this.pressStates[playerId]) {
      this.pressStates[playerId] = { L: false, R: false, pressTime: {} };
    }
    
    const now = Date.now();
    this.pressStates[playerId][side] = true;
    this.pressStates[playerId].pressTime[side] = now;
    
    // Check if both are pressed within 100ms window
    this.checkSimultaneousPress(playerId, now);
  },
  
  registerRelease: function(playerId, side) {
    if (this.pressStates[playerId]) {
      this.pressStates[playerId][side] = false;
    }
  },
  
  checkSimultaneousPress: function(playerId, now) {
    const state = this.pressStates[playerId];
    if (!state) return;
    
    // Both buttons pressed?
    if (state.L && state.R) {
      const lTime = state.pressTime.L || 0;
      const rTime = state.pressTime.R || 0;
      const timeDiff = Math.abs(lTime - rTime);
      
      // Must press within 100ms of each other
      if (timeDiff <= 100) {
        this.attemptBlock(playerId, timeDiff);
      }
    }
  },
  
  attemptBlock: function(playerId, timeDiff) {
    const window = this.blockWindows[playerId];
    if (!window) {
      // No attack to block - wasted the simultaneous press
      this.showBlockFeedback(playerId, 'NO THREAT', '#666');
      return false;
    }
    
    const now = Date.now();
    
    // Check if within block window
    if (now >= window.start && now <= window.end) {
      const timing = now - window.start;
      const windowSize = window.end - window.start;
      const perfection = 1 - (timing / windowSize);
      
      // Also factor in how simultaneous the press was (0-100ms)
      const simultaneity = 1 - (timeDiff / 100);
      const totalScore = (perfection * 0.6) + (simultaneity * 0.4);
      
      window.blocked = true;
      
      if (totalScore > 0.8) {
        // PERFECT - both timing AND simultaneity
        this.showBlockFeedback(playerId, 'PERFECT!', '#FFD700');
        this.counterAttack(playerId, 7); // 7 taps
        if (sounds.initialized) this.playBlockSound('perfect');
      } else if (totalScore > 0.5) {
        // GOOD - decent block
        this.showBlockFeedback(playerId, 'BLOCKED!', '#00FF88');
        this.counterAttack(playerId, 3); // 3 taps
        if (sounds.initialized) this.playBlockSound('good');
      } else {
        // WEAK - barely blocked
        this.showBlockFeedback(playerId, 'WEAK BLOCK', '#88FF88');
        if (sounds.initialized) this.playBlockSound('weak');
      }
      
      delete this.blockWindows[playerId];
      return true;
      
    } else if (now < window.start) {
      this.showBlockFeedback(playerId, 'TOO EARLY', '#FF4444');
      return false;
    } else {
      this.showBlockFeedback(playerId, 'TOO LATE', '#FF4444');
      this.applyAttackEffect(playerId, window.attackType, window.duration);
      delete this.blockWindows[playerId];
      return false;
    }
  },
  
  showAttackWarning: function(playerId, attackType) {
    const warning = document.createElement('div');
    warning.className = 'defense-warning';
    warning.innerHTML = `
      <div class="warning-icon">⚠️</div>
      <div class="warning-text">PRESS BOTH!</div>
      <div class="warning-hands">👈 👉</div>
      <div class="warning-timer">
        <div class="timer-bar"></div>
      </div>
    `;
    warning.style.cssText = `
      position: fixed;
      top: 40%;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.95);
      border: 4px solid #FF3366;
      padding: 20px;
      border-radius: 10px;
      z-index: 9998;
      text-align: center;
      font-family: 'Press Start 2P', monospace;
      animation: warningPulse 0.3s ease-in-out infinite;
      box-shadow: 0 0 30px rgba(255, 51, 102, 0.6);
    `;
    
    document.body.appendChild(warning);
    
    const timerBar = warning.querySelector('.timer-bar');
    if (timerBar) {
      timerBar.style.cssText = `
        width: 100%;
        height: 8px;
        background: linear-gradient(90deg, #00FF88, #FFD700, #FF3366);
        animation: timerDrain 1.3s linear forwards;
      `;
    }
    
    setTimeout(() => warning.remove(), 1300);
  },
  
  showBlockFeedback: function(playerId, text, color) {
    const feedback = document.createElement('div');
    feedback.className = 'block-feedback';
    feedback.textContent = text;
    feedback.style.cssText = `
      position: fixed;
      top: 35%;
      left: 50%;
      transform: translateX(-50%);
      color: ${color};
      font-size: 2rem;
      font-family: 'Press Start 2P', monospace;
      text-shadow: 3px 3px 0 #000;
      z-index: 9999;
      animation: blockFeedbackPop 1s ease-out forwards;
      pointer-events: none;
    `;
    
    document.body.appendChild(feedback);
    setTimeout(() => feedback.remove(), 1000);
  },
  
  applyAttackEffect: function(playerId, attackType, duration) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('slowed');
      if (!playerStates[playerId]) playerStates[playerId] = {};
      playerStates[playerId].tapsBlocked = true;
    }
    
    setTimeout(() => {
      if (runner) runner.classList.remove('slowed');
      if (playerStates[playerId]) playerStates[playerId].tapsBlocked = false;
    }, duration);
  },
  
  counterAttack: function(playerId, tapCount) {
    for (let i = 0; i < tapCount; i++) {
      setTimeout(() => {
        socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      }, i * 50);
    }
    
    if (typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('power', playerId);
    }
  },

    playBlockSound: function(type) {
    if (!audioCtx) return;
    
    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      if (type === 'perfect') {
        oscillator.frequency.setValueAtTime(1400, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(2000, audioCtx.currentTime + 0.15);
      } else if (type === 'good') {
        oscillator.frequency.setValueAtTime(900, audioCtx.currentTime);
      } else {
        oscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
      }
      
      oscillator.type = 'square';
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
      
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.2);
    } catch(e) {}
  }
};

// UPDATED tapPress function - registers presses with defense system
function tapPress(e, playerId, btn) {
  e.preventDefault(); 
  e.stopPropagation();
  
  if (gameState.countdownActive) {
    console.log('Tapping blocked - countdown in progress');
    return;
  }
  
  // Check if taps blocked by attack
  if (playerStates[playerId] && playerStates[playerId].tapsBlocked) {
    console.log('Taps blocked by SOY_TRAP!');
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
    return;
  }
  
  if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) return;

  btn.classList.add('pressed');

  // Register press with defense system
  const side = btn.getAttribute('data-side');
  if (side && typeof defenseSystem !== 'undefined') {
    defenseSystem.registerPress(playerId, side);
  }

  if (!playerStates[playerId]) playerStates[playerId] = {};
  playerStates[playerId].lastTap = Date.now();

  // Normal movement
  var currentPos = gameState.positions[playerId] || 20;
  var predictedMovement = 8;
  var newPosition = currentPos + predictedMovement;
  
  gameState.positions[playerId] = newPosition;
  var runner = document.getElementById('runner' + playerId);
  if (runner) {
    runner.style.left = newPosition + 'px';
  }

  startRunnerAnimation(playerId);
  socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });

  spawnDust(playerId);
  if (sounds.initialized) sounds.playTap();
  if (navigator.vibrate) navigator.vibrate(10);
}

// UPDATED tapRelease function - registers releases
function tapRelease(e, playerId, btn) {
  e.preventDefault();
  e.stopPropagation();

  const targetBtn = btn || (e.target.closest ? e.target.closest('.touch-btn') : null);
  if (targetBtn) {
    targetBtn.classList.remove('pressed');
    targetBtn.classList.remove('active');
    
    // Register release with defense system
    const side = targetBtn.getAttribute('data-side');
    if (side && typeof defenseSystem !== 'undefined') {
      defenseSystem.registerRelease(playerId, side);
    }
  }

  const runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  clearTimeout(runner._stopTimer);
  runner._stopTimer = setTimeout(() => {
    stopRunnerAnimation(playerId);
  }, 200);
}

// Mobile controls stay the same - just L and R buttons (no center button needed)
function setupMobileControls() {
  var controlLayout = document.getElementById('controlLayout');
  if (!controlLayout) return;

  controlLayout.innerHTML = '';

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
// IMPROVED POWER-UP SYSTEM - Replace your existing powerUpSystem object

// REBALANCED POWER-UPS in your powerUpSystem object
var powerUpSystem = {
  types: {
    WASABI_RUSH: { 
      id: 'wasabi', 
      name: 'WASABI RUSH!', 
      color: '#00FF88', 
      icon: '🔥',
      duration: 3000,
      effect: 'speedBoost'
    },
    SOY_TRAP: { 
      id: 'soy', 
      name: 'SOY TRAP', 
      color: '#8B4513', 
      icon: '🍶',
      duration: 2000,
      effect: 'slowOpponents'
    },
    DASH_ROLL: {  // Renamed from TELEPORT_ROLL
      id: 'dash', 
      name: 'DASH!', 
      color: '#FF00FF', 
      icon: '⚡',
      duration: 500,
      effect: 'instantForward'
    },
    MEGA_BOOST: { 
      id: 'mega', 
      name: 'MEGA BOOST!', 
      color: '#FFD700', 
      icon: '⭐',
      duration: 4000,
      effect: 'megaBoost'
    }
  },

  activePowerUps: {},

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
      box-shadow: 0 0 10px ${type.color};
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
        
        let matchedType = null;
        for (const [key, type] of Object.entries(this.types)) {
          if (type.id === typeId) {
            matchedType = type;
            break;
          }
        }
        
        if (matchedType) {
          this.playPowerUpSound(matchedType.effect);
          this.createCollectionParticles(powerUpRect);
          this.removePowerUpWithEffect(powerUp);
          this.activatePowerUp(playerId, matchedType);
          this.showPowerUpEffect(playerId, matchedType);
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
      case 'megaBoost':
        this.applyMegaBoost(playerId);
        break;
    }

     // Crowd reacts to power-up
  if (typeof crowdSystem !== 'undefined') {
    crowdSystem.onPowerUp(playerId);
  }

    // Remove power-up after duration
    setTimeout(() => {
      delete this.activePowerUps[playerId];
      this.removePowerUpEffects(playerId);
    }, type.duration);
  },

  applySpeedBoost: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('speed-boost');
    }
    
    // Actually boost: send rapid taps
    let tapCount = 0;
    const boostInterval = setInterval(() => {
      if (tapCount >= 8 || !gameState.raceStarted || gameState.finishTimes[playerId]) {
        clearInterval(boostInterval);
        return;
      }
      socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      tapCount++;
    }, 350); // One tap every 350ms for 3 seconds = ~8 taps
  },

  applyMegaBoost: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('mega-boost');
    }
    
    // MEGA boost: more taps, faster
    let tapCount = 0;
    const boostInterval = setInterval(() => {
      if (tapCount >= 15 || !gameState.raceStarted || gameState.finishTimes[playerId]) {
        clearInterval(boostInterval);
        return;
      }
      socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      tapCount++;
    }, 250); // One tap every 250ms for 4 seconds = ~15 taps
  },

slowOpponents: function(playerId) {
  // If a bot collected this, don't attack human players
  const collector = gameState.players[playerId];
  if (collector && collector.isBot) {
    // Bots only slow down other bots, not humans
    Object.keys(gameState.players).forEach(pid => {
      if (pid != playerId) {
        const target = gameState.players[pid];
        if (target && target.isBot) {
          // Apply slow effect directly to other bots
          const runner = document.getElementById('runner' + pid);
          if (runner) {
            runner.classList.add('slowed');
            if (!playerStates[pid]) playerStates[pid] = {};
            playerStates[pid].tapsBlocked = true;
          }
          
          setTimeout(() => {
            if (runner) runner.classList.remove('slowed');
            if (playerStates[pid]) playerStates[pid].tapsBlocked = false;
          }, 2000);
        }
      }
    });
    return;
  }
  
  // Human player collected it - use defense system for all opponents
  Object.keys(gameState.players).forEach(pid => {
    if (pid != playerId) {
      if (typeof defenseSystem !== 'undefined') {
        defenseSystem.initiateAttack(pid, 'soy_trap', 2000);
      } else {
        // Fallback if defense system not loaded
        const runner = document.getElementById('runner' + pid);
        if (runner) {
          runner.classList.add('slowed');
          if (!playerStates[pid]) playerStates[pid] = {};
          playerStates[pid].tapsBlocked = true;
        }
        
        setTimeout(() => {
          if (runner) runner.classList.remove('slowed');
          if (playerStates[pid]) playerStates[pid].tapsBlocked = false;
        }, 2000);
      }
    }
  });
},

 instantForward: function(playerId) {
  // Reduced from 10 to 5 taps, still powerful but not game-breaking
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
    }, i * 50);
  }
    
    // Visual effect
    if (typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('power', playerId);
    }
  },

  removePowerUpEffects: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.remove('speed-boost', 'mega-boost', 'shielded');
    }
  },

showPowerUpEffect: function(playerId, type) {
  const player = gameState.players[playerId];
  
  // ONLY show for the human player (not bots, not other human players)
  if (!player) return;
  if (player.isBot) return;
  
  // Check if this is the local player
  const isLocalPlayer = player.socketId === socket.id;
  
  // If not the local player, don't show anything
  if (!isLocalPlayer) return;
  
  // Only show kanji for local player - ONCE
  if (isLocalPlayer && typeof kanjiEffects !== 'undefined') {
    // Determine kanji type based on power-up effect
    let kanjiType = null;
    if (type.effect === 'speedBoost' || type.effect === 'megaBoost') {
      kanjiType = 'speed';
    } else if (type.effect === 'instantForward') {
      kanjiType = 'power';
    } else if (type.effect === 'slowOpponents') {
      kanjiType = 'power';
    }
    
    // Show kanji ONCE with English name underneath
    if (kanjiType) {
      const char = kanjiEffects.characters[kanjiType];
      const kanji = document.createElement('div');
      kanji.className = 'kanji-effect';
      kanji.innerHTML = `
        <div class="kanji-main" style="font-size: 4rem; color: ${type.color}; text-shadow: 4px 4px 0 #000, -3px -3px 0 #000; margin-bottom: 8px; font-family: 'Noto Sans JP', serif;">${char.kanji}</div>
        <div class="kanji-meaning" style="font-size: 0.9rem; color: ${type.color}; font-family: 'Press Start 2P', monospace; text-shadow: 2px 2px 0 #000; letter-spacing: 2px;">${type.name}</div>
      `;
      
      // CENTER SCREEN positioning
      kanji.style.cssText = `
        position: fixed;
        top: 35%;
        left: 50%;
        transform: translateX(-50%);
        text-align: center;
        z-index: 9999;
        animation: kanjiGlobalPop 2.5s ease-out forwards;
        pointer-events: none;
      `;
      
      document.body.appendChild(kanji);
      
      // Clean up after animation
      setTimeout(() => {
        if (kanji && kanji.parentElement) {
          kanji.remove();
        }
      }, 2500);
    }
  }
},
  createCollectionParticles: function(rect) {
    // Create burst particles at collection point
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    for (let i = 0; i < 8; i++) {
      const particle = document.createElement('div');
      particle.className = 'power-up-particle';
      particle.style.left = centerX + 'px';
      particle.style.top = centerY + 'px';
      particle.style.backgroundColor = '#FFD700';
      
      const angle = (Math.PI * 2 * i) / 8;
      const distance = 50 + Math.random() * 30;
      particle.style.setProperty('--tx', Math.cos(angle) * distance + 'px');
      particle.style.setProperty('--ty', Math.sin(angle) * distance + 'px');
      
      document.body.appendChild(particle);
      setTimeout(() => particle.remove(), 800);
    }
  },

  playPowerUpSound: function(effectType) {
    if (!audioCtx) return;
    
    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      let frequency = 500;
      switch(effectType) {
        case 'speedBoost': frequency = 800; break;
        case 'megaBoost': frequency = 1000; break;
        case 'slowOpponents': frequency = 200; break;
        case 'instantForward': frequency = 1200; break;
      }
      
      oscillator.frequency.setValueAtTime(frequency, audioCtx.currentTime);
      oscillator.type = 'square';
      
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.3);
    } catch(e) {
      console.warn("Power-up sound failed:", e);
    }
  },

  removePowerUpWithEffect: function(powerUp) {
    powerUp.style.pointerEvents = 'none';
    powerUp.style.animation = 'powerUpCollect 0.3s ease-out forwards';
    
    setTimeout(() => {
      if (powerUp && powerUp.parentElement) {
        powerUp.remove();
      }
    }, 300);
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
  const player = gameState.players[playerId];
  
  // Check speed zones
  this.speedZones.forEach(zone => {
    const zoneRect = zone.element.getBoundingClientRect();
    if (powerUpSystem.isColliding(runnerRect, zoneRect)) {
      this.triggerSpeedZone(playerId);
      
      // Only show effect for local player, not bots or other players
      if (player && !player.isBot && player.socketId === socket.id) {
        this.showSpeedZoneEffect(runner);
      }
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
      const player = gameState.players[playerId];
      
      // Don't show effects for bots
      if (player && player.isBot) {
        // Just apply the effect without visuals
        if (runner) {
          runner.classList.add('slowed');
          setTimeout(() => runner.classList.remove('slowed'), 1500);
        }
        return;
      }
      
      // Only show kanji for local player
      const isLocalPlayer = player && player.socketId === socket.id;
      
      if (runner) {
        runner.classList.add('slowed');
        
        // Only show kanji for local player
        if (isLocalPlayer && typeof kanjiEffects !== 'undefined') {
          kanjiEffects.showKanji('slow', playerId);
        }
        
        setTimeout(() => runner.classList.remove('slowed'), 1500);
      }
      break;
  }
},

showSpeedZoneEffect: function(runner) {
  // Check if this is the local player's runner
  const playerId = runner.id.replace('runner', '');
  const player = gameState.players[playerId];
  
  // Don't show for bots
  if (player && player.isBot) return;
  
  // Only show for local player
  const isLocalPlayer = player && player.socketId === socket.id;
  if (!isLocalPlayer) return;
  
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
// In your gameGraphics object, REPLACE the existing loadCharacterFrames method:

loadCharacterFrames: function(characterId, frameUrls) {
  if (!this.characters[characterId]) return false;
  
  this.characters[characterId].frames = frameUrls.slice();
  this.characters[characterId].loaded = false; // Set to false initially
  
  // Preload all images and wait for them to load
  var loadedCount = 0;
  var totalImages = frameUrls.length;
  
  frameUrls.forEach(function(url) {
    var img = new Image();
    img.onload = function() {
      loadedCount++;
      console.log(`Loaded sprite ${loadedCount}/${totalImages}: ${url}`);
      
      // When all images are loaded, mark as ready and update sprite
      if (loadedCount === totalImages) {
        gameGraphics.characters[characterId].loaded = true;
        console.log(`Character ${characterId} fully loaded`);
        gameGraphics.updateRunnerSprite(characterId);
      }
    };
    img.onerror = function() {
      console.error(`Failed to load sprite: ${url}`);
      loadedCount++; // Still increment to prevent hanging
      if (loadedCount === totalImages) {
        gameGraphics.characters[characterId].loaded = true;
        gameGraphics.updateRunnerSprite(characterId);
      }
    };
    img.src = url;
  });
  
  return true;
},

// Remove the old preloadImages method if it's separate
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
  if (!runner) {
    console.log('No runner element for player', playerId);
    return;
  }

  var character = this.characters[playerId];
  if (!character || !character.loaded || character.frames.length === 0) {
    console.log('Character not ready for player', playerId, character);
    return;
  }

  runner.style.width = '32px';
  runner.style.height = '32px';
  runner.style.backgroundImage = 'url(' + character.frames[0] + ')';
  runner.style.backgroundSize = 'cover';
  runner.style.backgroundRepeat = 'no-repeat';
  runner.textContent = '';
  runner.innerHTML = '';
  runner.dataset.frames = JSON.stringify(character.frames);
  runner.dataset.currentFrame = '0';
  
  console.log('Sprite updated for player', playerId, 'frame:', character.frames[0]);
},

  // Advance to next frame (used while "running")
animateSprite: function(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner || !runner.dataset.frames) {
    console.log('Cannot animate player', playerId, 'no frames');
    return;
  }

  var frames = JSON.parse(runner.dataset.frames);
  var currentFrame = parseInt(runner.dataset.currentFrame || '0', 10);
  var nextFrame = (currentFrame + 1) % frames.length;

  console.log('Animating player', playerId, 'to frame', nextFrame, frames[nextFrame]);
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
/* =========================================================
   SOUND SYSTEM FIX - Key Changes:
   1. Better Web Audio initialization with mobile handling
   2. Robust fallback to HTML5 Audio
   3. Proper error handling and logging
   4. User interaction detection for autoplay restrictions
   ========================================================= */

// ---- WEB AUDIO SYSTEM (IMPROVED) ----
let audioCtx;
let tapBuffer = null;
let audioInitialized = false;

async function initWebAudio() {
  if (audioInitialized) return;
  
  try {
    console.log("Initializing Web Audio...");
    
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      console.log("AudioContext created, state:", audioCtx.state);
    }
    
    // Resume if suspended (critical for mobile)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
      console.log("AudioContext resumed, new state:", audioCtx.state);
    }
    
    if (!tapBuffer) {
      console.log("Loading tap sound buffer...");
      const response = await fetch("sounds/button_press.wav");
      if (!response.ok) {
        throw new Error(`Failed to fetch tap sound: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      tapBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      console.log("Tap sound loaded successfully");
    }
    
    audioInitialized = true;
    console.log("Web Audio fully initialized");
  } catch (error) {
    console.error("Web Audio initialization failed:", error);
    audioInitialized = false;
  }
}

function playTapWeb() {
  if (!tapBuffer || !audioCtx) {
    console.warn("Web Audio not ready");
    return;
  }
  
  try {
    // Resume context if needed (mobile browsers suspend it)
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => {
        playTapWebInternal();
      });
    } else {
      playTapWebInternal();
    }
  } catch (error) {
    console.error("Web Audio playback failed:", error);
  }
}

function playTapWebInternal() {
  try {
    const source = audioCtx.createBufferSource();
    const gainNode = audioCtx.createGain();
    
    source.buffer = tapBuffer;
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    gainNode.gain.value = 0.8;
    
    source.start(0);
  } catch (error) {
    console.error("playTapWebInternal error:", error);
  }
}

function playStartSound() {
  if (!audioCtx) {
    console.warn("AudioContext not available for start sound");
    return;
  }
  
  try {
    // Resume if suspended
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const oscillator1 = audioCtx.createOscillator();
    const oscillator2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator1.connect(gainNode);
    oscillator2.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator1.type = 'square';
    oscillator2.type = 'sawtooth';
    
    oscillator1.frequency.setValueAtTime(600, audioCtx.currentTime);
    oscillator1.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.3);
    
    oscillator2.frequency.setValueAtTime(800, audioCtx.currentTime);
    oscillator2.frequency.exponentialRampToValueAtTime(1600, audioCtx.currentTime + 0.3);
    
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.4, audioCtx.currentTime + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    
    oscillator1.start(audioCtx.currentTime);
    oscillator2.start(audioCtx.currentTime);
    oscillator1.stop(audioCtx.currentTime + 0.5);
    oscillator2.stop(audioCtx.currentTime + 0.5);
    
    console.log("Start sound played");
  } catch(e) {
    console.error("Start sound failed:", e);
  }
}

// ---- HTML5 AUDIO FALLBACK (IMPROVED) ----
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
  if (sounds.initialized) {
    console.log("Sounds already initialized");
    return;
  }

  console.log("Initializing HTML5 Audio sounds...");

  var files = {
    countdown: "sounds/countdown.wav",
    go:        "sounds/go.wav",
    tap:       "sounds/button_press.wav",
    finish:    "sounds/finish.wav",
    victory:   pickFormat("sounds/chiptune_victory_jingle")
  };

  Object.keys(files).forEach(function(k){
    try {
      var a = new Audio(files[k]);
      a.preload = 'auto';
      
      // Add load event listener
      a.addEventListener('canplaythrough', function() {
        console.log(`Sound ${k} loaded successfully`);
      });
      
      a.addEventListener('error', function(e) {
        console.error(`Error loading sound ${k}:`, e);
      });

      if (k === "victory") {
        a.volume = 0.7;
      }

      sounds.sfx[k] = a;
    } catch (error) {
      console.error(`Failed to create audio for ${k}:`, error);
    }
  });

  // Sound player functions with better error handling
  sounds.playCountdown = function(){ 
    try { 
      if (sounds.sfx.countdown) {
        sounds.sfx.countdown.currentTime = 0;
        sounds.sfx.countdown.volume = 0.6;
        const promise = sounds.sfx.countdown.play();
        if (promise) {
          promise.catch(err => console.warn('Countdown sound failed:', err));
        }
        console.log("Countdown sound played");
      } else {
        console.warn("Countdown sound not loaded");
      }
    } catch(e){ 
      console.error('Countdown sound error:', e);
    } 
  };

  sounds.playGo = function(){ 
    try { 
      if (sounds.sfx.go) {
        sounds.sfx.go.currentTime = 0;
        sounds.sfx.go.volume = 0.7;
        const promise = sounds.sfx.go.play();
        if (promise) {
          promise.catch(err => console.warn('Go sound failed:', err));
        }
        console.log("Go sound played");
      } else {
        console.warn("Go sound not loaded");
      }
    } catch(e){
      console.error('Go sound error:', e);
    } 
  };

  sounds.playTap = function() {
    // Try Web Audio first (lower latency)
    if (audioInitialized && tapBuffer && audioCtx) {
      playTapWeb();
    } else if (sounds.sfx.tap) {
      // Fallback to HTML5 Audio
      try {
        const clone = sounds.sfx.tap.cloneNode();
        clone.volume = 0.8;
        const promise = clone.play();
        if (promise) {
          promise.catch(err => console.warn('Tap sound failed:', err));
        }
      } catch(e) {
        console.error("Tap sound error:", e);
      }
    } else {
      console.warn("No tap sound available");
    }
  };

  sounds.playFinish = function() {
    if (!sounds.sfx.finish) {
      console.warn("Finish sound not loaded");
      return;
    }
    try {
      sounds.sfx.finish.currentTime = 0;
      const promise = sounds.sfx.finish.play();
      if (promise) {
        promise.catch(err => console.warn('Finish sound failed:', err));
      }
      console.log("Finish sound played");
    } catch (e) { 
      console.error('Finish sound error:', e); 
    }
  };

  sounds.playVictory = function() {
    if (!sounds.sfx.victory) {
      console.warn("Victory sound not loaded");
      return;
    }
    try {
      sounds.sfx.victory.currentTime = 0;
      const promise = sounds.sfx.victory.play();
      if (promise) {
        promise.catch(err => console.warn('Victory sound failed:', err));
      }
      console.log("Victory sound played");
    } catch (e) { 
      console.error("Victory sound error:", e); 
    }
  };

  sounds.initialized = true;
  console.log("HTML5 Audio sounds initialized");
}

// ---- INITIALIZATION (CRITICAL FOR MOBILE) ----
function setupAudioOnInteraction() {
  console.log("Setting up audio initialization on user interaction...");
  
  function initAllAudio() {
    console.log("User interaction detected - initializing audio...");
    initSounds();
    initWebAudio();
  }
  
  // Listen for various user interactions
  document.addEventListener('click', initAllAudio, { once: true });
  document.addEventListener('touchstart', initAllAudio, { once: true });
  document.addEventListener('touchend', initAllAudio, { once: true });
  
  // Also try on button clicks
  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.addEventListener('click', initAllAudio, { once: true });
  }
}

// Call this early
setupAudioOnInteraction();


/* =========================================================
   CROWD ATMOSPHERE SYSTEM
   Features:
   - Ambient crowd murmur (continuous background)
   - Reactive cheering (responds to race events)
   - Position-based excitement (louder when close finishes)
   - Victory roar (massive cheer for winner)
   - Individual cheers for overtakes and power-ups
   ========================================================= */

var crowdSystem = {
  ambientSound: null,
  cheerSounds: [],
  isInitialized: false,
  currentExcitementLevel: 0,
  
  // Initialize crowd audio system
  init: function() {
    if (this.isInitialized) return;
    
    console.log("Initializing crowd atmosphere system...");
    
    // Create ambient crowd murmur (looping background)
    this.ambientSound = new Audio("sounds/crowd_ambient.mp3");
    this.ambientSound.loop = true;
    this.ambientSound.volume = 0;
    this.ambientSound.preload = 'auto';
    
    // Create multiple cheer sounds for variety
    const cheerFiles = [
      "sounds/crowd_cheer_1.mp3",
      "sounds/crowd_cheer_2.mp3", 
      "sounds/crowd_cheer_3.mp3"
    ];
    
    cheerFiles.forEach(file => {
      const audio = new Audio(file);
      audio.preload = 'auto';
      audio.volume = 0.6;
      this.cheerSounds.push(audio);
    });
    
    this.isInitialized = true;
    console.log("Crowd system initialized");
  },
  
  // Start ambient crowd noise when race begins
  startAmbience: function() {
    if (!this.isInitialized) this.init();
    
    try {
      // Fade in ambient crowd
      this.ambientSound.volume = 0;
      this.ambientSound.play().then(() => {
        this.fadeVolume(this.ambientSound, 0.25, 2000);
        console.log("Crowd ambience started");
      }).catch(err => {
        console.warn("Crowd ambience failed to start:", err);
      });
    } catch(e) {
      console.error("Crowd ambience error:", e);
    }
  },
  
  // Stop ambient noise when race ends
  stopAmbience: function(fadeTime = 1000) {
    if (!this.ambientSound) return;
    
    this.fadeVolume(this.ambientSound, 0, fadeTime, () => {
      this.ambientSound.pause();
    });
  },
  
  // Fade audio volume smoothly
  fadeVolume: function(audio, targetVolume, duration, callback) {
    if (!audio) return;
    
    const startVolume = audio.volume;
    const volumeDiff = targetVolume - startVolume;
    const steps = 20;
    const stepTime = duration / steps;
    let currentStep = 0;
    
    const interval = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;
      audio.volume = Math.max(0, Math.min(1, startVolume + (volumeDiff * progress)));
      
      if (currentStep >= steps) {
        clearInterval(interval);
        if (callback) callback();
      }
    }, stepTime);
  },
  
  // Play a random cheer sound
  playCheer: function(volume = 0.6) {
    if (!this.isInitialized || this.cheerSounds.length === 0) return;
    
    try {
      // Pick random cheer
      const cheer = this.cheerSounds[Math.floor(Math.random() * this.cheerSounds.length)];
      const clone = cheer.cloneNode();
      clone.volume = volume;
      
      clone.play().catch(err => {
        console.warn("Cheer sound failed:", err);
      });
      
      console.log("Crowd cheer played at volume:", volume);
    } catch(e) {
      console.error("Cheer error:", e);
    }
  },
  
  // React to race start
  onRaceStart: function() {
    this.startAmbience();
    setTimeout(() => {
      this.playCheer(0.7);
    }, 1000); // Cheer after countdown
  },
  
  // React to player overtake
  onOvertake: function(playerId) {
    this.playCheer(0.5);
    this.raiseExcitement(10);
  },
  
  // React to power-up collection
  onPowerUp: function(playerId) {
    this.playCheer(0.4);
  },
  
  // React to race finish (excitement based on how close)
  onPlayerFinish: function(playerId, position, timeDifference) {
    const baseVolume = 0.8;
    
    if (position === 1) {
      // Winner gets huge cheer
      this.playVictoryRoar();
    } else if (timeDifference < 1.0) {
      // Close finish = loud cheer
      this.playCheer(baseVolume);
    } else if (timeDifference < 3.0) {
      // Normal finish
      this.playCheer(baseVolume * 0.7);
    } else {
      // Distant finish = quieter
      this.playCheer(baseVolume * 0.4);
    }
  },
  
  // Massive roar for winner
  playVictoryRoar: function() {
    console.log("Victory roar!");
    
    // Increase ambient crowd volume
    this.fadeVolume(this.ambientSound, 0.5, 500);
    
    // Play multiple cheers overlapping
    setTimeout(() => this.playCheer(0.9), 0);
    setTimeout(() => this.playCheer(0.8), 200);
    setTimeout(() => this.playCheer(0.7), 400);
    
    // Fade back down
    setTimeout(() => {
      this.fadeVolume(this.ambientSound, 0.25, 2000);
    }, 2000);
  },
  
  // Raise excitement level (affects ambient volume)
  raiseExcitement: function(amount) {
    this.currentExcitementLevel = Math.min(100, this.currentExcitementLevel + amount);
    
    if (this.ambientSound && !this.ambientSound.paused) {
      const targetVolume = 0.25 + (this.currentExcitementLevel / 100) * 0.25;
      this.fadeVolume(this.ambientSound, targetVolume, 500);
    }
    
    // Decay excitement over time
    setTimeout(() => {
      this.currentExcitementLevel = Math.max(0, this.currentExcitementLevel - amount);
    }, 3000);
  },
  
  // React to close racing (multiple players near each other)
  onCloseRacing: function(playerPositions) {
    // Calculate if players are bunched up
    const positions = Object.values(playerPositions);
    if (positions.length < 2) return;
    
    const sorted = positions.sort((a, b) => b - a);
    const leadGap = sorted[0] - sorted[1];
    
    if (leadGap < 50) { // Very close
      this.raiseExcitement(5);
    }
  },
  
  // Reset for new race
  reset: function() {
    this.currentExcitementLevel = 0;
    this.stopAmbience(500);
  }
};

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
/* ------------------------------
   9) UI RESET HELPER (patched)
------------------------------ */
function resetAllUIElements() {
  console.log('Resetting all UI elements...');
  
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

  // Reset track - DON'T clear innerHTML yet, we need the lane structure
  var track = document.getElementById('track');
  if (track) {
    track.classList.remove('active');
    track.style.display = 'block';
    track.style.transform = 'translateX(0px)';
    // Clear only dynamic elements, keep lane structure
    track.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect, .track-obstacle, .speed-zone, .power-up, .confetti-tape').forEach(el => el.remove());
  }

  // Reset container
  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active');
    container.style.display = 'block';
    container.style.transform = 'translateX(0px)';
  }

  // Reset camera offset
  if (typeof cameraState !== 'undefined') {
    cameraState.cameraOffset = 0;
  }

  // Reset runners but keep them in DOM
  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);
    
    if (lane) lane.style.display = 'none'; // Hide all lanes initially
    
    if (runner) {
      runner.style.left = '20px';
      runner.classList.remove('running', 'active', 'winner', 'bot-runner', 'speed-boost', 'slowed', 'shielded');
      runner.style.backgroundImage = ''; // Clear background
      runner.textContent = ''; // Clear any text
      runner.innerHTML = ''; // Clear any HTML
      if (runner.dataset.frames) {
        delete runner.dataset.frames;
        delete runner.dataset.currentFrame;
      }
    }
    
    if (nameLabel) {
      nameLabel.textContent = '';
      nameLabel.style.opacity = '1';
    }
  }

  // Reset state flags BEFORE setupLanes is called elsewhere
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.positions = {};
  gameState.speeds = {};
  gameState.finishTimes = {};
  gameState.countdownActive = false;
  gameState.isResetting = false;
  playerStates = {};

  // Re-lock scroll for lobby
  lockScroll(true);

  // Rebuild finish line
  ensureFinishLine();

  // Reload all sprites so they're ready when players join
  gameGraphics.loadAllSushiCharacters();

  // Show lobby again
  var lobby = document.getElementById('lobby');
  if (lobby) {
    lobby.style.display = 'flex';
  }

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

  console.log('UI reset complete - waiting for new players');
}




/* ------------------------------
   10) INITIALIZE
------------------------------ */
function initGame() {
  // user interaction primes audio on mobile
  document.addEventListener('click', function(){ initSounds(); initWebAudio(); }, { once: true });
  document.addEventListener('touchstart', function(){ initSounds(); initWebAudio(); }, { once: true });

  // load sprites
  console.log('Loading sushi character sprites...');
  gameGraphics.loadAllSushiCharacters();

  function initEnhancedFeatures() {
    // Start Tokyo atmosphere effects
    tokyoAtmosphere.startCherryBlossoms();
    console.log('Enhanced Sushi Sprint features initialized!');
  }

  initEnhancedFeatures();

  if (eventListenersSetup) return;
  eventListenersSetup = true;

    // ADD THIS near the start:
  if (typeof crowdSystem !== 'undefined') {
    crowdSystem.init();
  }

  // Set track width (longer on desktop)
  var raceLengthPx = isMobileDevice() ? 4500 : 7000;
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

  if (Object.values(gameState.players).some(p => p.socketId === socket.id)) {
    setupMobileControls();
  }

  applySlotAvailability();

  // Update lobby roster UI
    // UPDATE THIS SECTION - Add bot indicators
  var playerList = document.getElementById('playerList');
  if (playerList) {
    playerList.innerHTML = '';
    Object.keys(gameState.players).forEach(function(pid) {
      var player = gameState.players[pid];
      var div = document.createElement('div');
      div.className = 'player-entry';

      // Mark bots with special styling
      if (player.isBot) {
        div.classList.add('bot-player');
        div.style.opacity = '0.85';
        div.style.borderColor = '#888';
      }

      if (data.hostSocketId && player.socketId === data.hostSocketId) {
        div.classList.add('host');
      }

      var avatar = document.createElement('img');
      avatar.style.width = '24px';
      avatar.style.height = '24px';
      avatar.style.imageRendering = 'pixelated';
      avatar.alt = player.name;

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
        avatar.src = 'images/maki_roll_1.png';
      }

      var label = document.createElement('span');
      // Add [BOT] indicator
      label.textContent = player.name.toUpperCase() + (player.isBot ? ' [BOT]' : '');

      div.appendChild(avatar);
      div.appendChild(label);
      playerList.appendChild(div);
    });

    // Update counter with bot count
    var counterEl = document.getElementById('playerCounter');
    var max = (data && typeof data.maxPlayers === 'number') ? data.maxPlayers : 4;
    var totalPlayers = Object.keys(gameState.players).length;
    var botCount = Object.values(gameState.players).filter(p => p.isBot).length;
    var realCount = totalPlayers - botCount;
    
    if (counterEl) {
      if (botCount > 0) {
        counterEl.textContent = `Players: ${realCount} + ${botCount} bot${botCount > 1 ? 's' : ''} (${totalPlayers}/${max})`;
      } else {
        counterEl.textContent = 'Players joined: ' + totalPlayers + '/' + max;
      }
    }
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

  if (data && data.players)   gameState.players   = data.players;
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



// Reset room handler
// Reset room handler - REPLACE YOUR EXISTING ONE
socket.on('resetRoom', (data) => {
  console.log('Reset room event received from server', data);
  
  // First reset UI
  resetAllUIElements();

  // Then clear game state
  gameState.players     = {};
  gameState.positions   = {};
  gameState.speeds      = {};
  gameState.finishTimes = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.roomId = null;
  
  // Request new room assignment
  socket.emit('quickRace');
  
  console.log('Local reset complete, requested new room');
});

// Remove the old roomReset handler if you have one



socket.on('updateState', function (data) {
  if (gameState.isResetting || gameState.raceFinished) return;
  
  if (data && data.positions) {
    for (var k in data.positions) {
      // Only update if server position is significantly different
      var serverPos = data.positions[k];
      var localPos = gameState.positions[k] || 20;
      
      if (Math.abs(serverPos - localPos) > 5) {
        // Reconcile with server position
        gameState.positions[k] = serverPos;
        var runner = document.getElementById('runner' + k);
        if (runner) {
          runner.style.left = serverPos + 'px';
        }
      }
    }
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

socket.on('endRace', (data) => {
  if (gameState.isResetting || gameState.raceFinished) return;

  console.log("EndRace payload:", data);

  // Update state
  gameState.players     = data.players     || {};
  gameState.positions   = data.positions   || {};
  gameState.speeds      = data.speeds      || {};
  gameState.finishTimes = data.finishTimes || {};
  gameState.raceFinished = true;
  gameLoopRunning = false;

  if (timerInterval) { 
    clearInterval(timerInterval); 
    timerInterval = null; 
  }

  // Show results after a brief delay
  setTimeout(function() {
    showResults();
  }, 500);
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
        
        if (gameState.players[i].isBot) {
          runner.classList.add('bot-runner');
        }
        
        // CRITICAL: Wait for sprites to load before updating
        if (gameGraphics.characters[i] && gameGraphics.characters[i].loaded) {
          gameGraphics.updateRunnerSprite(i);
        } else {
          // Retry after a short delay for slow connections
          setTimeout(function(playerId) {
            if (gameGraphics.characters[playerId] && gameGraphics.characters[playerId].loaded) {
              gameGraphics.updateRunnerSprite(playerId);
            } else {
              console.warn(`Sprites still not loaded for player ${playerId}`);
            }
          }.bind(null, i), 500);
        }

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
        var playerName = (gameState.players[i].name || ('Runner ' + i)).toUpperCase();
        if (gameState.players[i].isBot) {
          playerName += ' [BOT]';
          nameLabel.style.opacity = '0.8';
        }
        nameLabel.textContent = playerName;
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
   13) MOBILE CONTROLS (UPDATED - NO TAP DURING COUNTDOWN)
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
  
  // PREVENT TAPPING DURING COUNTDOWN
  if (gameState.countdownActive) {
    console.log('Tapping blocked - countdown in progress');
    return;
  }
  
  // NEW: Check if taps are blocked by SOY_TRAP
  if (playerStates[playerId] && playerStates[playerId].tapsBlocked) {
    console.log('Taps blocked by power-up!');
    return;
  }
  
  if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) return;

  btn.classList.add('pressed');

  if (!playerStates[playerId]) playerStates[playerId] = {};
  playerStates[playerId].lastTap = Date.now();

  // PREDICTIVE MOVEMENT - Move locally first
  var currentPos = gameState.positions[playerId] || 20;
  var predictedMovement = 8;
  var newPosition = currentPos + predictedMovement;
  
  // Update local position immediately
  gameState.positions[playerId] = newPosition;
  var runner = document.getElementById('runner' + playerId);
  if (runner) {
    runner.style.left = newPosition + 'px';
  }

  // Start animation and send to server
  startRunnerAnimation(playerId);
  socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });

  // Spawn dust and play sounds
  spawnDust(playerId);
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

  // ENSURE SPRITE STAYS VISIBLE
  var character = gameGraphics.characters[playerId];
  if (character && character.loaded && character.frames.length > 0 && !runner.dataset.frames) {
    runner.dataset.frames = JSON.stringify(character.frames);
    runner.dataset.currentFrame = '0';
    runner.style.backgroundImage = 'url(' + character.frames[0] + ')';
    runner.style.backgroundSize = 'cover';
    runner.style.backgroundRepeat = 'no-repeat';
  }

  if (runner.dataset.frames && !playerStates[playerId].animationInterval) {
    playerStates[playerId].animationInterval = setInterval(function () {
      if (playerStates[playerId] && playerStates[playerId].isRunning) gameGraphics.animateSprite(playerId);
    }, 80);
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
   15) COUNTDOWN / TIMER / GAMELOOP (UPDATED)
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
      
      // Resume audio context if suspended (mobile issue fix)
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      
      if (sounds.initialized) sounds.playCountdown();
    } else if (count === 0) {
      countdownEl.style.display = 'none';
      
      // Resume audio context before playing GO sound
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      
      if (sounds.initialized) sounds.playGo();
      
      if (typeof kanjiEffects !== 'undefined') {
        kanjiEffects.showKanji('start');
      }
      

      // ADD THIS (every few frames):
  if (Math.random() < 0.1 && typeof crowdSystem !== 'undefined') {
    crowdSystem.onCloseRacing(gameState.positions);
  }
      // Crowd reacts to race start
      if (typeof crowdSystem !== 'undefined') {
        crowdSystem.onRaceStart();
      }
      
      playStartSound();
      launchTickerTape();
    } else {
      clearInterval(interval);
      gameState.countdownActive = false;
      gameState.startTime = Date.now();
      startTimer();
      startGameLoop();
      console.log('Race timer started - tapping now enabled');
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
/* ------------------------------
   17) FINISH & RESULTS - FIXED
------------------------------ */
/* ------------------------------
   17) FINISH & RESULTS
------------------------------ */
function checkFinish(playerId) {
  if (!playerStates[playerId] || gameState.finishTimes[playerId] || gameState.isResetting) return;

  var trackElement = document.getElementById('track');
  if (trackElement) gameState.trackWidth = trackElement.offsetWidth;

  var isMobile = window.innerWidth <= 480;
  var finishLineOffset = isMobile ? 80 : 100;
  var finishLinePosition = gameState.trackWidth - finishLineOffset - 20;

  var currentPosition = (typeof gameState.positions[playerId] === 'number') ? gameState.positions[playerId] : 20;
  if (currentPosition >= finishLinePosition) {
    var finishTime = (Date.now() - gameState.startTime) / 1000;
    gameState.finishTimes[playerId] = finishTime;

     if (typeof crowdSystem !== 'undefined') {
      const finishedCount = Object.keys(gameState.finishTimes).length;
      const timeDiff = finishTime - (Object.values(gameState.finishTimes)[0] || finishTime);
      crowdSystem.onPlayerFinish(playerId, finishedCount, timeDiff);
    }

    if (sounds.initialized) sounds.playFinish();

    socket.emit('checkFinish', { roomId: gameState.roomId, playerId: playerId, finishTime: finishTime });

    // Stop this runner's animation
    var runner = document.getElementById('runner' + playerId);
    if (runner) stopRunnerAnimation(playerId);

    // If every active player finished, end race
    var allFinished = true;
    for (var id in gameState.players) {
      if (typeof gameState.finishTimes[id] === 'undefined') { 
        allFinished = false; 
        break; 
      }
    }
    if (allFinished) {
      setTimeout(function(){ 
        socket.emit('endRace', gameState.roomId); 
      }, 300);
    }
  }
}

function endRace() {
  console.log('Race ended - preparing to show results');
  setTimeout(function() {
    showResults();
  }, 500);
}

function showResults() {
  if (gameState.isResetting) return;

  console.log('Showing results with finishTimes:', gameState.finishTimes);

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

  if (track) { 
    track.classList.remove('active'); 
    track.style.display = 'none'; 
  }
  if (container) {
    container.classList.remove('active');
    container.style.display = 'none'; 
  }

  // Show results screen
  if (results) {
    results.classList.add('active');
    results.style.display = 'flex';
  }

  // Scroll to top
  var screen = document.getElementById('screen');
  if (screen) screen.scrollTop = 0;
  window.scrollTo(0, 0);

  // Populate leaderboard
  var leaderboard = document.getElementById('leaderboard');
  if (!leaderboard) {
    console.error('Leaderboard element not found!');
    return;
  }
  
  leaderboard.innerHTML = '';

  // Sort players by finish time
  var sorted = Object.keys(gameState.finishTimes).map(function(pid){
    return { 
      playerId: pid, 
      time: gameState.finishTimes[pid], 
      name: (gameState.players[pid] && gameState.players[pid].name) || ('Runner ' + pid) 
    };
  }).sort(function(a,b){ 
    return a.time - b.time; 
  });

  console.log("Sorted results:", sorted);

  if (sorted.length === 0) {
    leaderboard.innerHTML = '<div style="color:#888;">No results available</div>';
    return;
  }

  // Display results
  var medals = ['🥇','🥈','🥉','🏅'];
  sorted.forEach(function(r, index){
    var row = document.createElement('div');
    row.className = 'result-item';
    row.innerHTML = '<span>' + (medals[index] || '🏅') + ' ' + (index+1) + '. ' + 
                    r.name.toUpperCase() + '</span> <span>' + r.time.toFixed(3) + 's</span>';
    leaderboard.appendChild(row);
  });

  // Winner celebration
  var winner = sorted[0];
  if (winner) {
    var winnerRunner = document.getElementById('runner' + winner.playerId);
    if (winnerRunner) winnerRunner.classList.add('winner');
    if (sounds.initialized) sounds.playVictory();
    if (typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('victory');
    }
  }
}

/* ------------------------------
   18) RESET
------------------------------ */
function resetGame() {
  if (gameState.isResetting) {
    console.log('Reset already in progress, ignoring duplicate call');
    return;
  }
  
  console.log("Initiating game reset...");
  gameState.isResetting = true;
  
  // Clear dynamic elements
  if (typeof trackElements !== 'undefined') trackElements.clearElements();
  if (typeof powerUpSystem !== 'undefined') powerUpSystem.activePowerUps = {};
  document.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect').forEach(el => el.remove());
  
  // Stop all intervals and timers
  gameState.countdownActive = false;
  gameLoopRunning = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (typeof crowdSystem !== 'undefined') {
    crowdSystem.reset();
  }
  
  // Clear all animations
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }
  
  // Tell server to reset
  socket.emit('resetRoom', gameState.roomId);
  
  console.log("Reset request sent to server");
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
  var raceLengthPx = isMobileDevice() ? 4500 : 7000;
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