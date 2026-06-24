"use strict";
/*
 * Casino server: Express (serves the frontend) + Socket.io (real-time rooms).
 *
 * Ports (override via env): FRONTEND served on PORT (default 4900); Socket.io
 * shares the same HTTP server. (We keep a single port for simplicity; the
 * frontend connects to its own origin.)
 *
 * Admin: ADMIN_PASSWORD env (default "letmein" — NOT a real secret, documented).
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const { CasinoManager } = require("./lib/manager");
const { listGames } = require("./games/registry");
const { asString, isPosInt, isNonNegInt } = require("./lib/validate");

const PORT = parseInt(process.env.PORT, 10) || 4900;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "letmein";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve the frontend statically.
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));
// Also expose the legacy single-player roulette files at /legacy for reference.
app.use("/legacy", express.static(path.join(__dirname, "..")));

app.get("/healthz", (_req, res) => res.json({ ok: true, ...manager.stats() }));

// Broadcast each room's per-viewer state to its sockets.
function broadcastRoom(code) {
  const room = manager.getRoom(code);
  if (!room) return;
  const socketsInRoom = io.sockets.adapter.rooms.get("room:" + code);
  if (!socketsInRoom) return;
  for (const sid of socketsInRoom) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    const pid = s.data.persistentId;
    s.emit("room:state", room.publicState(pid));
  }
}

const manager = new CasinoManager(broadcastRoom);

setInterval(() => manager.cleanupEmptyRooms(), 30000).unref();

// ---- Socket.io wiring ----
io.on("connection", (socket) => {
  socket.data.roomCode = null;
  socket.data.persistentId = null;
  socket.data.isAdmin = false;

  function currentRoom() {
    return socket.data.roomCode ? manager.getRoom(socket.data.roomCode) : null;
  }

  function reply(cb, payload) {
    if (typeof cb === "function") cb(payload);
  }

  socket.emit("games:list", listGames());

  // Create a new room and join it.
  socket.on("room:create", (data, cb) => {
    const name = asString(data && data.name, 24) || "Player";
    const persistentId = asString(data && data.persistentId, 40) || socket.id;
    const room = manager.createRoom();
    joinRoom(room, persistentId, name, cb);
  });

  // Join an existing room by code.
  socket.on("room:join", (data, cb) => {
    const code = asString(data && data.code, 8).toUpperCase();
    const name = asString(data && data.name, 24) || "Player";
    const persistentId = asString(data && data.persistentId, 40) || socket.id;
    const room = manager.getRoom(code);
    if (!room) return reply(cb, { ok: false, error: "Room not found" });
    joinRoom(room, persistentId, name, cb);
  });

  function joinRoom(room, persistentId, name, cb) {
    // leave any previous room
    if (socket.data.roomCode) {
      socket.leave("room:" + socket.data.roomCode);
      const prev = manager.getRoom(socket.data.roomCode);
      if (prev) {
        prev.markDisconnected(socket.data.persistentId);
        broadcastRoom(prev.code);
      }
    }
    const player = room.addPlayer(persistentId, socket.id, name);
    socket.data.roomCode = room.code;
    socket.data.persistentId = persistentId;
    socket.join("room:" + room.code);
    reply(cb, { ok: true, code: room.code, you: player.publicView(), state: room.publicState(persistentId) });
    broadcastRoom(room.code);
  }

  // Explicit state fetch (handy for clients after reconnect / on demand).
  socket.on("state:get", (_data, cb) => {
    const room = currentRoom();
    if (!room) return reply(cb, { ok: false, error: "Not in a room" });
    reply(cb, { ok: true, state: room.publicState(socket.data.persistentId) });
  });

  // Pick a game for the room (any player can switch the room's table).
  socket.on("game:select", (data, cb) => {
    const room = currentRoom();
    if (!room) return reply(cb, { ok: false, error: "Not in a room" });
    const gameId = asString(data && data.gameId, 20);
    const res = manager.selectGame(room, gameId);
    if (res.ok) broadcastRoom(room.code);
    reply(cb, res);
  });

  // Generic game action -> routed to the room's engine.
  socket.on("game:action", (data, cb) => {
    const room = currentRoom();
    if (!room) return reply(cb, { ok: false, error: "Not in a room" });
    if (!room.engine) return reply(cb, { ok: false, error: "No game selected" });
    if (data === null || typeof data !== "object") return reply(cb, { ok: false, error: "Bad payload" });
    let res;
    try {
      res = room.engine.handleAction(socket.data.persistentId, data);
    } catch (e) {
      console.error("engine error:", e);
      res = { ok: false, error: "Server error" };
    }
    reply(cb, res || { ok: true });
  });

  // ---- Admin ----
  socket.on("admin:login", (data, cb) => {
    const pw = asString(data && data.password, 60);
    if (pw === ADMIN_PASSWORD) {
      socket.data.isAdmin = true;
      const room = currentRoom();
      if (room) {
        const p = room.getPlayer(socket.data.persistentId);
        if (p) p.isAdmin = true;
        broadcastRoom(room.code);
      }
      return reply(cb, { ok: true });
    }
    reply(cb, { ok: false, error: "Wrong password" });
  });

  socket.on("admin:action", (data, cb) => {
    if (!socket.data.isAdmin) return reply(cb, { ok: false, error: "Not authorized" });
    const room = currentRoom();
    if (!room) return reply(cb, { ok: false, error: "Not in a room" });
    const type = asString(data && data.type, 20);
    const target = asString(data && data.persistentId, 40);
    const amount = data && data.amount;
    let ok = false;
    switch (type) {
      case "grant":
        if (!isPosInt(amount)) return reply(cb, { ok: false, error: "Bad amount" });
        ok = manager.adminGrant(room, target, amount);
        break;
      case "setBalance":
        if (!isNonNegInt(amount)) return reply(cb, { ok: false, error: "Bad amount" });
        ok = manager.adminSetBalance(room, target, amount);
        break;
      case "grantAll":
        if (!isPosInt(amount)) return reply(cb, { ok: false, error: "Bad amount" });
        ok = manager.adminGrantAll(room, amount);
        break;
      case "kick":
        ok = manager.adminKick(room, target);
        // also force-disconnect their socket(s)
        for (const s of io.sockets.sockets.values()) {
          if (s.data.roomCode === room.code && s.data.persistentId === target) {
            s.leave("room:" + room.code);
            s.emit("room:kicked");
            s.data.roomCode = null;
          }
        }
        break;
      case "selectGame":
        ok = manager.selectGame(room, asString(data && data.gameId, 20)).ok;
        break;
      default:
        return reply(cb, { ok: false, error: "Unknown admin action" });
    }
    if (ok) broadcastRoom(room.code);
    reply(cb, { ok });
  });

  socket.on("disconnect", () => {
    const room = currentRoom();
    if (room) {
      room.markDisconnected(socket.data.persistentId);
      broadcastRoom(room.code);
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Casino server listening on http://localhost:${PORT}`);
    console.log(`Admin password: "${ADMIN_PASSWORD}" (set ADMIN_PASSWORD env to change)`);
  });
}

module.exports = { app, server, io, manager };
