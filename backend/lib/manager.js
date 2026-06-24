"use strict";
/*
 * CasinoManager: owns all rooms, wires engines, and provides admin operations.
 * It is transport-agnostic — server.js adapts Socket.io events onto it.
 */
const { Room, makeRoomCode } = require("./rooms");
const rng = require("./rng");
const { getEngineClass } = require("../games/registry");

function makeLogger(ns) {
  return (...args) => console.log(`[${ns}]`, ...args);
}

class CasinoManager {
  constructor(emitter) {
    // emitter(roomCode) -> called whenever a room's state changes; server wires
    // this to broadcast room state to that room's sockets.
    this.rooms = new Map(); // code -> Room
    this.emit = emitter || (() => {});
  }

  _ctxFor(room) {
    return {
      broadcast: () => this.emit(room.code),
      rng,
      log: makeLogger("room:" + room.code),
    };
  }

  createRoom() {
    let code;
    do {
      code = makeRoomCode();
    } while (this.rooms.has(code));
    const room = new Room(code, null);
    room.ctx = this._ctxFor(room);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  selectGame(room, gameId) {
    if (gameId === "lobby") {
      if (room.engine && room.engine.dispose) room.engine.dispose();
      room.engine = null;
      room.gameId = "lobby";
      return { ok: true };
    }
    const EngineClass = getEngineClass(gameId);
    if (!EngineClass) return { ok: false, error: "Game not available" };
    if (room.engine && room.engine.dispose) room.engine.dispose();
    room.engine = new EngineClass(room, this._ctxFor(room));
    room.gameId = gameId;
    // seat existing players if the engine wants
    if (room.engine.onPlayerJoin) {
      for (const pid of room.players.keys()) room.engine.onPlayerJoin(pid);
    }
    return { ok: true };
  }

  // ---- Admin operations (called only after admin auth in server.js) ----
  adminGrant(room, persistentId, amount) {
    return room.credit(persistentId, amount);
  }
  adminSetBalance(room, persistentId, amount) {
    return room.setBalance(persistentId, amount);
  }
  adminKick(room, persistentId) {
    room.removePlayer(persistentId);
    return true;
  }
  adminGrantAll(room, amount) {
    for (const pid of room.players.keys()) room.credit(pid, amount);
    return true;
  }

  cleanupEmptyRooms() {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && Date.now() - room.createdAt > 60000) {
        if (room.engine && room.engine.dispose) room.engine.dispose();
        this.rooms.delete(code);
      }
    }
  }

  stats() {
    return {
      rooms: this.rooms.size,
      players: Array.from(this.rooms.values()).reduce((s, r) => s + r.players.size, 0),
    };
  }
}

module.exports = { CasinoManager };
