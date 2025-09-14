const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {}; // { roomId: { players: {}, gameState: {} } }

io.on('connection', (socket) => {
  console.log(`Player ${socket.id} connected`);

  socket.on('joinRoom', (data) => {
    const { roomId, playerName, playerNum } = data;
    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, gameState: { positions: {}, speeds: {}, finishTimes: {} } };
    }
    if (Object.keys(rooms[roomId].players).length >= 4) {
      socket.emit('roomFull');
      return;
    }
    socket.join(roomId);
    rooms[roomId].players[socket.id] = { name: playerName, playerNum };
    rooms[roomId].gameState.positions[socket.id] = 5; // Start position
    rooms[roomId].gameState.speeds[socket.id] = 0;
    io.to(roomId).emit('playerJoined', { players: rooms[roomId].players, positions: rooms[roomId].gameState.positions });
    socket.emit('joinedRoom', roomId);
  });

  socket.on('playerAction', (data) => {
    const { roomId, playerId } = data;
    const room = rooms[roomId];
    if (room && room.gameState.positions[playerId]) {
      room.gameState.speeds[playerId] = Math.min(room.gameState.speeds[playerId] + 2, 15);
      io.to(roomId).emit('updateState', room.gameState);
    }
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (room && Object.keys(room.players).length >= 2) {
      io.to(roomId).emit('gameStarted');
    }
  });

  socket.on('checkFinish', (data) => {
    const { roomId, playerId, finishTime } = data;
    const room = rooms[roomId];
    if (room) {
      room.gameState.finishTimes[playerId] = finishTime;
      if (Object.keys(room.gameState.finishTimes).length === Object.keys(room.players).length) {
        io.to(roomId).emit('endRace', room.gameState.finishTimes);
      }
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      if (rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        delete rooms[roomId].gameState.positions[socket.id];
        delete rooms[roomId].gameState.speeds[socket.id];
        delete rooms[roomId].gameState.finishTimes[socket.id];
        io.to(roomId).emit('playerLeft', rooms[roomId].players);
      }
    });
    console.log(`Player ${socket.id} disconnected`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});