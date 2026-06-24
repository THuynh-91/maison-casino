"use strict";
/*
 * Room + player + money model for the casino.
 *
 * A Room holds players (each with a server-authoritative chip balance), the
 * currently selected game, and the live game-engine instance. All money lives
 * here on the server; clients never mutate balances directly.
 *
 * Engines implement a small contract (see backend/games/engine-contract.md):
 *   new Engine(room, ctx)          ctx = { broadcast, rng, log }
 *   engine.getPublicState(playerId)-> serializable state for a given viewer
 *   engine.handleAction(playerId, action) -> { ok, error?, state? }
 *   engine.onPlayerJoin(playerId) / onPlayerLeave(playerId)   (optional)
 *   engine.gameId  (string)
 *
 * Engines call back into the room via ctx for chip movement:
 *   room.debit(playerId, amount) / room.credit(playerId, amount)
 */

const { randInt } = require("./rng");

const STARTING_BALANCE = 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars

function makeRoomCode() {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_CHARS[randInt(CODE_CHARS.length)];
  return s;
}

class Player {
  constructor(id, name) {
    this.id = id; // socket id (current connection)
    this.persistentId = id; // stable id across reconnects (set by manager)
    this.name = name;
    this.balance = STARTING_BALANCE;
    this.connected = true;
    this.isAdmin = false;
    this.seat = null; // seat index in seated games (blackjack/poker)
  }
  publicView() {
    return {
      id: this.persistentId,
      name: this.name,
      balance: this.balance,
      connected: this.connected,
      isAdmin: this.isAdmin,
      seat: this.seat,
    };
  }
}

class Room {
  constructor(code, ctx) {
    this.code = code;
    this.ctx = ctx; // { broadcast(room), log }
    this.players = new Map(); // persistentId -> Player
    this.gameId = "lobby";
    this.engine = null;
    this.createdAt = Date.now();
  }

  addPlayer(persistentId, socketId, name) {
    let p = this.players.get(persistentId);
    if (p) {
      // reconnect
      p.id = socketId;
      p.connected = true;
      if (name) p.name = name;
    } else {
      p = new Player(socketId, name || "Player");
      p.persistentId = persistentId;
      this.players.set(persistentId, p);
    }
    if (this.engine && this.engine.onPlayerJoin) this.engine.onPlayerJoin(persistentId);
    return p;
  }

  getPlayer(persistentId) {
    return this.players.get(persistentId);
  }

  removePlayer(persistentId) {
    const p = this.players.get(persistentId);
    if (!p) return;
    if (this.engine && this.engine.onPlayerLeave) this.engine.onPlayerLeave(persistentId);
    this.players.delete(persistentId);
  }

  markDisconnected(persistentId) {
    const p = this.players.get(persistentId);
    if (p) p.connected = false;
    if (this.engine && this.engine.onPlayerLeave) this.engine.onPlayerLeave(persistentId);
  }

  // ---- Money: server-authoritative ----
  debit(persistentId, amount) {
    const p = this.players.get(persistentId);
    if (!p) return false;
    amount = Math.floor(amount);
    if (amount <= 0 || p.balance < amount) return false;
    p.balance -= amount;
    return true;
  }
  credit(persistentId, amount) {
    const p = this.players.get(persistentId);
    if (!p) return false;
    amount = Math.floor(amount);
    if (amount <= 0) return false;
    p.balance += amount;
    return true;
  }
  setBalance(persistentId, amount) {
    const p = this.players.get(persistentId);
    if (!p) return false;
    amount = Math.max(0, Math.floor(amount));
    p.balance = amount;
    return true;
  }

  playerList() {
    return Array.from(this.players.values()).map((p) => p.publicView());
  }

  publicState(viewerId) {
    return {
      code: this.code,
      gameId: this.gameId,
      players: this.playerList(),
      game: this.engine ? this.engine.getPublicState(viewerId) : null,
    };
  }

  isEmpty() {
    // empty if no connected players
    return Array.from(this.players.values()).every((p) => !p.connected);
  }
}

module.exports = { Room, Player, makeRoomCode, STARTING_BALANCE };
