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

const SPEED_MULTIPLIER = 3; // same as server



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
  characters: {
    speed: { kanji: '速', meaning: 'SPEED', color: '#00FF88' },      // 速 = speed
    power: { kanji: '力', meaning: 'POWER', color: '#FFD700' },      // 力 = power
    victory: { kanji: '勝', meaning: 'VICTORY', color: '#FF3366' },  // 勝 = victory
    start: { kanji: '行', meaning: 'GO!', color: '#FFFFFF' },        // 行 = go
    finish: { kanji: '完', meaning: 'FINISH', color: '#FF3366' },    // 完 = complete
    boost: { kanji: '加', meaning: 'BOOST', color: '#00FFFF' },      // 加 = add/boost
    slow: { kanji: '遅', meaning: 'SLOW', color: '#8B4513' }         // 遅 = slow
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
    
    if (playerId) {
      const runner = document.getElementById('runner' + playerId);
      if (runner && runner.parentElement) {
        kanji.style.cssText = `
          position: absolute;
          left: ${runner.offsetLeft + 16}px;
          top: ${runner.offsetTop - 40}px;
          color: ${char.color};
          font-family: 'Press Start 2P', monospace;
          text-align: center;
          font-weight: bold;
          z-index: 200;
          animation: kanjiPlayerPop 2s ease-out forwards;
          pointer-events: none;
        `;
        const track = document.getElementById('track') || runner.parentElement;
        if (track) track.appendChild(kanji);
      }
    } else {
      kanji.style.cssText = `
        position: fixed;
        top: 30%;
        left: 50%;
        transform: translateX(-50%);
        color: ${char.color};
        font-family: 'Press Start 2P', monospace;
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

var comboSystem = {
  combos: {},
  
  addTap: function(playerId) {
    if (!this.combos[playerId]) {
      this.combos[playerId] = { count: 0, timer: null };
    }
    
    const combo = this.combos[playerId];
    combo.count++;
    
    clearTimeout(combo.timer);
    combo.timer = setTimeout(() => {
      combo.count = 0;
    }, 2000);  // Change from 1000 to 2000 - longer window but still resets
    
    // Show combo every 20 taps instead of 5
    if (combo.count % 20 === 0 && combo.count >= 20) {  // Only show at 20, 40, 60, etc.
      this.showCombo(playerId, combo.count);
    }
  },
  
showCombo: function(playerId, count) {
  const player = gameState.players[playerId];
  if (!player || player.isBot || player.socketId !== socket.id) return;
  
  const comboText = document.createElement('div');
  comboText.className = 'combo-display';
  comboText.innerHTML = `
    <div style="font-size: 3rem; color: #FFD700;">${count}</div>
    <div style="font-size: 1.2rem; color: #FF3366;">COMBO!</div>
  `;
  comboText.style.cssText = `
    position: fixed;
    top: 40%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    font-family: 'Press Start 2P', monospace;
    text-shadow: 3px 3px 0 #000;
    z-index: 9999;
    animation: comboPopJapanese 1s ease-out forwards;
    pointer-events: none;
  `;
  
  document.body.appendChild(comboText);
  setTimeout(() => comboText.remove(), 1000);
  
  if (count >= 10) {
    document.getElementById('screen').classList.add('screen-shake');
    setTimeout(() => {
      document.getElementById('screen').classList.remove('screen-shake');
    }, 300);
  }
  
  if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
}
};


// Safe flag helper (uses window.isoToFlagEmoji if index.html defined it)
function flagEmojiSafe(cc) {
  cc = (cc || 'UN').toUpperCase();
  if (typeof window !== 'undefined' && typeof window.isoToFlagEmoji === 'function') {
    return window.isoToFlagEmoji(cc) || '🇺🇳';
  }
  // Fallback math
  if (!/^[A-Z]{2}$/.test(cc)) return '🇺🇳';
  var A = 0x1F1E6;
  return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65));
}



// Lane system
// Lane system
var laneSystem = {
  lanes: 4,
  laneHeight: 80,
  playerLanes: {},
  
  initPlayer: function(playerId) {
    if (!this.playerLanes[playerId]) {
      this.playerLanes[playerId] = playerId;
    }
    this.addLaneTapZones(playerId);
  },
  
  addLaneTapZones: function(playerId) {
    const player = gameState.players[playerId];
    if (!player || player.isBot || player.socketId !== socket.id) return;
    
    // Remove old zones if they exist
    document.querySelectorAll(`.lane-zone-${playerId}`).forEach(el => el.remove());
    
    // Create UP zone (top 35% of screen)
    const upZone = document.createElement('div');
    upZone.className = `lane-zone-${playerId}`;
    upZone.style.cssText = `
      position: fixed;
      top: calc(env(safe-area-inset-top) + 60px);
      left: 0;
      right: 0;
      height: 30%;
      z-index: 2400;
      pointer-events: auto;
    `;
    upZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.changeLane(playerId, 'up');
    }, { passive: false });
    document.body.appendChild(upZone);
    
    // Create DOWN zone (bottom area above controls)
    const downZone = document.createElement('div');
    downZone.className = `lane-zone-${playerId}`;
    downZone.style.cssText = `
      position: fixed;
      bottom: calc(env(safe-area-inset-bottom) + 180px);
      left: 0;
      right: 0;
      height: 30%;
      z-index: 2400;
      pointer-events: auto;
    `;
    downZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.changeLane(playerId, 'down');
    }, { passive: false });
    document.body.appendChild(downZone);
    
    console.log(`Lane tap zones added for player ${playerId}`);
  },
  
  removeTapZones: function(playerId) {
    document.querySelectorAll(`.lane-zone-${playerId}`).forEach(el => el.remove());
  },
  
  changeLane: function(playerId, direction) {
    if (!gameState.raceStarted || gameState.raceFinished) return;
    
    const currentLane = this.playerLanes[playerId] || playerId;
    let newLane = currentLane;
    
    if (direction === 'up' && currentLane > 1) {
      newLane = currentLane - 1;
    } else if (direction === 'down' && currentLane < this.lanes) {
      newLane = currentLane + 1;
    }
    
    if (newLane !== currentLane) {
      this.playerLanes[playerId] = newLane;
      this.updateRunnerLane(playerId, newLane);
      
      socket.emit('changeLane', { 
        roomId: gameState.roomId, 
        playerId: playerId, 
        lane: newLane 
      });
      
      this.showLaneChangeIndicator(playerId, direction);
      if (sounds.initialized) sounds.playTap();
    }
  },
  
  updateRunnerLane: function(playerId, laneNum) {
    const runner = document.getElementById('runner' + playerId);
    if (!runner) return;
    
    const laneHeight = 80;
    const topPosition = (laneNum - 1) * laneHeight + 20;
    runner.style.top = topPosition + 'px';
    
    // Update name label too
    const nameLabel = document.getElementById('name' + playerId);
    if (nameLabel) {
      nameLabel.style.top = ((laneNum - 1) * laneHeight + 2) + 'px';
    }
  },
  
  showLaneChangeIndicator: function(playerId, direction) {
    const runner = document.getElementById('runner' + playerId);
    if (!runner) return;
    
    const arrow = document.createElement('div');
    arrow.textContent = direction === 'up' ? '↑' : '↓';
    arrow.style.cssText = `
      position: absolute;
      left: -20px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 16px;
      color: #FFD700;
      font-weight: bold;
      animation: laneArrowSlide 0.3s ease-out forwards;
      z-index: 100;
      text-shadow: 2px 2px 0 #000;
    `;
    runner.appendChild(arrow);
    setTimeout(() => arrow.remove(), 300);
  }
};

/* ------------------------------
   DEFENSE + STAMINA SYSTEM
------------------------------ */
/* ------------------------------
   DEFENSE + STAMINA SYSTEM
------------------------------ */
var defenseSystem = {
  activeAttacks: {},
  blockWindows: {},
  pressStates: {},

  // ==== Stamina Tracking ====
  stamina: {},
  MAX_STAMINA: 100,
  STAMINA_COST: 5,
  STAMINA_REGEN: 2,
  STAMINA_TICK_MS: 200,

initStamina: function(playerId) {
  if (!this.stamina[playerId]) this.stamina[playerId] = this.MAX_STAMINA;

  // Update top bar for local player only
  const player = gameState.players[playerId];
  if (player && !player.isBot && player.socketId === socket.id) {
    const staminaDisplay = document.getElementById('staminaDisplay');
    if (staminaDisplay) staminaDisplay.style.display = 'flex';
  }
},

  initiateAttack: function(targetPlayerId, attackType, duration) {
  console.log(`Initiating attack on player ${targetPlayerId}: ${attackType}`);
  
  // Create block window for target
  this.blockWindows[targetPlayerId] = {
    startTime: Date.now(),
    attackType: attackType,
    duration: 1300, // 1.3 seconds to react
    blocked: false
  };
  
  // Show warning to target player
  const targetPlayer = gameState.players[targetPlayerId];
  if (targetPlayer && !targetPlayer.isBot && targetPlayer.socketId === socket.id) {
    this.showAttackWarning(targetPlayerId, attackType);
  }
  
  // If not blocked in time, apply effect
  setTimeout(() => {
    const window = this.blockWindows[targetPlayerId];
    if (window && !window.blocked) {
      console.log(`Attack hit player ${targetPlayerId} - applying slow effect`);
      this.applyAttackEffect(targetPlayerId, attackType, duration);
      if (typeof kanjiEffects !== 'undefined') {
        kanjiEffects.showKanji('slow', targetPlayerId);
      }
    }
    delete this.blockWindows[targetPlayerId];
  }, 1300);
},
 
  spendStamina: function(playerId) {
    this.initStamina(playerId);
    if (this.stamina[playerId] > 0) {
      this.stamina[playerId] = Math.max(0, this.stamina[playerId] - this.STAMINA_COST);
      return true;
    } else {
      return false;
    }
  },

startRegenLoop: function() {
  if (this.regenLoopStarted) return;
  this.regenLoopStarted = true;
  setInterval(() => {
    for (let pid in this.stamina) {
      if (this.stamina[pid] < this.MAX_STAMINA) {
        this.stamina[pid] = Math.min(this.MAX_STAMINA, this.stamina[pid] + this.STAMINA_REGEN);
        
        // Update top bar for local player
        const player = gameState.players[pid];
        if (player && !player.isBot && player.socketId === socket.id) {
          const fill = document.getElementById('staminaFill');
          if (fill) {
            fill.style.width = this.stamina[pid] + '%';
            fill.style.background = this.stamina[pid] > 30 
              ? 'linear-gradient(90deg, #00FF88, #FFD700)' 
              : 'linear-gradient(90deg, #FF3366, #FF6600)';
          }
        }
      }
    }
  }, this.STAMINA_TICK_MS);
},

  // ==== Button Handling (FIXED TIMING) ====
registerPress: function(playerId, side) {
  this.startRegenLoop();
  this.initStamina(playerId);

  if (!this.pressStates[playerId]) {
    this.pressStates[playerId] = { L: false, R: false, pressTime: {}, clearTimers: {} };
  }

  const now = Date.now();
  this.pressStates[playerId][side] = true;
  this.pressStates[playerId].pressTime[side] = now;

  // Auto-clear after 200ms (reduced from 400ms)
  if (this.pressStates[playerId].clearTimers[side]) {
    clearTimeout(this.pressStates[playerId].clearTimers[side]);
  }
  this.pressStates[playerId].clearTimers[side] = setTimeout(() => {
    if (this.pressStates[playerId]) {
      this.pressStates[playerId][side] = false;
      delete this.pressStates[playerId].pressTime[side];
    }
  }, 200); // Shorter window

  // ONLY check for simultaneous press if BOTH times exist and are recent
  if (this.pressStates[playerId].L && this.pressStates[playerId].R) {
    const lTime = this.pressStates[playerId].pressTime.L;
    const rTime = this.pressStates[playerId].pressTime.R;
    
    // Both times must exist
    if (lTime && rTime) {
      const timeDiff = Math.abs(lTime - rTime);
      console.log(`Both buttons detected! Time difference: ${timeDiff}ms`);

      if (timeDiff <= 150) { // Tighter window: 150ms total
        if (timeDiff <= 80) {
          console.log('→ PERFECT timing!');
          this.checkSimultaneousPress(playerId, now, "perfect");
        } else {
          console.log('→ GOOD timing!');
          this.checkSimultaneousPress(playerId, now, "good");
        }
      } else {
        console.log(`→ Too slow (${timeDiff}ms), treating as separate taps`);
      }
    }
  }
},

  registerRelease: function(playerId, side) {
    if (this.pressStates[playerId]) {
      if (this.pressStates[playerId].clearTimers && this.pressStates[playerId].clearTimers[side]) {
        clearTimeout(this.pressStates[playerId].clearTimers[side]);
        delete this.pressStates[playerId].clearTimers[side];
      }
      this.pressStates[playerId][side] = false;
      delete this.pressStates[playerId].pressTime[side];
    }
  },

  // ==== Skill Logic (FIXED PRIORITY) ====
// ==== Skill Logic - BLOCKS ONLY ====
checkSimultaneousPress: function(playerId, now, grade = "fail") {
  if (grade === "fail") return;

  console.log(`checkSimultaneousPress for player ${playerId}, grade: ${grade}`);

  // ONLY check for active attacks to block
  const hasActiveAttack = this.blockWindows[playerId];
  
  if (hasActiveAttack) {
    console.log('→ Active attack detected, attempting block...');
    if (this.attemptBlock(playerId, now, grade)) {
      console.log('→ Block successful!');
      return;
    }
    console.log('→ Block attempt failed');
  } else {
    console.log('→ No active attack to block');
  }
  
  // That's it! Power-ups are activated via the dedicated button only
},

  attemptBlock: function(playerId, now, grade) {
    const window = this.blockWindows[playerId];
    if (!window) return false;

    window.blocked = true;

    if (grade === "perfect") {
      this.showBlockFeedback(playerId, "PERFECT!", "#FFD700");
      this.counterAttack(playerId, 7);
    } else if (grade === "good") {
      this.showBlockFeedback(playerId, "BLOCKED!", "#00FF88");
      this.counterAttack(playerId, 3);
    } else {
      return false;
    }

    delete this.blockWindows[playerId];
    return true;
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

/* ------------------------------
   TAP FUNCTIONS
------------------------------ */
function tapPress(e, playerId, btn) {
  e.preventDefault(); 
  e.stopPropagation();
  
  if (gameState.countdownActive) return;
  if (playerStates[playerId] && playerStates[playerId].tapsBlocked) return;
  if (!gameState.raceStarted || gameState.raceFinished || gameState.isResetting) return;

  const side = btn.getAttribute('data-side');
  
  // Register press for defense system only
  if (side && typeof defenseSystem !== 'undefined') {
    defenseSystem.registerPress(playerId, side);
  }

  btn.classList.add('pressed');
}

function tapRelease(e, playerId, btn) {
  e.preventDefault();
  e.stopPropagation();

  if (btn) btn.classList.remove('pressed', 'active');

  // BLOCK all tapping during countdown
  if (gameState.countdownActive) return;

  const side = btn ? btn.getAttribute('data-side') : null;
  var runner = document.getElementById('runner' + playerId);
  
  // Execute normal tap movement
  if (gameState.raceStarted && !gameState.raceFinished) {
    if (typeof comboSystem !== 'undefined') {
      comboSystem.addTap(playerId);
    }
    
    if (!defenseSystem.spendStamina(playerId)) {
      console.log("Exhausted!");
      return;
    }
    
    if (runner) {
      var currentPos = parseFloat(runner.style.left) || 20;
      var predictedMovement = 8 * 3;
      var newPosition = currentPos + predictedMovement;
      runner.style.left = newPosition + 'px';
    }
    
    startRunnerAnimation(playerId);
    socket.emit('playerAction', { roomId: gameState.roomId, playerId });
    spawnDust(playerId);
    if (sounds.initialized) sounds.playTap();
    if (navigator.vibrate) navigator.vibrate(10);
  }
  
  if (side && typeof defenseSystem !== 'undefined') {
    defenseSystem.registerRelease(playerId, side);
  }

  if (!runner) return;

  clearTimeout(runner._stopTimer);
  runner._stopTimer = setTimeout(() => {
    stopRunnerAnimation(playerId);
  }, 200);
}

/* ------------------------------
   MOBILE CONTROLS
------------------------------ */
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
  
  var press = function(e){ 
    tapPress(e, pid, btn); 
  };
  
  var release = function(e){ 
    tapRelease(e, pid, btn); 
  };

  // Touch events
  btn.addEventListener('touchstart', press, { passive: false });
  btn.addEventListener('touchend', release, { passive: false });
  btn.addEventListener('touchcancel', release, { passive: false }); // Add this
  
  // Mouse events (for testing)
  btn.addEventListener('mousedown', press);
  btn.addEventListener('mouseup', release);
  btn.addEventListener('mouseleave', release); // Add this

  btn._bound = true;
});
}

/* ------------------------------
   KEYBOARD CONTROLS
------------------------------ */
var keyboardState = {};

function setupKeyboardControls() {
  if (window._keyboardSetup) return;
  window._keyboardSetup = true;

  document.addEventListener('keydown', function(e) {
    if (gameState.countdownActive || !gameState.raceStarted || gameState.raceFinished) return;
    
    var myPlayerId = null;
    for (var pid in gameState.players) {
      if (gameState.players[pid].socketId === socket.id) {
        myPlayerId = pid;
        break;
      }
    }
    if (!myPlayerId) return;

    var key = e.key.toLowerCase();
    var side = null;
    if (key === 'a' || key === 'arrowleft') {
      side = 'L';
    } else if (key === 'd' || key === 'arrowright') {
      side = 'R';
    }
    
    if (!side) return;
    if (keyboardState[side]) return;
    keyboardState[side] = true;
    
    e.preventDefault();
    
    if (typeof defenseSystem !== 'undefined') {
      defenseSystem.registerPress(myPlayerId, side);
      
      if (keyboardState.L && keyboardState.R) {
        console.log('Both keys pressed via keyboard');
        return;
      }
    }
    
    if (playerStates[myPlayerId] && playerStates[myPlayerId].tapsBlocked) {
      console.log('Taps blocked by power-up!');
      return;
    }
    
    var currentPos = gameState.positions[myPlayerId] || 20;
    var predictedMovement = 10 * SPEED_MULTIPLIER;
    var newPosition = currentPos + predictedMovement;
    
    gameState.positions[myPlayerId] = newPosition;
    var runner = document.getElementById('runner' + myPlayerId);
    if (runner) {
      runner.style.left = newPosition + 'px';
    }
    
    startRunnerAnimation(myPlayerId);
    socket.emit('playerAction', { roomId: gameState.roomId, playerId: myPlayerId });
    
    spawnDust(myPlayerId);
    if (sounds.initialized) sounds.playTap();
  });
  
  document.addEventListener('keyup', function(e) {
    var key = e.key.toLowerCase();
    var side = null;
    if (key === 'a' || key === 'arrowleft') {
      side = 'L';
    } else if (key === 'd' || key === 'arrowright') {
      side = 'R';
    }
    
    if (!side) return;
    keyboardState[side] = false;
    
    var myPlayerId = null;
    for (var pid in gameState.players) {
      if (gameState.players[pid].socketId === socket.id) {
        myPlayerId = pid;
        break;
      }
    }
    if (!myPlayerId) return;
    
    if (typeof defenseSystem !== 'undefined') {
      defenseSystem.registerRelease(myPlayerId, side);
    }
    
    var runner = document.getElementById('runner' + myPlayerId);
    if (!runner) return;
    
    clearTimeout(runner._stopTimer);
    runner._stopTimer = setTimeout(() => {
      stopRunnerAnimation(myPlayerId);
    }, 200);
  });
}

/* ------------------------------
   POWER-UP SYSTEM
------------------------------ */
var powerUpSystem = {
  types: {
    WASABI_RUSH: { 
      id: 'wasabi', 
      name: 'WASABI RUSH', 
      color: '#00FF88', 
      iconClass: 'powerup-icon-wasabi',
      kanji: '速',  // Speed
      kanjiMeaning: 'SPEED',
      duration: 3000,
      effect: 'speedBoost',
      description: 'SPEED BOOST'
    },
    FREEZE_BOMB: {
      id: 'freeze', 
      name: 'FREEZE BOMB', 
      color: '#00FFFF', 
      iconClass: 'powerup-icon-freeze',
      kanji: '氷',  // Ice
      kanjiMeaning: 'ICE',
      duration: 2500,
      effect: 'freezeOpponents',
      description: 'FREEZE ALL'
    },
    DASH_ROLL: {
      id: 'dash', 
      name: 'DASH', 
      color: '#FF00FF', 
      iconClass: 'powerup-icon-dash',
      kanji: '瞬',  // Instant
      kanjiMeaning: 'FLASH',
      duration: 500,
      effect: 'instantForward',
      description: 'BURST DASH'
    },
    MEGA_BOOST: { 
      id: 'mega', 
      name: 'MEGA BOOST', 
      color: '#FFD700', 
      iconClass: 'powerup-icon-mega',
      kanji: '超',  // Super
      kanjiMeaning: 'SUPER',
      duration: 4000,
      effect: 'megaBoost',
      description: 'SUPER SPEED'
    }
  },
  // ... rest of your powerUpSystem code

  playerStorage: {},
  spawnedPowerUps: [],
  nextSpawnDistance: 800,
  spawnInterval: 1200,

createPowerUp: function(type, x, y) {
  const powerUp = document.createElement('div');
  powerUp.className = 'power-up';
  powerUp.dataset.type = type.id;
  powerUp.dataset.x = x;
  powerUp.style.left = x + 'px';
  powerUp.style.top = y + 'px';
  
  // Create pixel icon instead of emoji
  const iconDiv = document.createElement('div');
  iconDiv.className = 'powerup-icon ' + type.iconClass;
  iconDiv.style.cssText = 'margin-bottom: 2px;';
  
  const label = document.createElement('div');
  label.className = 'powerup-label';
  label.textContent = type.name;
  label.style.cssText = `font-size: 6px; color: ${type.color}; font-weight: bold; text-shadow: 1px 1px 0 #000; font-family: 'Press Start 2P', monospace; letter-spacing: 0px;`;
  
  powerUp.appendChild(iconDiv);
  powerUp.appendChild(label);
  
  powerUp.style.cssText += `
    position: absolute;
    width: 40px;
    height: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.8);
    border: 2px solid ${type.color};
    border-radius: 8px;
    animation: powerUpFloat 2s ease-in-out infinite;
    z-index: 10;
    box-shadow: 0 0 15px ${type.color};
    pointer-events: none;
  `;
  
  const track = document.getElementById('track');
  if (track) track.appendChild(powerUp);
  
  this.spawnedPowerUps.push({ element: powerUp, x: x, type: type });
  return powerUp;
},


spawnFixedPowerUps: function() {
  if (!gameState.raceStarted || gameState.raceFinished) return;
  
  const track = document.getElementById('track');
  if (!track) return;

  let maxPosition = 0;
  for (let pid in gameState.positions) {
    maxPosition = Math.max(maxPosition, gameState.positions[pid] || 0);
  }

  while (this.nextSpawnDistance < maxPosition + 800) {
    const types = Object.values(this.types);
    const x = this.nextSpawnDistance;
    const laneHeight = track.offsetHeight / 4;
    
    // Different power-up for each lane
    for (let i = 0; i < 4; i++) {
      const randomType = types[Math.floor(Math.random() * types.length)];
      const y = i * laneHeight + laneHeight/2 - 20;
      this.createPowerUp(randomType, x, y);
    }
    
    this.nextSpawnDistance += this.spawnInterval;
  }
},

showActivationButton: function(playerId, type) {
  const btn = document.getElementById('activatePowerUpBtn');
  if (!btn) return;
  
  // Clear previous content
  btn.innerHTML = '';
  
  // Create pixel icon
  const iconDiv = document.createElement('div');
  iconDiv.className = type.iconClass;
  iconDiv.style.cssText = `
    width: 48px;
    height: 48px;
    transform: scale(1.5);
  `;
  btn.appendChild(iconDiv);
  
  btn.style.display = 'flex';
  
  // Add instruction text
  let instructionText = document.createElement('div');
  instructionText.className = 'instruction-text';
  instructionText.style.cssText = `
    position: absolute;
    top: -50px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.9);
    color: #FFD700;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 0.7rem;
    white-space: nowrap;
    animation: instructionPulse 1s ease-in-out infinite;
    pointer-events: none;
    border: 2px solid #FFD700;
    font-family: 'Press Start 2P', monospace;
    letter-spacing: 1px;
  `;
  instructionText.textContent = 'TAP TO USE!';
  btn.appendChild(instructionText);
  
  // Add arrow
  let arrow = document.createElement('div');
  arrow.className = 'side-arrow';
  arrow.style.cssText = `
    position: absolute;
    right: -60px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 2.5rem;
    animation: arrowBounce 0.6s ease-in-out infinite;
    pointer-events: none;
  `;
  arrow.textContent = '👈';
  btn.appendChild(arrow);
  
  // Play attention sound
  if (audioCtx) {
    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
      oscillator.type = 'sine';
      gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.2);
    } catch(e) {}
  }
  
  // Remove old listener if exists
  if (btn._clickHandler) {
    btn.removeEventListener('click', btn._clickHandler);
    btn.removeEventListener('touchstart', btn._clickHandler);
  }
  
  // Create new click handler
  btn._clickHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const stored = this.playerStorage[playerId];
    if (stored) {
      this.activateStoredPowerUp(playerId);
      btn.style.display = 'none';
      
      if (navigator.vibrate) {
        navigator.vibrate([50, 30, 50]);
      }
    }
  };
  
  btn.addEventListener('click', btn._clickHandler);
  btn.addEventListener('touchstart', btn._clickHandler, { passive: false });
},  // <-- This is where the function should end

// Replace lines 560-720 in game.js with this corrected version:

  hideActivationButton: function() {
    const btn = document.getElementById('activatePowerUpBtn');
    if (btn) {
      btn.style.display = 'none';
      
      const instructionText = btn.querySelector('.instruction-text');
      if (instructionText) instructionText.remove();
      
      const arrow = btn.querySelector('.side-arrow');
      if (arrow) arrow.remove();
      
      if (btn._clickHandler) {
        btn.removeEventListener('click', btn._clickHandler);
        btn.removeEventListener('touchstart', btn._clickHandler);
        btn._clickHandler = null;
      }
    }
  },

  checkCollisions: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (!runner) return;
    
    const runnerRect = runner.getBoundingClientRect();
    
    this.spawnedPowerUps.forEach((powerUpData, index) => {
      const powerUp = powerUpData.element;
      const powerUpRect = powerUp.getBoundingClientRect();
      
      if (this.isColliding(runnerRect, powerUpRect)) {
        let matchedType = null;
        for (const [key, type] of Object.entries(this.types)) {
          if (type.id === powerUpData.type.id) {
            matchedType = type;
            break;
          }
        }
        
        if (matchedType) {
          this.storePowerUp(playerId, matchedType);
          this.playPowerUpSound('collect');
          this.createCollectionParticles(powerUpRect);
          this.removePowerUpWithEffect(powerUp);
          this.spawnedPowerUps.splice(index, 1);
          
          console.log(`Player ${playerId} collected ${matchedType.name}`);
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

  storePowerUp: function(playerId, type) {
    const player = gameState.players[playerId];
    if (!player) return;

    this.playerStorage[playerId] = type;

    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      let icon = runner.querySelector('.stored-icon');
      if (!icon) {
        icon = document.createElement('div');
        icon.className = 'stored-icon ' + type.iconClass;
        icon.style.cssText = `
          position: absolute;
          top: -30px;
          left: 50%;
          transform: translateX(-50%);
          width: 24px;
          height: 24px;
          z-index: 100;
        `;
        runner.appendChild(icon);
      } else {
        icon.className = 'stored-icon ' + type.iconClass;
      }
    }

    if (!player.isBot && player.socketId === socket.id) {
      this.showActivationButton(playerId, type);
      this.showCollectionFeedback(type);
    }
  },

  // Add this method to powerUpSystem object (after storePowerUp method)

activateStoredPowerUp: function(playerId) {
  console.log('🎮 ACTIVATE CALLED for player', playerId);
  
  const type = this.playerStorage[playerId];
  console.log('🎮 Type found:', type);
  
  if (!type) {
    console.warn('No stored power-up for player', playerId);
    return;
  }
  
  console.log('🎮 About to show feedback...');
  this.showActivationFeedback(type.name, type.color, type);
  console.log('🎮 Feedback shown, applying effect...');
  
  this.activatePowerUpEffect(playerId, type);
  
  const runner = document.getElementById('runner' + playerId);
  if (runner) {
    const icon = runner.querySelector('.stored-icon');
    if (icon) icon.remove();
  }
  
  delete this.playerStorage[playerId];
  this.hideActivationButton();
  
  console.log('🎮 Activation complete!');
},

  showCollectionFeedback: function(type) {
    const feedback = document.createElement('div');
    feedback.className = 'collection-feedback';
    feedback.innerHTML = `
      <div style="font-size: 0.9rem; color: ${type.color};">${type.name}</div>
      <div style="font-size: 0.7rem; color: #FFD700; margin-top: 4px;">COLLECTED!</div>
    `;
    feedback.style.cssText = `
      position: fixed;
      top: 15%;
      left: 50%;
      transform: translateX(-50%);
      text-align: center;
      font-family: 'Press Start 2P', monospace;
      z-index: 9999;
      animation: collectionFeedbackPop 0.8s ease-out forwards;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.9);
      padding: 16px 24px;
      border: 3px solid ${type.color};
      border-radius: 12px;
      box-shadow: 0 0 30px ${type.color};
    `;
    document.body.appendChild(feedback);
    setTimeout(() => feedback.remove(), 800);
  },

showActivationFeedback: function(text, color, type) {
  const feedback = document.createElement('div');
  
  // Build compact HTML with Japanese kanji
  const iconHTML = type.iconClass 
    ? `<div class="${type.iconClass}" style="width:64px;height:64px;margin:0 auto 12px;transform:scale(1.8);"></div>`
    : '';
  
  // Large Japanese kanji character
  const kanjiHTML = type.kanji 
    ? `<div style="font-family:'Noto Sans JP',sans-serif;font-size:3.5rem;color:${color || type.color};text-shadow:4px 4px 0 #000;margin-bottom:8px;line-height:1;">${type.kanji}</div>`
    : '';
  
  // English translation of kanji
  const kanjiMeaningHTML = type.kanjiMeaning
    ? `<div style="font-family:'Press Start 2P',monospace;font-size:0.7rem;color:${color || type.color};opacity:0.8;margin-bottom:10px;letter-spacing:2px;font-weight:400;-webkit-font-smoothing:none;">${type.kanjiMeaning}</div>`
    : '';
  
  feedback.innerHTML = `
    <div style="background:rgba(0,0,0,0.95);padding:30px 50px;border:5px solid ${color || type.color};border-radius:20px;box-shadow:0 0 40px ${color || type.color};">
      ${iconHTML}
      ${kanjiHTML}
      ${kanjiMeaningHTML}
      <div style="font-family:'Press Start 2P',monospace;font-size:1.1rem;color:${color || type.color};text-shadow:3px 3px 0 #000;margin-bottom:10px;letter-spacing:1px;font-weight:400;-webkit-font-smoothing:none;">
        ${text || type.name}
      </div>
      <div style="font-family:'Press Start 2P',monospace;font-size:0.9rem;color:#FFD700;text-shadow:2px 2px 0 #000;letter-spacing:1px;font-weight:400;-webkit-font-smoothing:none;">
        ACTIVATED!
      </div>
    </div>
  `;
  
  // Center screen with the ORIGINAL pop animation (with rotation and bounce)
  feedback.style.cssText = `
    position: fixed !important;
    top: 40% !important;
    left: 50% !important;
    z-index: 999999 !important;
    pointer-events: none !important;
    animation: activationFeedbackPop 2s ease-out forwards !important;
  `;
  
  document.body.appendChild(feedback);
  
  setTimeout(() => {
    feedback.remove();
  }, 2000);
},


  activatePowerUpEffect: function(playerId, type) {
    console.log('Executing power-up effect:', type.effect, 'for player', playerId);
    
    switch(type.effect) {
      case 'speedBoost':
        this.applySpeedBoost(playerId);
        if (typeof kanjiEffects !== 'undefined') {
          kanjiEffects.showKanji('speed', playerId);
        }
        break;
        
      case 'megaBoost':
        this.applyMegaBoost(playerId);
        if (typeof kanjiEffects !== 'undefined') {
          kanjiEffects.showKanji('power', playerId);
        }
        break;
        
      case 'freezeOpponents':
        this.freezeOpponents(playerId);
        break;
        
      case 'instantForward':
        this.instantForward(playerId);
        if (typeof kanjiEffects !== 'undefined') {
          kanjiEffects.showKanji('boost', playerId);
        }
        break;
        
      default:
        console.warn('Unknown power-up effect:', type.effect);
    }
    
    this.playPowerUpSound('activate');
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }
  },




  freezeOpponents: function(playerId) {
  const collector = gameState.players[playerId];
  
  Object.keys(gameState.players).forEach(pid => {
    if (pid != playerId) {
      const target = gameState.players[pid];
      const runner = document.getElementById('runner' + pid);
      
      if (runner) {
        // Visual freeze effect
        runner.style.filter = 'brightness(0.5) blur(2px)';
        runner.classList.add('frozen');
        
        if (!playerStates[pid]) playerStates[pid] = {};
        playerStates[pid].tapsBlocked = true;
        
        // Show ice effect
        const iceEffect = document.createElement('div');
        iceEffect.textContent = '❄️ FROZEN!';
        iceEffect.style.cssText = `
          position: absolute;
          top: -30px;
          left: 50%;
          transform: translateX(-50%);
          color: #00FFFF;
          font-size: 12px;
          font-weight: bold;
          text-shadow: 2px 2px 0 #000;
          z-index: 100;
          animation: freezeText 2.5s ease-out forwards;
        `;
        runner.appendChild(iceEffect);
        
        setTimeout(() => iceEffect.remove(), 2500);
      }
      
      setTimeout(() => {
        if (runner) {
          runner.style.filter = '';
          runner.classList.remove('frozen');
        }
        if (playerStates[pid]) playerStates[pid].tapsBlocked = false;
      }, 2500);
    }
  });
  
  if (typeof kanjiEffects !== 'undefined') {
    kanjiEffects.showKanji('slow'); // Shows globally
  }
},

  applySpeedBoost: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('speed-boost');
      setTimeout(() => runner.classList.remove('speed-boost'), 3000);
    }
    
    let tapCount = 0;
    const boostInterval = setInterval(() => {
      if (tapCount >= 8 || !gameState.raceStarted || gameState.finishTimes[playerId]) {
        clearInterval(boostInterval);
        return;
      }
      socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      tapCount++;
    }, 200);
  },

  applyMegaBoost: function(playerId) {
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('mega-boost');
      setTimeout(() => runner.classList.remove('mega-boost'), 4000);
    }
    
    let tapCount = 0;
    const boostInterval = setInterval(() => {
      if (tapCount >= 15 || !gameState.raceStarted || gameState.finishTimes[playerId]) {
        clearInterval(boostInterval);
        return;
      }
      socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      tapCount++;
    }, 250);
  },

  slowOpponents: function(playerId) {
    const collector = gameState.players[playerId];
    if (collector && collector.isBot) {
      Object.keys(gameState.players).forEach(pid => {
        if (pid != playerId) {
          const target = gameState.players[pid];
          if (target && target.isBot) {
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
    
    Object.keys(gameState.players).forEach(pid => {
      if (pid != playerId) {
        if (typeof defenseSystem !== 'undefined') {
          defenseSystem.initiateAttack(pid, 'soy_trap', 2000);
        } else {
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
    for (let i = 0; i < 10; i++) {
      setTimeout(() => {
        socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
      }, i * 20);
    }
  },

  createCollectionParticles: function(rect) {
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

  playPowerUpSound: function(soundType) {
    if (!audioCtx) return;
    
    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      if (soundType === 'collect') {
        oscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.15);
      }
      
      oscillator.type = 'square';
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.3, audioCtx.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
      
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.2);
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
  },

  reset: function() {
    this.playerStorage = {};
    this.spawnedPowerUps = [];
    this.nextSpawnDistance = 600;
    
    document.querySelectorAll('.power-up').forEach(el => el.remove());
    
    const container = document.getElementById('powerUpStorage');
    if (container) container.style.display = 'none';

    this.hideActivationButton(); // Add this line
  }
};

/* ------------------------------
   TRACK ELEMENTS
------------------------------ */
var trackElements = {
  obstacles: [],
  speedZones: [],
  
  createObstacle: function(type, x, lane) {
    const obstacle = document.createElement('div');
    obstacle.className = 'track-obstacle ' + type;
    obstacle.style.left = x + 'px';
    
    const laneHeight = 80;
    obstacle.style.top = (lane * laneHeight + laneHeight/2 - 16) + 'px';
    
    switch(type) {
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
    
    if (Math.random() < 0.15) {
      const x = Math.random() * (gameState.trackWidth - 200) + 100;
      const lane = Math.floor(Math.random() * 4);
      this.createObstacle('soy-spill', x, lane);
    }
    
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
    
    this.speedZones.forEach(zone => {
      const zoneRect = zone.element.getBoundingClientRect();
      if (powerUpSystem.isColliding(runnerRect, zoneRect)) {
        this.triggerSpeedZone(playerId);
        
        if (player && !player.isBot && player.socketId === socket.id) {
          this.showSpeedZoneEffect(runner);
        }
      }
    });
    
    this.obstacles.forEach(obstacle => {
      const obstacleRect = obstacle.element.getBoundingClientRect();
      if (powerUpSystem.isColliding(runnerRect, obstacleRect)) {
        this.triggerObstacle(playerId, obstacle.type);
      }
    });
  },

  triggerSpeedZone: function(playerId) {
    socket.emit('playerAction', { roomId: gameState.roomId, playerId: playerId });
  },

  triggerObstacle: function(playerId, type) {
    switch(type) {
      case 'soy-spill':
        const runner = document.getElementById('runner' + playerId);
        const player = gameState.players[playerId];
        
        if (player && player.isBot) {
          if (runner) {
            runner.classList.add('slowed');
            setTimeout(() => runner.classList.remove('slowed'), 1500);
          }
          return;
        }
        
        const isLocalPlayer = player && player.socketId === socket.id;
        
        if (runner) {
          runner.classList.add('slowed');
          
          if (isLocalPlayer && typeof kanjiEffects !== 'undefined') {
            kanjiEffects.showKanji('slow', playerId);
          }
          
          setTimeout(() => runner.classList.remove('slowed'), 1500);
        }
        break;
    }
  },

  showSpeedZoneEffect: function(runner) {
    const playerId = runner.id.replace('runner', '');
    const player = gameState.players[playerId];
    
    if (player && player.isBot) return;
    
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
   TOKYO ATMOSPHERE
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
    
    document.body.appendChild(blossom);
    setTimeout(() => blossom.remove(), 7000);
  },

  addTokyoSounds: function() {
    const tokyoSounds = {
      crowd_cheer: new Audio("sounds/tokyo_crowd.wav"),
      train_pass: new Audio("sounds/subway_train.wav"),
      ganbatte: new Audio("sounds/ganbatte_cheer.wav")
    };
    
    Object.keys(tokyoSounds).forEach(key => {
      tokyoSounds[key].volume = 0.3;
      sounds.sfx[key] = tokyoSounds[key];
    });
    
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

/* ------------------------------
   GRAPHICS / SPRITES
------------------------------ */
var gameGraphics = {
  characters: {
    1: { frames: [], loaded: false },
    2: { frames: [], loaded: false },
    3: { frames: [], loaded: false },
    4: { frames: [], loaded: false }
  },

  preloadImages: function(playerId) {
    var character = this.characters[playerId];
    if (!character || !character.frames) return;
    
    character.frames.forEach(function(frameUrl) {
      var img = new Image();
      img.src = frameUrl;
    });
  },

  loadCharacterFrames: function(characterId, frameUrls) {
    if (!this.characters[characterId]) return false;
    
    this.characters[characterId].frames = frameUrls.slice();
    this.characters[characterId].loaded = false;
    
    var loadedCount = 0;
    var totalImages = frameUrls.length;
    
    frameUrls.forEach(function(url) {
      var img = new Image();
      img.onload = function() {
        loadedCount++;
        console.log(`Loaded sprite ${loadedCount}/${totalImages}: ${url}`);
        
        if (loadedCount === totalImages) {
          gameGraphics.characters[characterId].loaded = true;
          console.log(`Character ${characterId} fully loaded`);
          gameGraphics.updateRunnerSprite(characterId);
        }
      };
      img.onerror = function() {
        console.error(`Failed to load sprite: ${url}`);
        loadedCount++;
        if (loadedCount === totalImages) {
          gameGraphics.characters[characterId].loaded = true;
          gameGraphics.updateRunnerSprite(characterId);
        }
      };
      img.src = url;
    });
    
    return true;
  },

  loadCharacter1Frames: function() {
    return this.loadCharacterFrames(1, [
      "images/tamago_nigri_1.png",
      "images/tamago_nigri_2.png",
      "images/tamago_nigri_3.png",
      "images/tamago_nigri_4.png"
    ]);
  },

  loadCharacter2Frames: function() {
    return this.loadCharacterFrames(2, [
      "images/salmon_nigiri_1.png",
      "images/salmon_nigiri_2.png",
      "images/salmon_nigiri_3.png",
      "images/salmon_nigiri_4.png"
    ]);
  },

  loadCharacter3Frames: function() {
    return this.loadCharacterFrames(3, [
      "images/maki_roll_1.png",
      "images/maki_roll_2.png",
      "images/maki_roll_3.png",
      "images/maki_roll_4.png"
    ]);
  },

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

animateSprite: function(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner || !runner.dataset.frames) {
    console.log('Cannot animate player', playerId, 'no frames');
    return;
  }
  
  var frames;
  try {
    frames = JSON.parse(runner.dataset.frames);
  } catch(e) {
    console.error('Failed to parse frames for player', playerId);
    return;
  }
  
  // Validate frames array
  if (!frames || !Array.isArray(frames) || frames.length === 0) {
    console.error('Invalid frames array for player', playerId);
    return;
  }
  
  var currentFrame = parseInt(runner.dataset.currentFrame || '0', 10);
  
  // Ensure currentFrame is valid
  if (isNaN(currentFrame) || currentFrame < 0) {
    currentFrame = 0;
  }
  
  var nextFrame = (currentFrame + 1) % frames.length;
  
  // Validate the next frame URL exists
  if (!frames[nextFrame] || typeof frames[nextFrame] !== 'string') {
    console.error('Invalid frame URL at index', nextFrame, 'for player', playerId);
    // Reset to first frame if there's an issue
    nextFrame = 0;
    if (!frames[0]) {
      console.error('Even first frame is invalid, stopping animation');
      return;
    }
  }
  
  // Only update if we have a valid URL
  var newImageUrl = frames[nextFrame];
  if (newImageUrl) {
    runner.style.backgroundImage = 'url(' + newImageUrl + ')';
    runner.dataset.currentFrame = String(nextFrame);
    
    // Ensure visibility properties are maintained
    runner.style.backgroundSize = 'cover';
    runner.style.backgroundRepeat = 'no-repeat';
    runner.style.backgroundPosition = 'center';
  }
}  // <-- ADD THIS CLOSING BRACE!
}; 

/* ------------------------------
   CONFETTI
------------------------------ */
function launchTickerTape() {
  const grandstand = document.getElementById('grandstand');
  if (!grandstand) return;

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
    tape.style.left = Math.random() * window.innerWidth + 'px';
    tape.style.top = (grandstand.offsetTop - 20) + 'px';  // Start from grandstand position
    tape.style.backgroundImage = `url(${tapes[Math.floor(Math.random() * tapes.length)]})`;
    document.body.appendChild(tape);  // Append to body instead of container

    const fallTime = 1800 + Math.random() * 1200;
    const drift = (Math.random() * 80 - 40);

    tape.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)' },
        { transform: `translate(${drift}px, ${window.innerHeight}px) rotate(${Math.random() * 360}deg)` }
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
   SOUND SYSTEM
------------------------------ */
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
    if (audioInitialized && tapBuffer && audioCtx) {
      playTapWeb();
    } else if (sounds.sfx.tap) {
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

function setupAudioOnInteraction() {
  console.log("Setting up audio initialization on user interaction...");
  
  function initAllAudio() {
    console.log("User interaction detected - initializing audio...");
    initSounds();
    initWebAudio();
  }
  
  document.addEventListener('click', initAllAudio, { once: true });
  document.addEventListener('touchstart', initAllAudio, { once: true });
  document.addEventListener('touchend', initAllAudio, { once: true });
  
  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.addEventListener('click', initAllAudio, { once: true });
  }
}

setupAudioOnInteraction();

/* ------------------------------
   CROWD SYSTEM
------------------------------ */
var crowdSystem = {
  ambientSound: null,
  cheerSounds: [],
  isInitialized: false,
  currentExcitementLevel: 0,
  
  init: function() {
    if (this.isInitialized) return;
    
    console.log("Initializing crowd atmosphere system...");
    
    this.ambientSound = new Audio("sounds/crowd_ambient.mp3");
    this.ambientSound.loop = true;
    this.ambientSound.volume = 0;
    this.ambientSound.preload = 'auto';
    
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
  
  startAmbience: function() {
    if (!this.isInitialized) this.init();
    
    try {
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
  
  stopAmbience: function(fadeTime = 1000) {
    if (!this.ambientSound) return;
    
    this.fadeVolume(this.ambientSound, 0, fadeTime, () => {
      this.ambientSound.pause();
    });
  },
  
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
  
  playCheer: function(volume = 0.6) {
    if (!this.isInitialized || this.cheerSounds.length === 0) return;
    
    try {
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
  
  onRaceStart: function() {
    this.startAmbience();
    setTimeout(() => {
      this.playCheer(0.7);
    }, 1000);
  },
  
  onOvertake: function(playerId) {
    this.playCheer(0.5);
    this.raiseExcitement(10);
  },
  
  onPowerUp: function(playerId) {
    this.playCheer(0.4);
  },
  
  onPlayerFinish: function(playerId, position, timeDifference) {
    const baseVolume = 0.8;
    
    if (position === 1) {
      this.playVictoryRoar();
    } else if (timeDifference < 1.0) {
      this.playCheer(baseVolume);
    } else if (timeDifference < 3.0) {
      this.playCheer(baseVolume * 0.7);
    } else {
      this.playCheer(baseVolume * 0.4);
    }
  },
  
  playVictoryRoar: function() {
    console.log("Victory roar!");
    
    this.fadeVolume(this.ambientSound, 0.5, 500);
    
    setTimeout(() => this.playCheer(0.9), 0);
    setTimeout(() => this.playCheer(0.8), 200);
    setTimeout(() => this.playCheer(0.7), 400);
    
    setTimeout(() => {
      this.fadeVolume(this.ambientSound, 0.25, 2000);
    }, 2000);
  },
  
  raiseExcitement: function(amount) {
    this.currentExcitementLevel = Math.min(100, this.currentExcitementLevel + amount);
    
    if (this.ambientSound && !this.ambientSound.paused) {
      const targetVolume = 0.25 + (this.currentExcitementLevel / 100) * 0.25;
      this.fadeVolume(this.ambientSound, targetVolume, 500);
    }
    
    setTimeout(() => {
      this.currentExcitementLevel = Math.max(0, this.currentExcitementLevel - amount);
    }, 3000);
  },
  
  onCloseRacing: function(playerPositions) {
    const positions = Object.values(playerPositions);
    if (positions.length < 2) return;
    
    const sorted = positions.sort((a, b) => b - a);
    const leadGap = sorted[0] - sorted[1];
    
    if (leadGap < 50) {
      this.raiseExcitement(5);
    }
  },
  
  reset: function() {
    this.currentExcitementLevel = 0;
    this.stopAmbience(500);
  }
};

/* ------------------------------
   CAMERA
------------------------------ */
var cameraState = {
  cameraOffset: 0
};

/* ------------------------------
   FINISH LINE
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
  var finishLineOffset = isMobile ? 150 : 200;
  var trackWidth = track.offsetWidth || gameState.trackWidth || 1500;
  var startPadding = 20;
  var finishX = trackWidth - finishLineOffset - startPadding;
  fl.style.left = (finishX > 0 ? finishX : 0) + 'px';
}

/* ------------------------------
   SCROLL LOCK
------------------------------ */
function lockScroll(shouldLock) {
  document.body.classList.toggle('no-scroll', !!shouldLock);
}

/* ------------------------------
   UI RESET
------------------------------ */
function resetAllUIElements() {
  console.log('Resetting all UI elements...');
  
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

  var track = document.getElementById('track');
  if (track) {
    track.classList.remove('active');
    track.style.display = 'block';
    track.style.transform = 'translateX(0px)';
    track.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect, .track-obstacle, .speed-zone, .power-up, .confetti-tape').forEach(el => el.remove());
  }

  if (typeof powerUpSystem !== 'undefined') {
    powerUpSystem.reset();
  }

  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active');
    container.style.display = 'block';
    container.style.transform = 'translateX(0px)';
  }

  if (typeof cameraState !== 'undefined') {
    cameraState.cameraOffset = 0;
  }

  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);
    
    if (lane) lane.style.display = 'none';
    
    if (runner) {
      runner.style.left = '20px';
      runner.classList.remove('running', 'active', 'winner', 'bot-runner', 'speed-boost', 'slowed', 'shielded');
      runner.style.filter = '';

            // ✅ ADD THESE LINES - Clear all sprite data and images
      runner.style.backgroundImage = '';
      runner.innerHTML = '';
      runner.textContent = '';
      delete runner.dataset.frames;
      delete runner.dataset.currentFrame;
      runner._stopTimer = null;

    }
    
    if (nameLabel) {
      nameLabel.textContent = '';
      nameLabel.style.opacity = '1';
    }
  }

    // ✅ ADD THIS - Force sprite reload flag
  Object.keys(gameGraphics.characters).forEach(charId => {
    if (gameGraphics.characters[charId]) {
      gameGraphics.characters[charId].loaded = false;
    }
  });

  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.positions = {};
  gameState.speeds = {};
  gameState.finishTimes = {};
  gameState.countdownActive = false;
  gameState.isResetting = false;
  playerStates = {};

  lockScroll(true);
  ensureFinishLine();
  gameGraphics.loadAllSushiCharacters();

  var lobby = document.getElementById('lobby');
  if (lobby) {
    lobby.style.display = 'flex';
  }

  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Game';
  }

  var startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.style.display = 'none';

  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '';
  
  var counterEl = document.getElementById('playerCounter');
  if (counterEl) counterEl.textContent = 'Players joined: 0/4';

  console.log('UI reset complete - waiting for new players');
}

/* ------------------------------
   INITIALIZE
------------------------------ */
function initGame() {
  document.addEventListener('click', function(){ initSounds(); initWebAudio(); }, { once: true });
  document.addEventListener('touchstart', function(){ initSounds(); initWebAudio(); }, { once: true });

  console.log('Loading sushi character sprites...');
  gameGraphics.loadAllSushiCharacters();

  function initEnhancedFeatures() {
    tokyoAtmosphere.startCherryBlossoms();
    console.log('Enhanced Sushi Sprint features initialized!');
  }

  initEnhancedFeatures();
  setupKeyboardControls();

  if (eventListenersSetup) return;
  eventListenersSetup = true;

  if (typeof crowdSystem !== 'undefined') {
    crowdSystem.init();
  }

  var raceLengthPx = isMobileDevice() ? 8000 : 12000;
  var track = document.getElementById('track');
  if (track) {
    track.style.width = raceLengthPx + 'px';
    gameState.trackWidth = raceLengthPx;
    ensureFinishLine();
  } else {
    gameState.trackWidth = Math.max(window.innerWidth - 60, 300);
  }

  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active');
    container.style.overflow = 'hidden';
    container.style.position = 'relative';
  }

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

  var loading = document.getElementById('loadingScreen');
  if (loading) {
    loading.style.opacity = '0';
    setTimeout(function(){ loading.style.display = 'none'; }, 400);
  }
  var lobby = document.getElementById('lobby');
  if (lobby) lobby.style.display = 'block';
  lockScroll(true);

  var bg = document.getElementById('bgMusic');
  if (bg) {
    bg.volume = 0.35;
    bg.dataset.autoplay = '1';
    
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

  if (!gameState.roomId) socket.emit('quickRace');
}

/* ------------------------------
   SOCKET EVENTS
------------------------------ */
socket.on('connect', function(){
  console.log('Connected to server');
});

socket.on('disconnect', function(){
  console.log('Disconnected from server');
});

socket.on('resetStarting', function() {
  console.log("Reset starting - clearing local state");
  
  gameState.isResetting = true;
  gameState.countdownActive = false;
  gameLoopRunning = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }
});

socket.on('playerChangedLane', ({ playerId, lane }) => {
  laneSystem.playerLanes[playerId] = lane;
  laneSystem.updateRunnerLane(playerId, lane);
});

socket.on('roomAssigned', function (data) {
  if (!data) return;
  gameState.roomId = data.roomId;
  console.log('Assigned to room:', data.roomId);
});

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

  var playerList = document.getElementById('playerList');
  if (playerList) {
    playerList.innerHTML = '';
    Object.keys(gameState.players).forEach(function(pid) {
      var player = gameState.players[pid];
      var div = document.createElement('div');
      div.className = 'player-entry';

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
      label.textContent = player.name.toUpperCase() + (player.isBot ? ' [BOT]' : '');

      div.appendChild(avatar);
      div.appendChild(label);
      playerList.appendChild(div);
    });

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
      startBtn.style.display = 'none';
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

socket.on('resetRoom', (data) => {
  console.log('Reset room event received from server', data);
  
  resetAllUIElements();

  gameState.players     = {};
  gameState.positions   = {};
  gameState.speeds      = {};
  gameState.finishTimes = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.roomId = null;
  
  socket.emit('quickRace');
  
  console.log('Local reset complete, requested new room');
});

socket.on('updateState', function (data) {
  if (gameState.isResetting || gameState.raceFinished) return;
  
  if (data && data.positions) {
    for (var k in data.positions) {
      var serverPos = data.positions[k];
      var localPos = gameState.positions[k] || 20;
      
      if (Math.abs(serverPos - localPos) > 5) {
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

socket.on('startAnimation', function({ playerId }) {
  startRunnerAnimation(playerId);
});
socket.on('stopAnimation', function({ playerId }) {
  stopRunnerAnimation(playerId);
});

socket.on('endRace', (data) => {
  if (gameState.isResetting || gameState.raceFinished) return;

  console.log("EndRace payload:", data);

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

  setTimeout(function() {
    showResults();
  }, 500);
});

socket.on('roomReset', function(data) {
  console.log("Room reset confirmed by server", data);
  
  gameState.isResetting = false;
  gameState.roomId = null;
  gameState.players = {};
  gameState.positions = {};
  gameState.speeds = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.finishTimes = {};
  playerStates = {};

  resetAllUIElements();
  
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Game';
  }

  var startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.style.display = 'none';

  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '';
  
  var counterEl = document.getElementById('playerCounter');
  if (counterEl) counterEl.textContent = 'Players joined: 0/4';

  var lobby = document.getElementById('lobby');
  if (lobby) lobby.style.display = 'block';
  
  console.log("Reset complete - ready for new game");
});

/* ------------------------------
   LAYOUT / SETUP
------------------------------ */
function setupLanes() {
  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);

    if (gameState.players[i]) {
      laneSystem.initPlayer(i);
      laneSystem.updateRunnerLane(i, i);
      
      if (lane) lane.style.display = 'flex';
      if (runner) {
        var startPos = 20;
        var pos = (typeof gameState.positions[i] === 'number') ? gameState.positions[i] : startPos;
        runner.style.left = pos + 'px';
        runner.classList.add('active');
        
        if (gameState.players[i].isBot) {
          runner.classList.add('bot-runner');
        }

        // Clear and reload sprite
        runner.style.backgroundImage = '';
        delete runner.dataset.frames;
        delete runner.dataset.currentFrame;
        
        // Force reload sprite
        (function(pid, runnerEl) {
          setTimeout(function() {
            var character = gameGraphics.characters[pid];
            if (character && character.frames && character.frames.length > 0) {
              runnerEl.dataset.frames = JSON.stringify(character.frames);
              runnerEl.dataset.currentFrame = '0';
              runnerEl.style.backgroundImage = 'url(' + character.frames[0] + ')';
              runnerEl.style.backgroundSize = 'cover';
              runnerEl.style.backgroundRepeat = 'no-repeat';
              runnerEl.style.width = '32px';
              runnerEl.style.height = '32px';
              console.log('Sprite reloaded for player', pid);
            }
          }, 200);
        })(i, runner);

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
        
        // ✅ ADD THIS - Position name label in same lane as runner
        var laneHeight = 80;
        var topPosition = (i - 1) * laneHeight + 2; // 2px from lane top
        nameLabel.style.top = topPosition + 'px';
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
   ANIMATION CONTROL
------------------------------ */
function startRunnerAnimation(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  if (!playerStates[playerId]) {
    playerStates[playerId] = { animationInterval: null, isRunning: false, lastTap: Date.now() };
  }
  
  // Don't restart if already running
  if (playerStates[playerId].isRunning) return;

  runner.classList.add('running');
  playerStates[playerId].isRunning = true;

  var character = gameGraphics.characters[playerId];
  
  // Only set up frames if they aren't already set
  if (character && character.loaded && character.frames && character.frames.length > 0) {
    if (!runner.dataset.frames) {
      runner.dataset.frames = JSON.stringify(character.frames);
      runner.dataset.currentFrame = '0';
    }
    
    // Always ensure we have a valid background image
    if (!runner.style.backgroundImage || runner.style.backgroundImage === 'none') {
      runner.style.backgroundImage = 'url(' + character.frames[0] + ')';
    }
    
    // Ensure background properties are set
    runner.style.backgroundSize = 'cover';
    runner.style.backgroundRepeat = 'no-repeat';
    runner.style.backgroundPosition = 'center';
    runner.style.width = '32px';
    runner.style.height = '32px';
  }

  // Only start interval if we have frames and it's not already running
  if (runner.dataset.frames && !playerStates[playerId].animationInterval) {
    playerStates[playerId].animationInterval = setInterval(function () {
      if (playerStates[playerId] && playerStates[playerId].isRunning) {
        gameGraphics.animateSprite(playerId);
      }
    }, 100); // Slightly slower animation for stability
  }
}

function stopRunnerAnimation(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner) return;

  var lastTap = playerStates[playerId] ? (playerStates[playerId].lastTap || 0) : 0;
  if (Date.now() - lastTap < 280) return;

  runner.classList.remove('running');
  if (playerStates[playerId]) {
    playerStates[playerId].isRunning = false;
    if (playerStates[playerId].animationInterval) {
      clearInterval(playerStates[playerId].animationInterval);
      playerStates[playerId].animationInterval = null;
    }
  }
  
  // Reset to first frame but keep the sprite visible
  if (runner.dataset.frames) {
    try {
      var frames = JSON.parse(runner.dataset.frames);
      if (frames && frames[0]) {
        runner.style.backgroundImage = 'url(' + frames[0] + ')';
        runner.dataset.currentFrame = '0';
      }
    } catch(e) {
      console.error('Failed to reset sprite to first frame:', e);
    }
  }
}

function spawnDust(playerId) {
  var runner = document.getElementById('runner' + playerId);
  if (!runner || !runner.parentElement) return;

  const dust = document.createElement('div');
  dust.className = 'dust';
  dust.textContent = '💨';
  dust.style.left = (runner.offsetLeft - 12) + 'px';
  dust.style.top = (runner.offsetTop + runner.offsetHeight - 17) + 'px';
  runner.parentElement.appendChild(dust);
  setTimeout(function(){ dust.remove(); }, 420);
  
  // Add sparkles randomly
  if (Math.random() < 0.3) {
    const sparkle = document.createElement('div');
    sparkle.textContent = '✨';
    sparkle.style.cssText = `
      position: absolute;
      left: ${runner.offsetLeft + Math.random() * 20}px;
      top: ${runner.offsetTop + Math.random() * 20}px;
      font-size: 16px;
      animation: sparkleFloat 0.8s ease-out forwards;
      pointer-events: none;
      z-index: 50;
    `;
    runner.parentElement.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 800);
  }
}

/* ------------------------------
   COUNTDOWN / TIMER / GAMELOOP
------------------------------ */
function startCountdown() {
  if (gameState.isResetting) return;
  gameState.countdownActive = true;
  var count = 3;
  var countdownEl = document.getElementById('countdown');
  if (!countdownEl) return;
  
const tips = {
  3: "TAP LEFT & RIGHT TO SPRINT",
  2: "TAP ABOVE/BELOW TO CHANGE LANES",
  1: "FASTEST TAPPER WINS!"
};
  
  countdownEl.style.display = 'block';
  countdownEl.innerHTML = `
    <div style="font-size: 3.2rem;">${count}</div>
    <div style="font-size: 1rem; margin-top: 10px; color: #FFD700;">${tips[count]}</div>
  `;
  
  var interval = setInterval(function () {
    if (gameState.isResetting) {
      clearInterval(interval);
      countdownEl.style.display = 'none';
      gameState.countdownActive = false;
      return;
    }
    count--;
    if (count > 0) {
      countdownEl.innerHTML = `
        <div style="font-size: 3.2rem;">${count}</div>
        <div style="font-size: 1rem; margin-top: 10px; color: #FFD700;">${tips[count]}</div>
      `;
      
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      
      if (sounds.initialized) sounds.playCountdown();
    } else if (count === 0) {
      countdownEl.style.display = 'none';
      // rest of your existing GO! logic
      
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      
      if (sounds.initialized) sounds.playGo();
      
      if (typeof kanjiEffects !== 'undefined') {
        kanjiEffects.showKanji('start');
      }
      
      if (Math.random() < 0.1 && typeof crowdSystem !== 'undefined') {
        crowdSystem.onCloseRacing(gameState.positions);
      }
      
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
  
  if (Math.random() < 0.1) {
    if (typeof powerUpSystem !== 'undefined') {
      powerUpSystem.spawnFixedPowerUps();
    }
    if (typeof trackElements !== 'undefined') {
      trackElements.spawnRandomElements();
    }
  }
  
  for (var pid in gameState.players) checkFinish(pid);
  requestAnimationFrame(gameLoop);
}

/* ------------------------------
   CORE UPDATE + CAMERA
------------------------------ */
function updateGame() {
  if (gameState.isResetting) return;
  var leadingPlayerPosition = 0;
  var leadingPlayerId = null;
  
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
  
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var grandstand = document.getElementById('grandstand');
  if (!track || !container || leadingPlayerId === null) return;

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
      var screenOffset = container.offsetWidth * 0.2;
      var currentRunnerX = myRunner.offsetLeft;
      var newOffset = Math.max(0, currentRunnerX - screenOffset);
      cameraState.cameraOffset = Math.min(newOffset, gameState.trackWidth - container.offsetWidth);
    }
  }
  
  track.style.transform = 'translateX(-' + cameraState.cameraOffset + 'px)';
  
  if (grandstand) {
    var parallaxOffset = cameraState.cameraOffset * 0.5;
    grandstand.style.backgroundPositionX = '-' + parallaxOffset + 'px';
  }

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
   FINISH & RESULTS
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

    var runner = document.getElementById('runner' + playerId);
    if (runner) stopRunnerAnimation(playerId);

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
  if (typeof powerUpSystem !== 'undefined') {
    powerUpSystem.hideActivationButton();
  }

  var mobileControls = document.getElementById('mobileControls');
  var track = document.getElementById('track');
  var results = document.getElementById('results');
  var statusBar = document.getElementById('statusBar');
  var grandstand = document.getElementById('grandstand');
  var container = document.querySelector('.track-container');

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

  if (results) {
    results.classList.add('active');
    results.style.display = 'flex';
  }

  var screen = document.getElementById('screen');
  if (screen) screen.scrollTop = 0;
  window.scrollTo(0, 0);

  var leaderboard = document.getElementById('leaderboard');
  if (!leaderboard) {
    console.error('Leaderboard element not found!');
    return;
  }
  
  leaderboard.innerHTML = '';

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

  var medals = ['🥇','🥈','🥉','🏅'];
  sorted.forEach(function(r, index){
    var row = document.createElement('div');
    row.className = 'result-item';
    row.innerHTML = '<span>' + (medals[index] || '🏅') + ' ' + (index+1) + '. ' + 
                    r.name.toUpperCase() + '</span> <span>' + r.time.toFixed(3) + 's</span>';
    leaderboard.appendChild(row);
  });

  var winner = sorted[0];
  if (winner) {
    var winnerRunner = document.getElementById('runner' + winner.playerId);
    if (winnerRunner) winnerRunner.classList.add('winner');
    if (sounds.initialized) sounds.playVictory();
    if (typeof kanjiEffects !== 'undefined') {
      kanjiEffects.showKanji('victory');
    }
  }

  // === NEW: show winner's flag in the Results header ===
  (function showWinnerFlag(){
    try {
      if (!winner) return;
      var hideFlags = (localStorage.getItem('sushiHideFlags') === '1');
      var header = results ? results.querySelector('h2') : null;
      if (!header) return;

      // tiny safe helper (uses global isoToFlagEmoji if present)
      function flagEmojiSafe(cc) {
        cc = (cc || 'UN').toUpperCase();
        if (typeof window !== 'undefined' && typeof window.isoToFlagEmoji === 'function') {
          return window.isoToFlagEmoji(cc) || '🇺🇳';
        }
        if (!/^[A-Z]{2}$/.test(cc)) return '🇺🇳';
        var A = 0x1F1E6;
        return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65));
      }

      var wPlayer = gameState.players[winner.playerId] || {};
      var cc = (wPlayer.country || 'UN').toUpperCase();
      var flag = hideFlags ? '' : flagEmojiSafe(cc);

      // insert or update
      var existing = document.getElementById('winnerFlagEmoji');
      if (!existing) {
        var span = document.createElement('div');
        span.id = 'winnerFlagEmoji';
        span.style.fontSize = '2.2rem';
        span.style.marginBottom = '.25rem';
        span.style.lineHeight = '1';
        span.textContent = flag || '🇺🇳';
        header.prepend(span); // show flag above the 🏆
      } else {
        existing.textContent = flag || '🇺🇳';
      }
    } catch (e) {
      console.warn('Winner flag render failed:', e);
    }
  })();
}

/* ------------------------------
   RESET
------------------------------ */
function resetGame() {
  if (gameState.isResetting) {
    console.log('Reset already in progress, ignoring duplicate call');
    return;
  }
  
  console.log("Initiating game reset...");
  gameState.isResetting = true;
  
  if (typeof trackElements !== 'undefined') trackElements.clearElements();
  if (typeof powerUpSystem !== 'undefined') powerUpSystem.activePowerUps = {};
  document.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect').forEach(el => el.remove());

  if (typeof powerUpSystem !== 'undefined') {
    powerUpSystem.reset();
  }
  
  gameState.countdownActive = false;
  gameLoopRunning = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (typeof crowdSystem !== 'undefined') {
    crowdSystem.reset();
  }
  
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }
  
  socket.emit('resetRoom', gameState.roomId);
  
  console.log("Reset request sent to server");
}

/* ------------------------------
   LOBBY HELPERS
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
   JOIN ROOM
------------------------------ */
/* ------------------------------
   JOIN ROOM
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

  var slot = null;
  for (var i = 1; i <= 4; i++) {
    if (!gameState.players[i]) { slot = i; break; }
  }
  if (!slot) { alert('All runner slots are taken!'); return; }

  // Read and sanitize the selected country code
  var cc = (localStorage.getItem('sushiCountry') || '').toUpperCase();
  if (cc && !/^[A-Z]{2}$/.test(cc)) cc = ''; // safety

  // Emit ONCE, including countryCode
  socket.emit('joinRoom', {
    roomId: gameState.roomId,
    playerNum: slot,
    countryCode: cc
  });

  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.style.display = 'none';
}


/* ------------------------------
   UTILITIES
------------------------------ */
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && /MacIntel/.test(navigator.platform));
}

window.addEventListener('resize', function () {
  var raceLengthPx = isMobileDevice() ? 8000 : 12000;
  var trackElement = document.getElementById('track');
  if (trackElement) {
    trackElement.style.width = raceLengthPx + 'px';
    gameState.trackWidth = raceLengthPx;
  } else {
    gameState.trackWidth = Math.max(window.innerWidth - 60, 300);
  }
  ensureFinishLine();
});

document.addEventListener('DOMContentLoaded', initGame);
window.addEventListener('load', initGame);

window.gameState = gameState;
window.playerStates = playerStates;
window.resetGame = resetGame;
window.gameGraphics = gameGraphics;