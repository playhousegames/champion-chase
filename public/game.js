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
  players: {}, // { [id]: { id, name, socketId } }
  raceStarted: false,
  raceFinished: false,
  startTime: null,
  finishTimes: {},
  trackWidth: 1500,
  roomId: null, // assigned by server via quickRace / roomAssigned
  positions: {}, // { [id]: x }
  speeds: {}, // { [id]: speed }
  isResetting: false,
  countdownActive: false
};
var playerStates = {}; // local per-runner (animation interval, lastTap, etc.)
var timerInterval = null;
var gameLoopRunning = false;
var eventListenersSetup = false;

// --- Player ID cache (add this near your other global vars) ---
gameState.myId = null;

// Add this function near the top of game.js (after playerStates definition)
function getMyPlayerId() {
  for (var pid in gameState.players) {
    if (gameState.players[pid] && gameState.players[pid].socketId === socket.id) {
      return pid;
    }
  }
  return null;
}
/* ------------------------------
   KANJI EFFECTS SYSTEM - FIXED UNICODE
------------------------------ */
var kanjiEffects = {
  characters: {
    speed: { kanji: '速', meaning: 'SPEED', color: '#00FF88' }, // 速 = speed
    power: { kanji: '力', meaning: 'POWER', color: '#FFD700' }, // 力 = power
    victory: { kanji: '勝', meaning: 'VICTORY', color: '#FF3366' }, // 勝 = victory
    start: { kanji: '行', meaning: 'GO!', color: '#FFFFFF' }, // 行 = go
    finish: { kanji: '完', meaning: 'FINISH', color: '#FF3366' }, // 完 = complete
    boost: { kanji: '加', meaning: 'BOOST', color: '#00FFFF' }, // 加 = add/boost
    slow: { kanji: '遅', meaning: 'SLOW', color: '#8B4513' } // 遅 = slow
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
    }, 2000); // Longer window but still resets
   
    if (combo.count % 20 === 0 && combo.count >= 20) {
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
  if (!/^[A-Z]{2}$/.test(cc)) return '🇺🇳';
  var A = 0x1F1E6;
  return String.fromCodePoint(A + (cc.charCodeAt(0) - 65), A + (cc.charCodeAt(1) - 65));
}
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
   
    document.querySelectorAll(`.lane-zone-${playerId}`).forEach(el => el.remove());
   
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

// --- Helper: render players list with flags ---
function updateLobbyPlayers(players, opts={}) {
  var playerList = document.getElementById('playerList');
  if (!playerList) return;
  playerList.innerHTML = '';
  Object.keys(players||{}).forEach(function(pid){
    var p = players[pid];
    var div = document.createElement('div');
    div.className = 'player-entry';
    if (opts.hostSocketId && p.socketId === opts.hostSocketId) div.classList.add('host');
    if (p.isBot) div.classList.add('bot-player');
    var avatar = document.createElement('img');
    avatar.style.width = '24px'; avatar.style.height = '24px'; avatar.style.imageRendering = 'pixelated';
    var upper = (p.name||'').toUpperCase();
    if (upper.includes('TAMAGO')) { avatar.src = 'images/tamago_nigri_1.png'; }
    else if (upper.includes('SALMON')) { avatar.src = 'images/salmon_nigiri_1.png'; }
    else if (upper.includes('MAKI')) { avatar.src = 'images/maki_roll_1.png'; }
    else if (upper.includes('MAGURO')) { avatar.src = 'images/tuna_sushi_1.png'; }
    else { avatar.src = 'images/maki_roll_1.png'; }
    var flagSpan = document.createElement('span');
    flagSpan.className = 'lobby-flag';
    try { flagSpan.textContent = flagEmojiSafe((p.country||'UN')); } catch(e) { flagSpan.textContent = '🏳️'; }
    var label = document.createElement('span');
    label.textContent = (p.name||'RUNNER').toUpperCase() + (p.isBot ? ' [BOT]' : '');
    div.appendChild(avatar);
    div.appendChild(flagSpan);
    div.appendChild(label);
    playerList.appendChild(div);
  });
}
/* ------------------------------
   DEFENSE + STAMINA SYSTEM
------------------------------ */
var defenseSystem = {
  activeAttacks: {},
  blockWindows: {},
  pressStates: {},
  stamina: {},
  MAX_STAMINA: 100,
  STAMINA_COST: 5,
  STAMINA_REGEN_BASE: 2,
  STAMINA_TICK_MS: 200,
  regenLoopStarted: false,
 
  initStamina: function(playerId) {
    if (!this.stamina[playerId]) this.stamina[playerId] = this.MAX_STAMINA;
    const player = gameState.players[playerId];
    if (player && !player.isBot && player.socketId === socket.id) {
      const staminaDisplay = document.getElementById('staminaDisplay');
      if (staminaDisplay) staminaDisplay.style.display = 'flex';
    }
  },
 
  initiateAttack: function(targetPlayerId, attackType, duration) {
    console.log(`Initiating attack on player ${targetPlayerId}: ${attackType}`);
 
    this.blockWindows[targetPlayerId] = {
      startTime: Date.now(),
      attackType: attackType,
      duration: 1300,
      blocked: false
    };
 
    const targetPlayer = gameState.players[targetPlayerId];
    if (targetPlayer && !targetPlayer.isBot && targetPlayer.socketId === socket.id) {
      this.showAttackWarning(targetPlayerId, attackType);
    }
 
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
    if (this.stamina[playerId] >= this.STAMINA_COST) {
      this.stamina[playerId] -= this.STAMINA_COST;
      return true;
    }
    return false;
  },
 
  startRegenLoop: function() {
    if (this.regenLoopStarted) return;
    this.regenLoopStarted = true;
    setInterval(() => {
      for (let pid in this.stamina) {
        const player = gameState.players[pid];
        if (this.stamina[pid] < this.MAX_STAMINA) {
          const regenRate = this.STAMINA_REGEN_BASE + (player && !player.isBot && player.socketId === socket.id ? 0.5 : 0);
          this.stamina[pid] = Math.min(this.MAX_STAMINA, this.stamina[pid] + regenRate);
          
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
 
  registerPress: function(playerId, side) {
    this.startRegenLoop();
    this.initStamina(playerId);
    if (!this.pressStates[playerId]) {
      this.pressStates[playerId] = { L: false, R: false, pressTime: {}, clearTimers: {} };
    }
    const now = Date.now();
    this.pressStates[playerId][side] = true;
    this.pressStates[playerId].pressTime[side] = now;
    if (this.pressStates[playerId].clearTimers[side]) {
      clearTimeout(this.pressStates[playerId].clearTimers[side]);
    }
    this.pressStates[playerId].clearTimers[side] = setTimeout(() => {
      if (this.pressStates[playerId]) {
        this.pressStates[playerId][side] = false;
        delete this.pressStates[playerId].pressTime[side];
      }
    }, 200);
    if (this.pressStates[playerId].L && this.pressStates[playerId].R) {
      const lTime = this.pressStates[playerId].pressTime.L;
      const rTime = this.pressStates[playerId].pressTime.R;
      if (lTime && rTime) {
        const timeDiff = Math.abs(lTime - rTime);
        if (timeDiff <= 120) {
          if (timeDiff <= 80) {
            this.checkSimultaneousPress(playerId, now, "perfect");
          } else {
            this.checkSimultaneousPress(playerId, now, "good");
          }
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
 
  checkSimultaneousPress: function(playerId, now, grade = "fail") {
    if (grade === "fail") return;
    console.log(`checkSimultaneousPress for player ${playerId}, grade: ${grade}`);
    const hasActiveAttack = this.blockWindows[playerId];
 
    if (hasActiveAttack) {
      console.log('→ Active attack detected, attempting block...');
      if (this.attemptBlock(playerId, now, grade)) {
        console.log('→ Block successful!');
        return;
      }
      console.log('→ Block attempt failed');
    }
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
 
  if (side && typeof defenseSystem !== 'undefined') {
    defenseSystem.registerPress(playerId, side);
  }
  btn.classList.add('pressed');
}
function tapRelease(e, playerId, btn) {
  e.preventDefault();
  e.stopPropagation();
  if (btn) btn.classList.remove('pressed', 'active');
  if (gameState.countdownActive) return;
  const side = btn ? btn.getAttribute('data-side') : null;
  var runner = document.getElementById('runner' + playerId);
 
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
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
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
        return;
      }
    }
   
    if (playerStates[myPlayerId] && playerStates[myPlayerId].tapsBlocked) {
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
   POWER-UP SYSTEM - FIXED FOR IMAGE GRAPHICS
------------------------------ */
var powerUpSystem = {
  types: {
    WASABI_RUSH: {
      id: 'wasabi',
      name: 'WASABI RUSH',
      color: '#00FF88',
      iconClass: 'powerup-icon-wasabi',
      kanji: '速',
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
      kanji: '氷',
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
      kanji: '瞬',
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
      kanji: '超',
      kanjiMeaning: 'SUPER',
      duration: 4000,
      effect: 'megaBoost',
      description: 'SUPER SPEED'
    }
  },
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
 
    // ✅ FIXED: Add both base class and specific type class
    const iconDiv = document.createElement('div');
    iconDiv.className = 'powerup-icon ' + type.iconClass;
    // ✅ FIXED: Don't override display/size - let CSS handle it
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
 
    btn.innerHTML = '';
 
    // ✅ FIXED: Add both base class and specific type class
    const iconDiv = document.createElement('div');
    iconDiv.className = 'powerup-icon ' + type.iconClass;
    iconDiv.style.cssText = `
      width: 48px;
      height: 48px;
      transform: scale(1.5);
    `;
    btn.appendChild(iconDiv);
 
    btn.style.display = 'flex';
 
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
 
    if (btn._clickHandler) {
      btn.removeEventListener('click', btn._clickHandler);
      btn.removeEventListener('touchstart', btn._clickHandler);
    }
 
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
  },
 
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
  if (!runner) return;

  // Make runner a positioning context and allow out-of-bounds children
  const cs = getComputedStyle(runner);
  if (cs.position === 'static') runner.style.position = 'relative';
  runner.style.overflow = 'visible';

  let icon = runner.querySelector('.stored-icon');
  if (!icon) {
    icon = document.createElement('div');
    icon.className = 'stored-icon';
    runner.appendChild(icon);
  }

  // Base classes (animation class optional)
  icon.className = 'powerup-icon stored-icon pop-in ' + (type.iconClass || '');

  // Position/visuals
  icon.style.cssText = `
    position:absolute;
    top:-35px;                /* raise above head */
    left:50%;
    transform:translateX(-50%);
    width:32px;height:32px;
    z-index:10000;
    background-size:contain;background-repeat:no-repeat;background-position:center;
    border:2px solid ${type.color};
    border-radius:4px;
    background-color:rgba(0,0,0,0.8);
    box-shadow:0 0 10px ${type.color};
    pointer-events:none;
    animation:powerupPop 0.6s ease-out;
  `;

  /* 🧠 === HUD overlap protection === */
  try {
    const status = document.getElementById('statusBar');
    const safeBottom = status ? status.getBoundingClientRect().bottom : 0; // HUD bottom in px
    const r = runner.getBoundingClientRect();
    let offset = -35; // default above head
    const iconTopInViewport = r.top + offset;
    const margin = 6;
    if (iconTopInViewport < safeBottom + margin) {
      const delta = (safeBottom + margin) - iconTopInViewport;
      offset += delta; // push down just enough
      icon.style.top = `${offset}px`;
    }
  } catch (e) {
    console.warn('Power-up icon offset adjustment failed:', e);
  }
  /* 🧠 === End HUD protection === */

  // ----- Sprite fallback for Safari / timing hiccups -----
  if (type.iconUrl) {
    icon.style.backgroundImage = `url("${type.iconUrl}")`;
  } else {
    const FRAME = {
      'powerup-icon-dash'  : 'images/powerup_dash_1.png',
      'powerup-icon-wasabi': 'images/powerup_wasabi_1.png',
      'powerup-icon-mega'  : 'images/powerup_mega_1.png',
      'powerup-icon-freeze': 'images/powerup_freeze_1.png',
    };
    requestAnimationFrame(() => {
      const bg = getComputedStyle(icon).backgroundImage;
      if (!bg || bg === 'none') {
        const frame = FRAME[type.iconClass];
        if (frame) icon.style.backgroundImage = `url("${frame}")`;
      }
    });
  }

  // UI for the local human
  if (!player.isBot && player.socketId === socket.id) {
    this.showActivationButton(playerId, type);
    this.showCollectionFeedback(type);
  }
},




 
  activateStoredPowerUp: function(playerId) {
    console.log('🎮 ACTIVATE CALLED for player', playerId);
 
    const type = this.playerStorage[playerId];
    console.log('🎮 Type found:', type);
 
    if (!type) {
      console.warn('No stored power-up for player', playerId);
      return;
    }
 
    this.showActivationFeedback(type.name, type.color, type);
 
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
    
    // ✅ IMPROVED: Show animated icon in feedback
    const iconHTML = `<div class="powerup-icon ${type.iconClass}" style="width:32px;height:32px;margin:0 auto 8px;"></div>`;
    
    feedback.innerHTML = `
      ${iconHTML}
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
 
    // ✅ IMPROVED: Use animated icon in activation feedback
    const iconHTML = type.iconClass
      ? `<div class="powerup-icon ${type.iconClass}" style="width:64px;height:64px;margin:0 auto 12px;transform:scale(1.8);"></div>`
      : '';
 
    const kanjiHTML = type.kanji
      ? `<div style="font-family:'Noto Sans JP',sans-serif;font-size:3.5rem;color:${color || type.color};text-shadow:4px 4px 0 #000;margin-bottom:8px;line-height:1;">${type.kanji}</div>`
      : '';
 
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
          runner.style.filter = 'brightness(0.5) blur(2px)';
          runner.classList.add('frozen');
       
          if (!playerStates[pid]) playerStates[pid] = {};
          playerStates[pid].tapsBlocked = true;
       
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
      kanjiEffects.showKanji('slow');
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
    this.hideActivationButton();
  }
};
/* ------------------------------
   TRACK ELEMENTS
------------------------------ */
var trackElements = {
  obstacles: [],
  speedZones: [],
  speedZoneCooldowns: {},

  // ===== NEW: tune burst strength here =====
  SPEEDZONE_TAPS: 8,
  SPEEDZONE_INTERVAL_MS: 60,
  SPEEDZONE_LOCAL_NUDGE: 30,

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
          width: 60px; height: 20px;
          background: rgba(139,69,19,.6);
          border-radius: 10px; font-size: 16px;
        `;
        break;
    }
    const track = document.getElementById('track');
    if (track) track.appendChild(obstacle);
    this.obstacles.push({ element: obstacle, type, x, lane });
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
        rgba(0,255,136,.3),
        rgba(0,255,136,.6),
        rgba(0,255,136,.3));
      border: 2px dashed #00FF88;
      animation: speedZonePulse 1s ease-in-out infinite;
      z-index: 1;
    `;
    const track = document.getElementById('track');
    if (track) track.appendChild(zone);
    this.speedZones.push({ element: zone, x, width, lane });
  },

  // ===== NEW: actually make speed zones do something =====
  triggerSpeedZone: function(playerId) {
    // Quick local nudge so it feels instant
    gameState.positions[playerId] = (gameState.positions[playerId] || 20) + this.SPEEDZONE_LOCAL_NUDGE;

    // Then fire a burst of server-authoritative “taps”
    let sent = 0;
    const burst = setInterval(() => {
      if (!gameState.raceStarted || gameState.finishTimes[playerId]) {
        clearInterval(burst);
        return;
      }
      socket.emit('playerAction', { roomId: gameState.roomId, playerId });
      if (++sent >= this.SPEEDZONE_TAPS) clearInterval(burst);
    }, this.SPEEDZONE_INTERVAL_MS);
  },

  // ===== NEW: tiny visual feedback on strip hit =====
  showSpeedZoneEffect: function(runnerEl) {
    if (!runnerEl) return;
    const fx = document.createElement('div');
    fx.textContent = '💨';
    fx.style.cssText =
      'position:absolute; left:-12px; top:-12px; font-size:18px; ' +
      'animation: sparkleFloat .6s ease-out forwards; pointer-events:none; z-index:100;';
    runnerEl.appendChild(fx);
    setTimeout(() => fx.remove(), 600);
    runnerEl.classList.add('speed-boost');
    setTimeout(() => runnerEl.classList.remove('speed-boost'), 400);
  },

  // ===== NEW: basic obstacle slow-down =====
  triggerObstacle: function(playerId, type) {
    const loss = 22;
    gameState.positions[playerId] = Math.max(20, (gameState.positions[playerId] || 20) - loss);
    const runner = document.getElementById('runner' + playerId);
    if (runner) {
      runner.classList.add('slowed');
      setTimeout(() => runner.classList.remove('slowed'), 500);
    }
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

    // Speed zones (with per-zone per-player cooldown)
    this.speedZones.forEach(zone => {
      const zoneRect = zone.element.getBoundingClientRect();
      const key = playerId + '_' + zone.x + '_' + zone.lane;
      if (powerUpSystem.isColliding(runnerRect, zoneRect)) {
        if (this.speedZoneCooldowns[key]) return;
        this.triggerSpeedZone(playerId);
        this.speedZoneCooldowns[key] = true;
        setTimeout(() => { delete this.speedZoneCooldowns[key]; }, 500);
        if (player && !player.isBot && player.socketId === socket.id) {
          this.showSpeedZoneEffect(runner);
        }
      }
    });

    // Obstacles (own cooldown keys)
    this.obstacles.forEach(ob => {
      const obRect = ob.element.getBoundingClientRect();
      const key = playerId + '_obstacle_' + ob.x + '_' + ob.lane;
      if (powerUpSystem.isColliding(runnerRect, obRect)) {
        if (this.speedZoneCooldowns[key]) return;
        this.triggerObstacle(playerId, ob.type);
        this.speedZoneCooldowns[key] = true;
        setTimeout(() => { delete this.speedZoneCooldowns[key]; }, 1500);
      }
    });
  },

  clearElements: function() {
    document.querySelectorAll('.track-obstacle, .speed-zone, .power-up').forEach(el => el.remove());
    this.obstacles = [];
    this.speedZones = [];
    this.speedZoneCooldowns = {};
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
        if (loadedCount === totalImages) {
          gameGraphics.characters[characterId].loaded = true;
          gameGraphics.updateRunnerSprite(characterId);
        }
      };
      img.onerror = function() {
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
 
  animateSprite: function(playerId) {
    var runner = document.getElementById('runner' + playerId);
    if (!runner || !runner.dataset.frames) return;
 
    var frames;
    try {
      frames = JSON.parse(runner.dataset.frames);
    } catch(e) {
      return;
    }
 
    if (!frames || !Array.isArray(frames) || frames.length === 0) return;
 
    var currentFrame = parseInt(runner.dataset.currentFrame || '0', 10);
 
    if (isNaN(currentFrame) || currentFrame < 0) {
      currentFrame = 0;
    }
 
    var nextFrame = (currentFrame + 1) % frames.length;
 
    if (!frames[nextFrame] || typeof frames[nextFrame] !== 'string') {
      nextFrame = 0;
      if (!frames[0]) return;
    }
 
    var newImageUrl = frames[nextFrame];
    if (newImageUrl) {
      runner.style.backgroundImage = 'url(' + newImageUrl + ')';
      runner.dataset.currentFrame = String(nextFrame);
      runner.style.backgroundSize = 'cover';
      runner.style.backgroundRepeat = 'no-repeat';
      runner.style.backgroundPosition = 'center';
    }
  }
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
    tape.style.top = (grandstand.offsetTop - 20) + 'px';
    tape.style.backgroundImage = `url(${tapes[Math.floor(Math.random() * tapes.length)]})`;
    document.body.appendChild(tape);
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
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
   
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
   
    if (!tapBuffer) {
      const response = await fetch("sounds/button_press.wav");
      if (!response.ok) throw new Error(`Failed to fetch tap sound: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      tapBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    }
   
    audioInitialized = true;
  } catch (error) {
    console.error("Web Audio initialization failed:", error);
    audioInitialized = false;
  }
}
function playTapWeb() {
  if (!tapBuffer || !audioCtx) return;
 
  try {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().then(playTapWebInternal);
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
  if (!audioCtx) return;
 
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
  if (sounds.initialized) return;
  var files = {
    countdown: "sounds/countdown.wav",
    go: "sounds/go.wav",
    tap: "sounds/button_press.wav",
    finish: "sounds/finish.wav",
    victory: pickFormat("sounds/chiptune_victory_jingle")
  };
  Object.keys(files).forEach(function(k){
    try {
      var a = new Audio(files[k]);
      a.preload = 'auto';
      a.addEventListener('canplaythrough', function() {});
      a.addEventListener('error', function(e) {});
      if (k === "victory") a.volume = 0.7;
      sounds.sfx[k] = a;
    } catch (error) {}
  });
  sounds.playCountdown = function(){
    try {
      if (sounds.sfx.countdown) {
        sounds.sfx.countdown.currentTime = 0;
        sounds.sfx.countdown.volume = 0.6;
        sounds.sfx.countdown.play().catch(err => {});
      }
    } catch(e){}
  };
  sounds.playGo = function(){
    try {
      if (sounds.sfx.go) {
        sounds.sfx.go.currentTime = 0;
        sounds.sfx.go.volume = 0.7;
        sounds.sfx.go.play().catch(err => {});
      }
    } catch(e){}
  };
  sounds.playTap = function() {
    if (audioInitialized && tapBuffer && audioCtx) {
      playTapWeb();
    } else if (sounds.sfx.tap) {
      try {
        const clone = sounds.sfx.tap.cloneNode();
        clone.volume = 0.8;
        clone.play().catch(err => {});
      } catch(e) {}
    }
  };
  sounds.playFinish = function() {
    if (sounds.sfx.finish) {
      try {
        sounds.sfx.finish.currentTime = 0;
        sounds.sfx.finish.play().catch(err => {});
      } catch (e) {}
    }
  };
  sounds.playVictory = function() {
    if (sounds.sfx.victory) {
      try {
        sounds.sfx.victory.currentTime = 0;
        sounds.sfx.victory.play().catch(err => {});
      } catch (e) {}
    }
  };
  sounds.initialized = true;
}
function setupAudioOnInteraction() {
  function initAllAudio() {
    initSounds();
    initWebAudio();
  }
 
  document.addEventListener('click', initAllAudio, { once: true });
  document.addEventListener('touchstart', initAllAudio, { once: true });
  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) joinBtn.addEventListener('click', initAllAudio, { once: true });
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

  // Get the actual track width from the element or use the game state
  var trackWidth = track.offsetWidth || gameState.trackWidth || (isMobileDevice() ? 8000 : 12000);
  
  // Update gameState if needed
  if (!gameState.trackWidth || gameState.trackWidth < trackWidth) {
    gameState.trackWidth = trackWidth;
  }
  
  var isMobile = window.innerWidth <= 480;
  var finishLineOffset = isMobile ? 150 : 200;
  var startPadding = 20;
  var finishX = trackWidth - finishLineOffset - startPadding;
  
  fl.style.left = (finishX > 0 ? finishX : trackWidth - 200) + 'px';
  fl.style.display = 'block'; // Force visible
  fl.style.opacity = '1';
  fl.style.visibility = 'visible';
  
  console.log('[FINISH LINE] Positioned at:', finishX, 'Track width:', trackWidth);
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
  console.log('[RESET] Resetting all UI elements...');

  // 🔧 Hard stop any active loops/intervals FIRST
  gameState.isResetting = true; // ensure countdown loop exits
  if (typeof gameLoopRunning !== 'undefined') gameLoopRunning = false;
  if (typeof timerInterval !== 'undefined' && timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  // stop all runner sprite intervals
  if (typeof playerStates === 'object' && playerStates) {
    Object.keys(playerStates).forEach(pid => {
      const ps = playerStates[pid];
      if (ps && ps.animationInterval) {
        clearInterval(ps.animationInterval);
        ps.animationInterval = null;
      }
    });
  }
  // optional: quiet ambient/crowd
  if (typeof crowdSystem !== 'undefined' && crowdSystem && typeof crowdSystem.reset === 'function') {
    crowdSystem.reset();
  }

  // ✅ Hide all game UI elements
  var elements = [
    { id: 'statusBar', action: el => { el.classList.remove('active'); el.style.display = 'none'; } },
    { id: 'grandstand', action: el => { el.classList.remove('active'); el.style.display = 'none'; } },
    { id: 'mobileControls', action: el => { el.classList.remove('active'); el.style.display = 'none'; } },
    { id: 'results', action: el => { el.classList.remove('active'); el.style.display = 'none'; el.style.visibility = 'hidden'; } },
    { id: 'countdown', action: el => el.style.display = 'none' },
    { id: 'timer', action: el => el.textContent = '00.000' },
    { id: 'staminaDisplay', action: el => el.style.display = 'none' }
  ];
  elements.forEach(({ id, action }) => {
    var el = document.getElementById(id);
    if (el) action(el);
  });

  // Reset track
  var track = document.getElementById('track');
  if (track) {
    track.classList.remove('active');
    track.style.display = 'block';
    track.style.visibility = 'visible';
    track.style.transform = 'translateX(0px)';
    track.querySelectorAll('.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect, .track-obstacle, .speed-zone, .power-up, .confetti-tape').forEach(el => el.remove());
  }

  if (typeof powerUpSystem !== 'undefined' && powerUpSystem) {
    if (typeof powerUpSystem.reset === 'function') powerUpSystem.reset();
    if (typeof powerUpSystem.hideActivationButton === 'function') powerUpSystem.hideActivationButton();
  }

  var container = document.querySelector('.track-container');
  if (container) {
    container.classList.remove('active');
    container.style.display = 'block';
    container.style.visibility = 'visible';
    container.style.transform = 'translateX(0px)';
  }

  if (typeof cameraState !== 'undefined') {
    cameraState.cameraOffset = 0;
  }

  // Reset all runners
  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);

    if (lane) lane.style.display = 'none';

    if (runner) {
      runner.style.left = '20px';
      runner.classList.remove('running', 'active', 'winner', 'bot-runner', 'speed-boost', 'slowed', 'shielded','frozen');
      runner.style.filter = '';
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

  // lobby countdown cleanup
  var lc = document.getElementById('lobbyCountdown');
  var ct = document.getElementById('countdownTimer');
  if (lc) { lc.classList.remove('active','final3','go'); delete lc.dataset.lastTick; }
  if (ct) ct.textContent = '';

  // Force sprite reload next time
  if (window.gameGraphics && gameGraphics.characters) {
    Object.keys(gameGraphics.characters).forEach(charId => {
      if (gameGraphics.characters[charId]) gameGraphics.characters[charId].loaded = false;
    });
  }

  // 🔧 Reset state last, then clear the resetting flag
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.positions = {};
  gameState.speeds = {};
  gameState.finishTimes = {};
  gameState.countdownActive = false;
  // (optional) gameState.roomId = null; // only if you truly want to leave the room here
  playerStates = {};

  lockScroll(true);
  ensureFinishLine();
  gameGraphics.loadAllSushiCharacters();

  // Show lobby & restore join button
  var lobby = document.getElementById('lobby');
  if (lobby) {
    lobby.classList.add('active');
    lobby.style.display = 'block';
    lobby.style.visibility = 'visible';
    lobby.style.opacity = '1';
  }

  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Game';
    joinBtn.style.pointerEvents = 'auto';
    joinBtn.style.opacity = '1';
  }

  // ✅ Ensure country selector is enabled
  var countrySelect = document.getElementById('countrySelect');
  if (countrySelect) {
    countrySelect.disabled = false;
    countrySelect.style.pointerEvents = 'auto';
    countrySelect.style.opacity = '1';
  }

  var startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.style.display = 'none';

  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '';

  var counterEl = document.getElementById('playerCounter');
  if (counterEl) counterEl.textContent = 'Players joined: 0/4';

  var bgMusic = document.getElementById('bgMusic');
  if (bgMusic && bgMusic.paused) {
    bgMusic.currentTime = 0;
    bgMusic.play().catch(err => console.log('[RESET] Music play failed:', err));
  }

  gameState.isResetting = false; // finished
  console.log('[RESET] UI reset complete - ready for new players');
}


/* ------------------------------
   INITIALIZE - CLEAN VERSION
------------------------------ */
function initGame() {
  console.log('[INIT] Game initialization started');
  
  try {
    document.addEventListener('click', function(){ initSounds(); initWebAudio(); }, { once: true });
    document.addEventListener('touchstart', function(){ initSounds(); initWebAudio(); }, { once: true });
    
    console.log('[INIT] Loading sushi character sprites...');
    gameGraphics.loadAllSushiCharacters();
    
    function initEnhancedFeatures() {
      tokyoAtmosphere.startCherryBlossoms();
      console.log('[INIT] Enhanced features initialized');
    }
    initEnhancedFeatures();
    
    setupKeyboardControls();
    
    if (eventListenersSetup) {
      console.log('[INIT] Event listeners already setup');
      return;
    }
    eventListenersSetup = true;
    
    if (typeof crowdSystem !== 'undefined') {
      console.log('[INIT] Initializing crowd system...');
      crowdSystem.init();
    }

    var container = document.querySelector('.track-container');
    if (container) {
      container.style.overflow = 'visible';
      container.style.position = 'relative';
      console.log('[INIT] Track container configured');
    } else {
      console.error('[INIT] ERROR: Track container not found!');
    }
    
    // CRITICAL: Bind join button with multiple safety checks
    function bindJoinButton() {
      var joinBtn = document.getElementById('joinRoomBtn');
      if (!joinBtn) {
        console.error('[INIT] ERROR: Join button not found!');
        return false;
      }
      
      if (joinBtn._bound) {
        console.log('[INIT] Join button already bound');
        return true;
      }
      
      // Remove any existing listeners
      var newBtn = joinBtn.cloneNode(true);
      joinBtn.parentNode.replaceChild(newBtn, joinBtn);
      joinBtn = newBtn;
      
      // Add click listener
      joinBtn.addEventListener('click', function(e) {
        console.log('[BTN] Join button CLICKED');
        e.preventDefault();
        joinRoom();
      });
      
      // Also add touch listener for mobile
      joinBtn.addEventListener('touchstart', function(e) {
        console.log('[BTN] Join button TOUCHED');
        e.preventDefault();
        joinRoom();
      }, { passive: false });
      
      joinBtn._bound = true;
      joinBtn.style.display = 'inline-block';
      joinBtn.disabled = false;
      
      console.log('[INIT] Join button bound successfully');
      return true;
    }
    
    // Try binding immediately
    if (!bindJoinButton()) {
      // If button not found, try again after a short delay
      setTimeout(bindJoinButton, 100);
    }
    
    
    var loading = document.getElementById('loadingScreen');
    if (loading) {
      loading.style.opacity = '0';
      setTimeout(function(){ loading.style.display = 'none'; }, 400);
      console.log('[INIT] Loading screen hidden');
    }
    
    // CRITICAL: Ensure lobby is visible
    var lobby = document.getElementById('lobby');
    if (lobby) {
      lobby.classList.add('active');
      lobby.style.display = 'block';
      lobby.style.visibility = 'visible';
      lobby.style.opacity = '1';
      console.log('[INIT] Lobby is ACTIVE and VISIBLE');
    } else {
      console.error('[INIT] ERROR: Lobby element not found!');
    }
    
    lockScroll(true);
    
    var bg = document.getElementById('bgMusic');
    if (bg) {
      bg.volume = 0.35;
      bg.dataset.autoplay = '1';
      document.addEventListener('click', function() {
        if (bg.paused) {
          bg.play().catch(err => console.log('[AUDIO] Music play failed:', err));
        }
      }, { once: true });
    }
    
    // DON'T auto-emit quickRace - let user click join
    console.log('[INIT] Initialization complete - waiting for user to click join');
    
  } catch (e) {
    console.error('[INIT] ERROR:', e);
  }
}

// Ensure init runs when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGame);
} else {
  initGame();
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
        var flagSpan = document.createElement('span');
  flagSpan.className = 'lobby-flag';
  try { flagSpan.textContent = flagEmojiSafe((player.country || 'UN')); } catch(e) { flagSpan.textContent = '🏳️'; }
  div.appendChild(flagSpan);
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
        counterEl.textContent = `Players: ${totalPlayers}/${max} • Auto-starting...`;
      }
    }
  }

 // Start button removed - game always auto-starts
// Start button removed - game always auto-starts
  var startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.style.display = 'none';
  }
}); // ← MISSING CLOSING BRACKET FOR playerJoined handler!


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

  console.log('[GAME] Game started event received', data);

  // Hide lobby
  const lobby = document.getElementById('lobby');
  if (lobby) {
    lobby.classList.remove('active');
    lobby.style.display = 'none';
  }

  const dock = document.getElementById('lobbyDock');
  if (dock) dock.style.display = 'none';

  // ✅ STOP LOBBY MUSIC WHEN GAME STARTS
  const bgMusic = document.getElementById('bgMusic');
  if (bgMusic && !bgMusic.paused) {
    bgMusic.pause();
    bgMusic.currentTime = 0; // Reset to start
    console.log('[GAME] Stopped lobby music');
  }

  const joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.disabled = true;
    joinBtn.style.display = 'none';
  }

  // ... rest of your existing gameStarted code

  // ✅ Set track width FIRST, before anything else
  const raceLengthPx = isMobileDevice() ? 8000 : 12000;
  gameState.trackWidth = raceLengthPx;
  console.log('[GAME] Track width set to:', raceLengthPx);

  const trackElement = document.getElementById('track');
  if (trackElement) {
    trackElement.style.display   = 'block';
    trackElement.style.visibility = 'visible';
    trackElement.style.opacity    = '1';
    trackElement.style.width      = raceLengthPx + 'px'; // ✅ Set width explicitly
    trackElement.style.height     = '320px';
    trackElement.style.minHeight  = '320px';
    trackElement.classList.add('active');
    console.log('[GAME] Track element configured');
  } else {
    console.error('[GAME] ERROR: Track element not found!');
  }

  const container = document.querySelector('.track-container');
  if (container) {
    container.classList.add('active');
    container.style.display = 'block';
    container.style.visibility = 'visible';
    container.style.opacity = '1';
  }

  // Position finish line AFTER track width is set
  requestAnimationFrame(() => {
    ensureFinishLine();
    console.log('[GAME] Finish line positioned');
  });

  // Rest of initialization
  cameraState.cameraOffset = 0;
  gameState.raceStarted = true;
  gameState.raceFinished = false;
  gameState.finishTimes = {};
  if (data?.players)   gameState.players   = data.players;
  if (data?.positions) gameState.positions = data.positions;
  if (data?.speeds)    gameState.speeds    = data.speeds;
  gameState.myId = getMyPlayerId();

  // Show HUD elements
  const grandstand = document.getElementById('grandstand');
  if (grandstand) {
    grandstand.classList.add('active');
    grandstand.style.display = 'block';
  }

  const statusBar = document.getElementById('statusBar');
  if (statusBar) {
    statusBar.classList.add('active');
    statusBar.style.display = 'flex';
  }

  const mobileControls = document.getElementById('mobileControls');
  if (mobileControls) {
    mobileControls.classList.add('active');
    mobileControls.style.display = 'flex';
    setupMobileControls();
  }

  setupLanes();
  setTimeout(startCountdown, 100);
  lockScroll(false);

  console.log('[GAME] Game start complete');
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

// Replace your endRace socket handler with this:
socket.on('endRace', (data) => {
  if (gameState.isResetting) return;

  console.log('[END] EndRace received:', data);

  // Merge incoming state
  if (data && data.players) gameState.players = data.players;
  if (data && data.positions) gameState.positions = data.positions;
  if (data && data.speeds) gameState.speeds = data.speeds;
  if (data && data.finishTimes) {
    gameState.finishTimes = data.finishTimes;
  }

  // ✅ End race immediately (winner already determined)
  console.log('[END] ✅ RACE ENDED - SHOWING RESULTS!');
  
  gameState.raceFinished = true;
  gameLoopRunning = false;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // Stop lobby music
  var bgMusic = document.getElementById('bgMusic');
  if (bgMusic && !bgMusic.paused) {
    bgMusic.pause();
    console.log('[END] Stopped lobby music');
  }

  // Show results
  setTimeout(function () {
    showResults();
  }, 400); // Reduced from 800ms to 400ms for faster results screen
});


// ===== LOBBY COUNTDOWN HANDLER =====
socket.on('lobbyCountdown', function (data = {}) {
  const el = document.getElementById('lobbyCountdown');
  const num = document.getElementById('countdownTimer');
  if (!el || !num) return;
  el.classList.remove('final3', 'go');
  const t = Number(data.timeLeft);
  if (!Number.isFinite(t)) return;
  if (t > 0) {
    el.classList.add('active');
    // ⬇️ ONLY THIS LINE CHANGES ⬇️
num.innerHTML = `
  <div style="font-size: 0.9rem; margin-bottom: 8px; color: #FFD700;">${t <= 3 ? 'GET READY!' : 'MATCHING PLAYERS FOR TOKYO SUSHI RACE...'}</div>
  <div style="font-size: 3rem;">${t}</div>
  <div style="font-size: 0.7rem; margin-top: 8px; color: #00FF88;">Filling empty slots with bots...</div>
`;
    // ⬆️ END OF CHANGE ⬆️
    if (t <= 3) {
      el.classList.add('final3');
      if (window.sounds && sounds.initialized) {
        if (el.dataset.lastTick !== String(t)) {
          sounds.playCountdown();
          el.dataset.lastTick = String(t);
        }
      }
    } else {
      delete el.dataset.lastTick;
    }
  } else if (t === 0) {
    num.textContent = 'GO!';
    el.classList.add('go', 'active');
    setTimeout(() => {
      el.classList.remove('active', 'final3', 'go');
      num.textContent = '';
      delete el.dataset.lastTick;
    }, 1200);
  } else {
    el.classList.remove('active', 'final3', 'go');
    num.textContent = '';
    delete el.dataset.lastTick;
  }
});


socket.on('resetRoom', function(data) {
  console.log('[RESET] Room reset confirmed by server', data);
  
  // Clear game state
  gameState.isResetting = false;
  gameState.roomId = null;
  gameState.players = {};
  gameState.positions = {};
  gameState.speeds = {};
  gameState.raceStarted = false;
  gameState.raceFinished = false;
  gameState.startTime = null;
  gameState.finishTimes = {};
  gameState.joinInProgress = false; // ✅ Reset join lock
  gameState.hasJoined = false; // ✅ Reset join flag
  playerStates = {};

  // Reset all UI elements
  resetAllUIElements();
  
  // ✅ SHOW LOBBY PROMINENTLY
  var lobby = document.getElementById('lobby');
  if (lobby) {
    lobby.classList.add('active');
    lobby.style.display = 'block';
    lobby.style.visibility = 'visible';
    lobby.style.opacity = '1';
    console.log('[RESET] Lobby shown');
  }

  // ✅ HIDE RESULTS SCREEN
  var results = document.getElementById('results');
  if (results) {
    results.classList.remove('active');
    results.style.display = 'none';
    results.style.visibility = 'hidden';
    console.log('[RESET] Results hidden');
  }

  // Reset join button
  var joinBtn = document.getElementById('joinRoomBtn');
  if (joinBtn) {
    joinBtn.style.display = 'inline-block';
    joinBtn.disabled = false;
    joinBtn.textContent = 'Join Game';
    joinBtn.style.pointerEvents = 'auto';
    joinBtn.style.opacity = '1';
    console.log('[RESET] Join button restored');
  }

  // Hide start button
  var startBtn = document.getElementById('startBtn');
  if (startBtn) startBtn.style.display = 'none';

  // Clear player list
  var playerList = document.getElementById('playerList');
  if (playerList) playerList.innerHTML = '';
  
  // Reset counter
  var counterEl = document.getElementById('playerCounter');
  if (counterEl) counterEl.textContent = 'Players joined: 0/4';

  // ✅ Ensure country selector is enabled and clickable
  var countrySelect = document.getElementById('countrySelect');
  if (countrySelect) {
    countrySelect.disabled = false;
    countrySelect.style.pointerEvents = 'auto';
    countrySelect.style.opacity = '1';
    console.log('[RESET] Country selector re-enabled');
  }

  // ✅ Restart lobby music
  var bgMusic = document.getElementById('bgMusic');
  if (bgMusic && bgMusic.paused) {
    bgMusic.currentTime = 0;
    bgMusic.play().catch(err => console.log('[RESET] Music play failed:', err));
    console.log('[RESET] Lobby music restarted');
  }

  console.log('[RESET] Reset complete - ready for new game');
});



/* ------------------------------
   LAYOUT / SETUP
------------------------------ */
function setupLanes() {
  console.log('🏁 Setting up lanes...');
  
  for (var i = 1; i <= 4; i++) {
    var lane = document.getElementById('lane' + i);
    var runner = document.getElementById('runner' + i);
    var nameLabel = document.getElementById('name' + i);

    if (gameState.players[i]) {
      console.log(`Setting up player ${i}:`, gameState.players[i].name);
      
      laneSystem.initPlayer(i);
      laneSystem.updateRunnerLane(i, i);
      
      // FORCE SHOW LANE
      if (lane) {
        lane.style.display = 'flex';
        lane.style.visibility = 'visible';
        console.log(`✓ Lane ${i} visible`);
      }
      
      if (runner) {
        var startPos = 20;
        var pos = (typeof gameState.positions[i] === 'number') ? gameState.positions[i] : startPos;
        
        // FORCE RUNNER VISIBLE AND POSITIONED
        runner.style.display = 'block';
        runner.style.visibility = 'visible';
        runner.style.left = pos + 'px';
        runner.style.opacity = '1';
        runner.classList.add('active');
        
        if (gameState.players[i].isBot) {
          runner.classList.add('bot-runner');
        }

        console.log(`✓ Runner ${i} positioned at ${pos}px`);

        // Clear and reload sprite
        runner.style.backgroundImage = '';
        delete runner.dataset.frames;
        delete runner.dataset.currentFrame;
        
        // Force reload sprite with delay
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
              console.log(`✓ Sprite loaded for player ${pid}`);
            } else {
              console.warn(`⚠️ No sprite for player ${pid}`);
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
        var _cc = (gameState.players[i].country || 'UN');
        var _flag = (typeof flagEmojiSafe === 'function') ? flagEmojiSafe(_cc) : '🏳️';
        nameLabel.innerHTML = '<span class="name-flag">' + _flag + '</span>' + playerName;
        nameLabel.style.color = getPlayerColor(i);
        nameLabel.style.display = 'block';
        nameLabel.style.visibility = 'visible';
        
        var laneHeight = 80;
        var topPosition = (i - 1) * laneHeight + 2;
        nameLabel.style.top = topPosition + 'px';
        console.log(`✓ Name label ${i} shown`);
      }
    } else {
      // Hide unused lanes
      if (lane) lane.style.display = 'none';
      if (runner) runner.classList.remove('active');
      if (nameLabel) nameLabel.style.display = 'none';
    }
  }
  
  console.log('🏁 Lane setup complete');
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
  if (!gameLoopRunning || !gameState.raceStarted || gameState.isResetting) {
    gameLoopRunning = false;
    return;
  }

  // Only stop if ALL players have finished
  var allFinished = true;
  for (var pid in gameState.players) {
    if (!gameState.finishTimes[pid]) { allFinished = false; break; }
  }
  if (allFinished) {
    gameLoopRunning = false;
    gameState.raceFinished = true;
    return;
  }

  // ⬇⬇⬇ keep loop alive even if update throws
  try {
    updateGame();
  } catch (e) {
    console.error('[UPDATE] Uncaught error inside updateGame:', e);
  }

  if (Math.random() < 0.1) {
    if (typeof powerUpSystem !== 'undefined' && powerUpSystem && typeof powerUpSystem.spawnFixedPowerUps === 'function') {
      powerUpSystem.spawnFixedPowerUps();
    }
    if (typeof trackElements !== 'undefined' && trackElements && typeof trackElements.spawnRandomElements === 'function') {
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
  
  // 1) Update runner positions & find leader with smooth interpolation
// 1) Update runner positions & find leader with smooth interpolation
for (var playerId in gameState.players) {
  var targetPosition = (typeof gameState.positions[playerId] === 'number') ? gameState.positions[playerId] : 20;
  var runner = document.getElementById('runner' + playerId);
  
  if (runner) {
    if (!playerStates[playerId]) {
      playerStates[playerId] = { 
        speed: 0, 
        position: targetPosition,  // Server position
        visualPosition: targetPosition,  // Visual position
        lastTap: 0, 
        isRunning: false, 
        tapCount: 0, 
        animationInterval: null 
      };
    }
    
    // Keep server position accurate for powerup spawning
    playerStates[playerId].position = targetPosition;
    
    // Smooth interpolation (lerp) for visual position only
    var currentVisualPos = playerStates[playerId].visualPosition || 20;
    var smoothPos = currentVisualPos + (targetPosition - currentVisualPos) * 0.3;
    
    runner.style.left = (smoothPos > 20 ? smoothPos : 20) + 'px';
    playerStates[playerId].visualPosition = smoothPos;
    
    // Track leading player using actual server position
    if (targetPosition > leadingPlayerPosition) {
      leadingPlayerPosition = targetPosition;
      leadingPlayerId = playerId;
    }
  }
}
  
  var track = document.getElementById('track');
  var container = document.querySelector('.track-container');
  var grandstand = document.getElementById('grandstand');
  if (!track || !container) return;
  
  // 2) Camera follow (state-driven; no DOM dependency)
  var myPlayerId = gameState.myId;
  if (!myPlayerId) {
    for (var pid in gameState.players) {
      if (gameState.players[pid] && gameState.players[pid].socketId === socket.id) { 
        myPlayerId = pid; 
        break; 
      }
    }
  }
  
  // Prefer following you; fall back to leader if needed
  var followId = myPlayerId || leadingPlayerId;
  
  if (followId) {
    // pull X from state first, then playerStates, then last-resort DOM
    var followPos =
      (typeof gameState.positions[followId] === 'number' ? gameState.positions[followId] : null) ??
      (playerStates[followId] && typeof playerStates[followId].position === 'number' ? playerStates[followId].position : null);
    
    if (followPos === null) {
      var fr = document.getElementById('runner' + followId);
      if (fr) {
        var leftStr = fr.style.left || '0px';
        var parsed = parseInt(leftStr, 10);
        followPos = isNaN(parsed) ? 0 : parsed;
      } else {
        followPos = 0;
      }
    }
    
    var screenOffset = container.offsetWidth * 0.2;
    var maxCam = Math.max(0, (gameState.trackWidth || 0) - container.offsetWidth);
    var target = Math.min(Math.max(0, followPos - screenOffset), maxCam);
    
    // Smoother camera easing
    var k = 0.15;
    cameraState.cameraOffset += (target - cameraState.cameraOffset) * k;
  }
  
  // 3) Apply transform
  track.style.transform = 'translateX(-' + cameraState.cameraOffset + 'px)';
  
  // 4) Parallax grandstand
  if (grandstand) {
    var parallaxOffset = cameraState.cameraOffset * 0.5;
    grandstand.style.backgroundPositionX = '-' + parallaxOffset + 'px';
  }
  
  // 5) Collisions (guarded)
  Object.keys(gameState.players).forEach(function(pid) {
    if (typeof powerUpSystem !== 'undefined' && powerUpSystem && typeof powerUpSystem.checkCollisions === 'function') {
      powerUpSystem.checkCollisions(pid);
    }
    if (typeof trackElements !== 'undefined' && trackElements && typeof trackElements.checkCollisions === 'function') {
      trackElements.checkCollisions(pid);
    }
  });
}


/* ------------------------------
   FINISH & RESULTS
------------------------------ */
function checkFinish(playerId) {
  if (!playerStates[playerId] || gameState.finishTimes[playerId] || gameState.isResetting) return;

  if (!gameState.trackWidth || gameState.trackWidth < 1000) {
    console.warn('[FINISH] Invalid track width, skipping check');
    return;
  }

  const isMobile = window.innerWidth <= 480;
  const finishLineOffset = isMobile ? 150 : 200;
  const startPadding = 20;
  const finishLinePosition = gameState.trackWidth - finishLineOffset - startPadding;

  // ✅ Use the same coordinate the sprite uses on screen
  const runner = document.getElementById('runner' + playerId);
  const visualPos =
    (playerStates[playerId] && typeof playerStates[playerId].visualPosition === 'number')
      ? playerStates[playerId].visualPosition
      : (runner && runner.style && runner.style.left)
        ? parseFloat(runner.style.left) || 20
        : 20;

  // Optional tiny buffer so the front of the sprite fully clears the line
  const spriteWidth = 32; // matches your runner width
  const nosePos = visualPos + (spriteWidth * 0.5); // center/right-ish of sprite

  console.log(`[FINISH] Player ${playerId} at visual ${visualPos.toFixed(1)} (nose ${nosePos.toFixed(1)}) vs finish ${finishLinePosition}`);

  if (nosePos >= finishLinePosition) {
    console.log(`[FINISH] ✅ Player ${playerId} CROSSED THE FINISH LINE (visual)!`);

    const finishTime = (Date.now() - gameState.startTime) / 1000;
    gameState.finishTimes[playerId] = finishTime;

    if (typeof crowdSystem !== 'undefined') {
      const finishedCountNow = Object.keys(gameState.finishTimes).length;
      const firstTime = Object.values(gameState.finishTimes)[0] || finishTime;
      const timeDiff = finishTime - firstTime;
      crowdSystem.onPlayerFinish(playerId, finishedCountNow, timeDiff);
    }

    if (sounds.initialized) sounds.playFinish();

    // Notify server
    socket.emit('checkFinish', {
      roomId: gameState.roomId,
      playerId,
      finishTime
    });

    if (runner) stopRunnerAnimation(playerId);

    // How many have finished so far?
    let finishedCount = Object.keys(gameState.finishTimes).length;

    // First finisher -> grace window to avoid instant DNFs
    if (finishedCount === 1) {
      console.log('[FINISH] 🏁 First finisher — starting grace window...');
      const GRACE_MS = 600; // Reduced from 3000ms to 600ms for faster results

      socket.emit('finishWindowStarted', { roomId: gameState.roomId, windowMs: GRACE_MS });

      setTimeout(function () {
        for (const pid in gameState.players) {
          if (!gameState.finishTimes[pid]) {
            gameState.finishTimes[pid] = 999.999; // DNF
          }
        }
        socket.emit('endRace', gameState.roomId);
      }, GRACE_MS);
    }

    // If everyone finished, end promptly
    const totalRacers = Object.keys(gameState.players).length;
    finishedCount = Object.keys(gameState.finishTimes).length;
    if (finishedCount === totalRacers) {
      setTimeout(function () {
        socket.emit('endRace', gameState.roomId);
      }, 100); // Reduced from 300ms to 100ms for faster results
    }
  }
}



function showResults() {
  if (gameState.isResetting) return;

  console.log('[RESULTS] Showing results with finishTimes:', gameState.finishTimes);
  
  // ✅ FORCE STOP EVERYTHING IMMEDIATELY
  gameState.raceFinished = true;
  gameLoopRunning = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // ✅ Stop all animation intervals
  for (var pid in playerStates) {
    if (playerStates[pid] && playerStates[pid].animationInterval) {
      clearInterval(playerStates[pid].animationInterval);
      playerStates[pid].animationInterval = null;
    }
  }
  
  // Stop music
  var bgMusic = document.getElementById('bgMusic');
  if (bgMusic && !bgMusic.paused) {
    bgMusic.pause();
  }

  if (typeof powerUpSystem !== 'undefined') {
    powerUpSystem.hideActivationButton();
  }

  // ✅ HIDE ALL GAME ELEMENTS
  var mobileControls = document.getElementById('mobileControls');
  var track = document.getElementById('track');
  var statusBar = document.getElementById('statusBar');
  var grandstand = document.getElementById('grandstand');
  var container = document.querySelector('.track-container');
  var countdown = document.getElementById('countdown');
  var staminaDisplay = document.getElementById('staminaDisplay');

  if (mobileControls) {
    mobileControls.classList.remove('active');
    mobileControls.style.display = 'none';
  }
  
  if (statusBar) {
    statusBar.classList.remove('active');
    statusBar.style.display = 'none';
  }
  
  if (grandstand) {
    grandstand.classList.remove('active');
    grandstand.style.display = 'none';
  }
  
  if (countdown) {
    countdown.style.display = 'none';
  }
  
  if (staminaDisplay) {
    staminaDisplay.style.display = 'none';
  }

  if (track) { 
    track.classList.remove('active'); 
    track.style.display = 'none';
    track.style.visibility = 'hidden';
  }
  
  if (container) {
    container.classList.remove('active');
    container.style.display = 'none';
    container.style.visibility = 'hidden';
  }

  // ✅ SHOW RESULTS (make sure it's on top)
  var results = document.getElementById('results');
  if (results) {
    results.classList.add('active');
    results.style.display = 'flex';
    results.style.visibility = 'visible';
    results.style.opacity = '1';
    results.style.zIndex = '9999';
  }

  // Scroll to top
  var screen = document.getElementById('screen');
  if (screen) screen.scrollTop = 0;
  window.scrollTo(0, 0);

  // Build leaderboard
  var leaderboard = document.getElementById('leaderboard');
  if (!leaderboard) {
    console.error('[RESULTS] Leaderboard element not found!');
    return;
  }
  
  leaderboard.innerHTML = '';

  // ✅ Sort by finish time (999.999 = DNF)
  var sorted = Object.keys(gameState.finishTimes)
    .map(function(pid){
      var player = gameState.players[pid];
      return { 
        playerId: pid, 
        time: gameState.finishTimes[pid], 
        name: (player && player.name) || ('Runner ' + pid),
        isBot: player ? player.isBot : false
      };
    })
    .sort(function(a, b){ 
      return a.time - b.time; 
    });

  console.log('[RESULTS] Sorted results:', sorted);

  if (sorted.length === 0) {
    leaderboard.innerHTML = '<div style="color:#888;">No results available</div>';
    return;
  }

  // Display results
  var medals = ['🥇','🥈','🥉','🏅'];
  sorted.forEach(function(r, index){
    var row = document.createElement('div');
    row.className = 'result-item';
    
    var timeDisplay = r.time >= 999 ? 'DNF' : r.time.toFixed(3) + 's';
    var playerName = r.name.toUpperCase();
    
    row.innerHTML = '<span>' + (medals[index] || '🏅') + ' ' + (index+1) + '. ' + 
                    playerName + '</span> <span>' + timeDisplay + '</span>';
    leaderboard.appendChild(row);
  });

  // Winner effects
  // Winner effects
var winner = sorted[0];
if (winner && winner.time < 999) {
  var winnerRunner = document.getElementById('runner' + winner.playerId);
  if (winnerRunner) winnerRunner.classList.add('winner');
  
  if (sounds.initialized) sounds.playVictory();
  
  // ✅ Show victory kanji with faster animation
  if (typeof kanjiEffects !== 'undefined') {
    setTimeout(function() {
      // Use a custom faster animation
      const char = kanjiEffects.characters.victory;
      if (char) {
        const kanji = document.createElement('div');
        kanji.className = 'kanji-effect';
        kanji.innerHTML = `
          <div class="kanji-main">${char.kanji}</div>
          <div class="kanji-meaning">${char.meaning}</div>
        `;
        kanji.style.cssText = `
          position: fixed;
          top: 20%;
          left: 50%;
          transform: translateX(-50%);
          color: ${char.color};
          font-family: 'Press Start 2P', monospace;
          text-align: center;
          font-weight: bold;
          z-index: 10000;
          animation: victoryKanjiFast 1.5s ease-out forwards;
          pointer-events: none;
        `;
        document.body.appendChild(kanji);
        
        setTimeout(() => {
          if (kanji && kanji.parentElement) {
            kanji.remove();
          }
        }, 1500);
      }
    }, 100);
  }
}

  // Show winner's flag
  (function showWinnerFlag(){
    try {
      if (!winner || winner.time >= 999) return;
      
      var hideFlags = (localStorage.getItem('sushiHideFlags') === '1');
      var header = results ? results.querySelector('h2') : null;
      if (!header) return;

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

      var existing = document.getElementById('winnerFlagEmoji');
      if (!existing) {
        var span = document.createElement('div');
        span.id = 'winnerFlagEmoji';
        span.style.fontSize = '2.2rem';
        span.style.marginBottom = '.25rem';
        span.style.lineHeight = '1';
        span.textContent = flag || '🇺🇳';
        header.prepend(span);
      } else {
        existing.textContent = flag || '🇺🇳';
      }
    } catch (e) {
      console.warn('[RESULTS] Winner flag render failed:', e);
    }
  })();

  console.log('[RESULTS] Results screen displayed successfully');
}

/* ------------------------------
   RESET
------------------------------ */
function resetGame() {
  console.log('[RESET] Play Again clicked!');
  if (gameState.isResetting) {
    console.log('[RESET] Already resetting, ignoring');
    return;
  }

  console.log('[RESET] Initiating game reset...');
  gameState.isResetting = true;

  // Stop loops/flags
  gameLoopRunning = false;
  gameState.raceFinished = true;
  gameState.raceStarted = false;
  gameState.countdownActive = false;

  // Cancel RAF if you use it
  if (typeof rafId !== 'undefined' && rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Clear timers
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // Stop player animations
  for (var id in playerStates) {
    if (playerStates[id] && playerStates[id].animationInterval) {
      clearInterval(playerStates[id].animationInterval);
      playerStates[id].animationInterval = null;
    }
  }

  // Visual/system resets
  if (typeof trackElements !== 'undefined') trackElements.clearElements();
  if (typeof powerUpSystem !== 'undefined') {
    powerUpSystem.activePowerUps = {};
    if (typeof powerUpSystem.reset === 'function') powerUpSystem.reset();
  }
  if (typeof crowdSystem !== 'undefined' && typeof crowdSystem.reset === 'function') {
    crowdSystem.reset();
  }

  // Remove floating overlays that could intercept taps
  document
    .querySelectorAll(
      '.cherry-blossom, .position-announcement, .power-up-text, .kanji-effect, .block-feedback, .collection-feedback, .activation-feedback, .defense-warning'
    )
    .forEach(el => el.remove());

  // Emit reset
  const rid = gameState.roomId || gameState.lastRoomId;
  if (rid) {
    console.log('[RESET] Emitting resetRoom for', rid);
    socket.emit('resetRoom', rid);
  } else {
    console.warn('[RESET] No room id; requesting new quick race');
    if (typeof resetAllUIElements === 'function') resetAllUIElements();
    socket.emit('quickRace'); // will set room later
    gameState.isResetting = false; // allow interaction again
  }
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
   JOIN ROOM - CLEAN VERSION
------------------------------ */
// Put these once at module scope (near your gameState)
gameState.joinInProgress = gameState.joinInProgress || false;
gameState.hasJoined = gameState.hasJoined || false;

function joinRoom() {
  console.log('[JOIN] Join room called');
  console.log('[JOIN] Current roomId:', gameState.roomId);
  console.log('[JOIN] Current players:', gameState.players);

  // Basic guards
  if (gameState.isResetting) {
    console.log('[JOIN] Game is resetting, cannot join');
    return;
  }
  if (gameState.joinInProgress) {
    console.log('[JOIN] Join already in progress, ignoring');
    return;
  }

  // If this socket already has a player, treat as joined (idempotent)
  try {
    for (var i = 1; i <= 4; i++) {
      var p = gameState.players[i];
      if (p && p.socketId === socket.id) {
        console.log('[JOIN] This socket is already in the room (slot ' + i + '), skipping re-join.');
        gameState.hasJoined = true;
        var btnA = document.getElementById('joinRoomBtn');
        if (btnA) {
          btnA.disabled = true;
          btnA.style.pointerEvents = 'none';
          btnA.style.display = 'none';
        }
        return;
      }
    }
  } catch (e) {
    console.warn('[JOIN] Players check failed:', e);
  }

  // No re-entry after this point until we finish one path
  gameState.joinInProgress = true;

  // Helper to hide/disable the button immediately on first attempt
  (function disableJoinBtn() {
    var btn = document.getElementById('joinRoomBtn');
    if (btn) {
      btn.disabled = true;
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.6';
      btn.style.display = 'none';
      console.log('[JOIN] Join button disabled/hidden');
    }
  })();

  // If no room ID yet, request one first
  if (!gameState.roomId) {
    console.log('[JOIN] No room ID - requesting room assignment...');

    // ONE-TIME listener for room assignment
    socket.once('roomAssigned', function (data) {
      console.log('[JOIN] Room assigned:', data);
      if (data && data.roomId) {
        gameState.roomId = data.roomId;
        console.log('[JOIN] Saved room ID:', gameState.roomId);
        // allow the next call to proceed past the in-progress guard
        gameState.joinInProgress = false;
        // Now try joining again
        joinRoom();
      } else {
        console.log('[JOIN] No roomId in assignment payload, allowing retry');
        gameState.joinInProgress = false;
      }
    });

    socket.emit('quickRace');
    console.log('[JOIN] Emitted quickRace');
    return;
  }

  console.log('[JOIN] Room ID exists, proceeding to join...');

  // Find available slot
  var slot = null;
  for (var i = 1; i <= 4; i++) {
    if (!gameState.players[i]) { 
      slot = i; 
      break; 
    }
  }

  if (!slot) {
    alert('All runner slots are taken!');
    console.log('[JOIN] ERROR: No slots available');
    gameState.joinInProgress = false; // let user try again later
    return;
  }

  console.log('[JOIN] Found available slot:', slot);

  // Get country code

  // Accept 2-letter ISO codes OR our custom subdivision codes
  var cc = (localStorage.getItem('sushiCountry') || '').toUpperCase();
  const ALLOWED3 = new Set(['ENG','SCO','WAL','NIR','JE','GG','UN']);
  if (!/^[A-Z]{2}$/.test(cc) && !ALLOWED3.has(cc)) cc = 'UN';

  var payload = {
    roomId: gameState.roomId,
    playerNum: slot,
    countryCode: cc
  };
  console.log('[JOIN] Emitting joinRoom with:', payload);

  // Emit join
  socket.emit('joinRoom', payload);

  // Optimistically mark as joined; if you prefer, flip this on a server ack event instead
  gameState.hasJoined = true;

  console.log('[JOIN] Join emitted; preventing re-entry until next state change');
  // keep joinInProgress true to block accidental double taps
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


window.gameState = gameState;
window.playerStates = playerStates;
window.resetGame = resetGame;
window.gameGraphics = gameGraphics;


document.addEventListener('DOMContentLoaded', () => {
  // Direct listener (fires if the actual button node survives DOM swaps)
  const btn = document.querySelector('#results .play-button');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('[RESET] Button click (direct listener)');
      if (typeof resetGame === 'function') resetGame();
    }, { passive: false });
  }

  // Safety net: window-level capture (fires even if ancestors stop propagation)
  window.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target.closest('#results .play-button') : null;
    if (target) {
      console.log('[RESET] Button click (window capture)');
      if (typeof resetGame === 'function') resetGame();
    }
  }, true);
});


/* =========================================
   SOCKET DEBUG LOGGING (optional)
   ========================================= */

const originalEmit = socket.emit;
socket.emit = function(...args) {
  console.log('[SOCKET OUT]', args[0], args.slice(1));
  return originalEmit.apply(socket, args);
};

socket.onAny((eventName, ...args) => {
  console.log('[SOCKET IN]', eventName, args);
});