const socket = io();
let gameState = {
  players: {},
  raceStarted: false,
  raceFinished: false,
  startTime: null,
  finishTimes: {},
  trackWidth: window.innerWidth - 60,
  roomId: 'default'
};
let playerStates = {
  player1: { speed: 0, position: 5, lastTap: 0, isRunning: false },
  player2: { speed: 0, position: 5, lastTap: 0, isRunning: false },
  player3: { speed: 0, position: 5, lastTap: 0, isRunning: false },
  player4: { speed: 0, position: 5, lastTap: 0, isRunning: false }
};

function initGame() {
  gameState.trackWidth = window.innerWidth - 60;
  for (let i = 1; i <= 4; i++) {
    const input = document.getElementById(`player${i}-name`);
    const card = document.querySelector(`[data-player="${i}"]`);
    input.addEventListener('input', (e) => {
      if (e.target.value.trim()) {
        card.classList.add('active');
        gameState.players[`player${i}`] = { name: e.target.value.trim(), id: i, active: true };
      } else {
        card.classList.remove('active');
        delete gameState.players[`player${i}`];
      }
    });
  }
}

function joinRoom() {
  const roomId = document.getElementById('roomId').value || 'default';
  const playerNum = Object.keys(gameState.players).length + 1;
  const playerName = document.getElementById(`player${playerNum}-name`).value;
  if (playerName) {
    socket.emit('joinRoom', { roomId, playerName, playerNum });
  }
}

socket.on('joinedRoom', (id) => {
  gameState.roomId = id;
  document.getElementById('startBtn').style.display = Object.keys(gameState.players).length === 1 ? 'block' : 'none';
});

socket.on('playerJoined', (data) => {
  gameState.players = data.players;
  setupLanes(data.positions);
  if (Object.keys(data.players).length >= 2) {
    document.getElementById('startBtn').style.display = 'block';
  }
  setupMobileControls();
});

socket.on('gameStarted', () => {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('statusBar').classList.add('active');
  document.getElementById('track').classList.add('active');
  document.getElementById('mobileControls').classList.add('active');
  startCountdown();
});

socket.on('updateState', (state) => {
  Object.assign(gameState, state);
  updatePositions();
});

socket.on('endRace', (finishTimes) => {
  gameState.finishTimes = finishTimes;
  endRace();
});

function setupLanes(positions = {}) {
  for (let i = 1; i <= 4; i++) {
    const lane = document.getElementById(`lane${i}`);
    const runner = document.getElementById(`runner${i}`);
    const nameLabel = document.getElementById(`name${i}`);
    if (gameState.players[`player${i}`]) {
      lane.style.display = 'flex';
      runner.style.left = (positions[`player${i}`] || 5) + 'px';
      nameLabel.textContent = gameState.players[`player${i}`].name;
      nameLabel.style.color = getPlayerColor(i);
    } else {
      lane.style.display = 'none';
    }
  }
}

function setupMobileControls() {
  const controlLayout = document.getElementById('controlLayout');
  controlLayout.innerHTML = '';
  Object.entries(gameState.players).forEach(([playerId, player]) => {
    if (player.id === Object.keys(gameState.players).length) { // Only for local player
      const controlDiv = document.createElement('div');
      controlDiv.className = `player-touch-controls ${playerId}`;
      controlDiv.innerHTML = `
        <div class="player-label ${playerId}">${player.name}</div>
        <div class="touch-buttons">
          <div class="touch-btn left" data-player="${playerId}" data-action="left">L</div>
          <div class="touch-btn right" data-player="${playerId}" data-action="right">R</div>
        </div>
      `;
      controlLayout.appendChild(controlDiv);
    }
  });
  setupTouchControls();
}

function setupTouchControls() {
  const touchButtons = document.querySelectorAll('.touch-btn');
  touchButtons.forEach(btn => {
    btn.addEventListener('touchstart', handleTouchStart, { passive: false });
    btn.addEventListener('touchend', handleTouchEnd, { passive: false });
    btn.addEventListener('mousedown', handleTouchStart);
    btn.addEventListener('mouseup', handleTouchEnd);
  });
}

function handleTouchStart(e) {
  e.preventDefault();
  if (!gameState.raceStarted || gameState.raceFinished) return;
  const btn = e.target;
  const playerId = btn.dataset.player;
  btn.classList.add('active');
  const player = playerStates[playerId];
  const now = Date.now();
  player.speed = Math.min(player.speed + 2, 15);
  player.lastTap = now;
  if (!player.isRunning) {
    player.isRunning = true;
    document.getElementById(playerId.replace('player', 'runner')).classList.add('running');
  }
  socket.emit('playerAction', { roomId: gameState.roomId, playerId });
}

function handleTouchEnd(e) {
  e.preventDefault();
  e.target.classList.remove('active');
}

function getPlayerColor(playerNum) {
  const colors = { 1: '#ff0000', 2: '#0000ff', 3: '#ffff00', 4: '#ff00ff' };
  return colors[playerNum];
}

function startCountdown() {
  const countdown = document.getElementById('countdown');
  let count = 3;
  countdown.style.display = 'block';
  countdown.textContent = count;
  const countInterval = setInterval(() => {
    count--;
    if (count > 0) countdown.textContent = count;
    else if (count === 0) {
      countdown.textContent = 'GO!';
      countdown.style.color = '#00ff00';
      setTimeout(() => {
        countdown.style.display = 'none';
        gameState.raceStarted = true;
        gameState.startTime = Date.now();
        startTimer();
        gameLoop();
      }, 1000);
      clearInterval(countInterval);
    }
  }, 1000);
}

function startTimer() {
  const timerElement = document.getElementById('timer');
  const timerInterval = setInterval(() => {
    if (!gameState.raceStarted || gameState.raceFinished) {
      clearInterval(timerInterval);
      return;
    }
    const elapsed = (Date.now() - gameState.startTime) / 1000;
    timerElement.textContent = elapsed.toFixed(2) + 's';
  }, 10);
}

function gameLoop() {
  if (!gameState.raceStarted || gameState.raceFinished) return;
  Object.keys(gameState.players).forEach(playerId => {
    updatePlayerMovement(playerId);
    checkFinish(playerId);
  });
  requestAnimationFrame(gameLoop);
}

function updatePositions() {
  Object.entries(gameState.players).forEach(([playerId, player]) => {
    const runner = document.getElementById(playerId.replace('player', 'runner'));
    const position = gameState.positions[playerId] || 5;
    const speed = gameState.speeds[playerId] || 0;
    runner.style.left = position + 'px';
    playerStates[playerId].speed = speed;
    if (speed < 1.0 && playerStates[playerId].isRunning) {
      playerStates[playerId].isRunning = false;
      runner.classList.remove('running');
    } else if (speed >= 1.0 && !playerStates[playerId].isRunning) {
      playerStates[playerId].isRunning = true;
      runner.classList.add('running');
    }
  });
}

function updatePlayerMovement(playerId) {
  const player = playerStates[playerId];
  player.speed *= 0.92;
  player.position += player.speed * 0.8;
  player.position = Math.max(5, Math.min(player.position, gameState.trackWidth - 50));
  const runner = document.getElementById(playerId.replace('player', 'runner'));
  runner.style.left = player.position + 'px';
}

function checkFinish(playerId) {
  const player = playerStates[playerId];
  const finishPosition = gameState.trackWidth - 60;
  if (player.position >= finishPosition && !gameState.finishTimes[playerId]) {
    const finishTime = (Date.now() - gameState.startTime) / 1000;
    gameState.finishTimes[playerId] = finishTime;
    socket.emit('checkFinish', { roomId: gameState.roomId, playerId, finishTime });
    const runner = document.getElementById(playerId.replace('player', 'runner'));
    runner.classList.remove('running');
    playerStates[playerId].isRunning = false;
  }
}

function endRace() {
  gameState.raceFinished = true;
  showResults();
}

function showResults() {
  document.getElementById('mobileControls').classList.remove('active');
  document.getElementById('results').classList.add('active');
  const leaderboard = document.getElementById('leaderboard');
  leaderboard.innerHTML = '';
  const sortedResults = Object.entries(gameState.finishTimes)
    .sort(([, timeA], [, timeB]) => timeA - timeB)
    .map(([playerId, time], index) => ({
      playerId,
      time,
      position: index + 1,
      name: gameState.players[playerId].name
    }));
  sortedResults.forEach(result => {
    const div = document.createElement('div');
    div.className = 'result-item';
    const medals = ['🥇', '🥈', '🥉', '🏃'];
    const medal = medals[result.position - 1] || '🏃';
    div.innerHTML = `<span>${medal} ${result.position}. ${result.name}</span><span>${result.time.toFixed(3)}s</span>`;
    leaderboard.appendChild(div);
  });
}

function resetGame() {
  gameState = {
    players: {},
    raceStarted: false,
    raceFinished: false,
    startTime: null,
    finishTimes: {},
    trackWidth: window.innerWidth - 60,
    roomId: gameState.roomId
  };
  Object.keys(playerStates).forEach(playerId => {
    playerStates[playerId] = { speed: 0, position: 5, lastTap: 0, tapCount: 0, isRunning: false };
  });
  for (let i = 1; i <= 4; i++) {
    const runner = document.getElementById(`runner${i}`);
    runner.style.left = '5px';
    runner.textContent = '🏃‍♂️';
    runner.classList.remove('running');
  }
  document.getElementById('lobby').style.display = 'block';
  document.getElementById('statusBar').classList.remove('active');
  document.getElementById('track').classList.remove('active');
  document.getElementById('mobileControls').classList.remove('active');
  document.getElementById('results').classList.remove('active');
  document.getElementById('startBtn').style.display = 'none';
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`player${i}-name`).value = '';
    document.querySelector(`[data-player="${i}"]`).classList.remove('active');
  }
  document.getElementById('timer').textContent = '00:00';
  socket.emit('resetRoom', gameState.roomId);
}

window.addEventListener('resize', () => {
  gameState.trackWidth = window.innerWidth - 60;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('load', initGame);