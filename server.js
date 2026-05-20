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

function removePlayer(socket) {
  const { roomCode } = socket.data;
  if (!roomCode || !rooms.has(roomCode)) return;

  const room = rooms.get(roomCode);
  const leavingWasHost = room.hostId === socket.id;
  room.players = room.players.filter(player => player.id !== socket.id);
  socket.leave(roomCode);

  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }

  if (leavingWasHost && room.started) {
    io.to(room.code).emit("game:closed", {
      message: "Host disconnected. The room was closed."
    });
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
  socket.on("room:create", ({ name } = {}, reply) => {
    removePlayer(socket);
    const code = uniqueCode();
    const player = {
      id: socket.id,
      name: String(name || "Host").slice(0, 18)
    };
    const room = {
      code,
      hostId: socket.id,
      started: false,
      players: [player]
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    reply?.({ ok: true, lobby: lobbyPayload(room, "Waiting for players...") });
    emitLobby(room, "Waiting for players...");
  });

  socket.on("room:join", ({ code, name } = {}, reply) => {
    const roomCode = String(code || "").trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(roomCode)) {
      reply?.({ ok: false, message: "Enter exactly five letters." });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      reply?.({ ok: false, message: "Room not found." });
      return;
    }
    if (room.started) {
      reply?.({ ok: false, message: "That game has already started." });
      return;
    }

    removePlayer(socket);
    const player = {
      id: socket.id,
      name: String(name || `Player ${room.players.length + 1}`).slice(0, 18)
    };
    room.players.push(player);
    socket.data.roomCode = roomCode;
    socket.join(roomCode);
    reply?.({ ok: true, lobby: lobbyPayload(room, "Connected.") });
    emitLobby(room, `${player.name} joined.`);
  });

  socket.on("room:start", (payload, reply) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) {
      reply?.({ ok: false, message: "Room not found." });
      return;
    }
    if (room.hostId !== socket.id) {
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
    if (!room || room.hostId !== socket.id) return;
    socket.to(room.code).emit("game:state", state);
  });

  socket.on("game:shot", shot => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    io.to(room.hostId).emit("game:shot", { ...shot, playerId: socket.id });
  });

  socket.on("disconnect", () => {
    removePlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Mini Golf multiplayer server running at http://localhost:${PORT}`);
});
