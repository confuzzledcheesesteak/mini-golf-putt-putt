const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const rooms = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

function makeCode() {
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function uniqueCode() {
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();
  return code;
}

function publicPlayers(room) {
  return room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    host: player.id === room.hostId,
    index
  }));
}

function lobbyPayload(room, message = "") {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: publicPlayers(room),
    message
  };
}

function emitLobby(room, message = "") {
  io.to(room.code).emit("lobby:update", lobbyPayload(room, message));
}

function cleanPlayerName(name, fallback) {
  const cleaned = String(name || "").trim().replace(/\s+/g, " ").slice(0, 18);
  return cleaned || fallback;
}

function cleanPlayerId(clientId, fallback) {
  const cleaned = String(clientId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  return cleaned || fallback;
}

function attachPlayerSocket(socket, room, player) {
  player.socketId = socket.id;
  player.disconnected = false;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

function removePlayer(socket) {
  const { roomCode } = socket.data;
  if (!roomCode || !rooms.has(roomCode)) return;

  const room = rooms.get(roomCode);
  const playerId = socket.data.playerId || socket.id;
  const player = room.players.find(item => item.id === playerId || item.socketId === socket.id);
  const leavingWasHost = room.hostId === playerId;
  socket.leave(roomCode);

  if (room.started && player) {
    player.disconnected = true;
    player.socketId = "";
    if (leavingWasHost) {
      io.to(room.code).emit("game:closed", {
        message: "Host disconnected. The room was closed."
      });
      rooms.delete(roomCode);
      return;
    }
    io.to(room.code).emit("room:status", {
      type: "player-disconnected",
      message: `${player.name} disconnected. They can rejoin with the same code.`
    });
    return;
  }

  room.players = room.players.filter(item => item.id !== playerId && item.socketId !== socket.id);

  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (leavingWasHost) {
    room.hostId = room.players[0].id;
    io.to(room.code).emit("room:status", {
      type: "host-transfer",
      message: `${room.players[0].name} is now the host.`
    });
  }

  emitLobby(room, leavingWasHost ? "Host disconnected. Host transferred." : "A player disconnected.");
}

io.on("connection", socket => {
  socket.on("room:create", ({ name, clientId } = {}, reply) => {
    removePlayer(socket);
    const code = uniqueCode();
    const player = {
      id: cleanPlayerId(clientId, socket.id),
      socketId: socket.id,
      name: cleanPlayerName(name, "Host")
    };
    const room = {
      code,
      hostId: player.id,
      started: false,
      players: [player]
    };

    rooms.set(code, room);
    attachPlayerSocket(socket, room, player);
    reply?.({ ok: true, lobby: lobbyPayload(room, "Waiting for players...") });
    emitLobby(room, "Waiting for players...");
  });

  socket.on("room:join", ({ code, name, clientId } = {}, reply) => {
    const roomCode = String(code || "").trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(roomCode)) {
      reply?.({ ok: false, message: "Enter exactly five letters." });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      reply?.({ ok: false, message: "Room not found. Make sure both players are using the same link and the host is still in the lobby." });
      return;
    }
    if (room.started) {
      reply?.({ ok: false, message: "That game has already started." });
      return;
    }

    removePlayer(socket);
    const playerId = cleanPlayerId(clientId, socket.id);
    const existingPlayer = room.players.find(player => player.id === playerId);
    if (existingPlayer) {
      attachPlayerSocket(socket, room, existingPlayer);
      reply?.({ ok: true, lobby: lobbyPayload(room, "Reconnected.") });
      emitLobby(room, `${existingPlayer.name} reconnected.`);
      return;
    }
    const player = {
      id: playerId,
      socketId: socket.id,
      name: cleanPlayerName(name, `Player ${room.players.length + 1}`)
    };
    room.players.push(player);
    attachPlayerSocket(socket, room, player);
    reply?.({ ok: true, lobby: lobbyPayload(room, "Connected.") });
    emitLobby(room, `${player.name} joined.`);
  });

  socket.on("room:rejoin", ({ code, clientId } = {}, reply) => {
    const roomCode = String(code || "").trim().toUpperCase();
    const playerId = cleanPlayerId(clientId, "");
    const room = rooms.get(roomCode);
    if (!room || !playerId) {
      reply?.({ ok: false, message: "Could not reconnect to the room." });
      return;
    }
    const player = room.players.find(item => item.id === playerId);
    if (!player) {
      reply?.({ ok: false, message: "Could not reconnect to the room." });
      return;
    }
    attachPlayerSocket(socket, room, player);
    reply?.({ ok: true, lobby: lobbyPayload(room, "Reconnected.") });
    emitLobby(room, `${player.name} reconnected.`);
  });

  socket.on("room:start", (payload, reply) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) {
      reply?.({ ok: false, message: "Room not found." });
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      reply?.({ ok: false, message: "Only the host can start the match." });
      return;
    }
    room.started = true;
    io.to(room.code).emit("game:start", lobbyPayload(room, "Game starting..."));
    reply?.({ ok: true });
  });

  // Host-authoritative sync: the host simulates physics and broadcasts snapshots.
  // Non-host players send shot requests, which the server relays only to the host.
  socket.on("game:state", state => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId) return;
    socket.to(room.code).emit("game:state", state);
  });

  socket.on("game:shot", shot => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const host = room.players.find(player => player.id === room.hostId);
    if (!host?.socketId) return;
    io.to(host.socketId).emit("game:shot", { ...shot, playerId: socket.data.playerId });
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Mini Golf multiplayer server running at http://localhost:${PORT}`);
});
