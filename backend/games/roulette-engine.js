"use strict";
/*
 * Multiplayer Roulette engine. Reuses the proven pure payout logic in
 * roulette-core.js. Players place chips on bet "keys" (the same key scheme the
 * frontend uses: straight:N, split:a-b, street:c, corner:tl, line:c, column:c,
 * dozen:d, red/black/odd/even/low/high). The server stores the covered numbers
 * authoritatively (computed here) so a client cannot lie about what a bet covers.
 *
 * Phases: "betting" -> "spinning" -> back to "betting". Any player may trigger
 * the spin once at least one bet is on the table; all bets resolve together.
 */
const Core = require("./roulette-core");
const { isPosInt, asString } = require("../lib/validate");

const PAYOUT_TYPES = Object.keys(Core.PAYOUTS);

// Build the covered-number array for a given bet key, server-side. Returns
// { type, numbers } or null if the key is invalid.
function resolveKey(key) {
  if (typeof key !== "string") return null;
  const [head, tail] = key.split(":");
  switch (head) {
    case "straight": {
      const n = Number(tail);
      if (!Number.isInteger(n) || n < 0 || n > 36) return null;
      return { type: "straight", numbers: [n] };
    }
    case "split": {
      const parts = (tail || "").split("-").map(Number);
      if (parts.length !== 2 || parts.some((x) => !Number.isInteger(x))) return null;
      const nums = Core.splitNumbers(parts[0], parts[1]);
      return nums ? { type: "split", numbers: nums } : null;
    }
    case "street": {
      const nums = Core.streetNumbers(Number(tail));
      return nums ? { type: "street", numbers: nums } : null;
    }
    case "corner": {
      // basket (0,1,2,3) is keyed corner:0 in our scheme
      if (tail === "0") return { type: "corner", numbers: [0, 1, 2, 3] };
      const nums = Core.cornerNumbers(Number(tail));
      return nums ? { type: "corner", numbers: nums } : null;
    }
    case "line": {
      const nums = Core.lineNumbers(Number(tail));
      return nums ? { type: "line", numbers: nums } : null;
    }
    case "column": {
      const c = Number(tail);
      if (![1, 2, 3].includes(c)) return null;
      const nums = [];
      for (let i = 0; i < 12; i++) nums.push(c + i * 3);
      return { type: "column", numbers: nums };
    }
    case "dozen": {
      const d = Number(tail);
      if (![1, 2, 3].includes(d)) return null;
      const start = (d - 1) * 12 + 1;
      return { type: "dozen", numbers: Array.from({ length: 12 }, (_, i) => start + i) };
    }
    default: {
      // even-money bets carry no tail
      if (["red", "black", "odd", "even", "low", "high"].includes(head)) {
        return { type: head };
      }
      return null;
    }
  }
}

class RouletteEngine {
  constructor(room, ctx) {
    this.gameId = "roulette";
    this.room = room;
    this.ctx = ctx;
    this.phase = "betting";
    // bets: persistentId -> Map(key -> { type, numbers, amount })
    this.bets = new Map();
    this.history = []; // recent results (numbers), newest first
    this.lastResult = null;
    this.lastSpin = null; // { result, perPlayer: {pid: {staked, returned, net}} }
  }

  _playerBets(pid) {
    let m = this.bets.get(pid);
    if (!m) {
      m = new Map();
      this.bets.set(pid, m);
    }
    return m;
  }

  onPlayerLeave(pid) {
    // refund un-spun bets on leave so chips aren't lost mid-round
    if (this.phase === "betting") this._refund(pid);
    this.bets.delete(pid);
  }

  _refund(pid) {
    const m = this.bets.get(pid);
    if (!m) return;
    let total = 0;
    for (const b of m.values()) total += b.amount;
    if (total > 0) this.room.credit(pid, total);
    m.clear();
  }

  getPublicState(viewerId) {
    const myBets = [];
    const m = this.bets.get(viewerId);
    if (m) for (const [key, b] of m) myBets.push({ key, type: b.type, amount: b.amount });
    // aggregate table stake per key (all players) so everyone sees the action
    const tableByKey = {};
    let tableTotal = 0;
    for (const pm of this.bets.values()) {
      for (const [key, b] of pm) {
        tableByKey[key] = (tableByKey[key] || 0) + b.amount;
        tableTotal += b.amount;
      }
    }
    return {
      gameId: "roulette",
      phase: this.phase,
      myBets,
      tableByKey,
      tableTotal,
      history: this.history.slice(0, 18),
      lastResult: this.lastResult,
      lastSpin: this.lastSpin,
    };
  }

  handleAction(pid, action) {
    const player = this.room.getPlayer(pid);
    if (!player) return { ok: false, error: "Unknown player" };
    const type = asString(action && action.type, 20);
    switch (type) {
      case "placeBet":
        return this._placeBet(pid, action);
      case "removeBet":
        return this._removeBet(pid, action);
      case "clearBets":
        if (this.phase !== "betting") return { ok: false, error: "Round in play" };
        this._refund(pid);
        this.ctx.broadcast();
        return { ok: true };
      case "spin":
        return this._spin(pid);
      default:
        return { ok: false, error: "Unknown action" };
    }
  }

  _placeBet(pid, action) {
    if (this.phase !== "betting") return { ok: false, error: "No more bets — round in play" };
    const key = asString(action && action.key, 24);
    const amount = action && action.amount;
    if (!isPosInt(amount) || amount > 100000) return { ok: false, error: "Invalid bet amount" };
    const resolved = resolveKey(key);
    if (!resolved) return { ok: false, error: "Invalid bet" };
    if (!this.room.debit(pid, amount)) return { ok: false, error: "Insufficient balance" };
    const m = this._playerBets(pid);
    const existing = m.get(key);
    if (existing) existing.amount += amount;
    else m.set(key, { type: resolved.type, numbers: resolved.numbers, amount });
    this.ctx.broadcast();
    return { ok: true };
  }

  _removeBet(pid, action) {
    if (this.phase !== "betting") return { ok: false, error: "Round in play" };
    const key = asString(action && action.key, 24);
    const amount = action && action.amount;
    const m = this.bets.get(pid);
    const bet = m && m.get(key);
    if (!bet) return { ok: false, error: "No such bet" };
    const dec = isPosInt(amount) ? Math.min(amount, bet.amount) : bet.amount;
    bet.amount -= dec;
    this.room.credit(pid, dec);
    if (bet.amount <= 0) m.delete(key);
    this.ctx.broadcast();
    return { ok: true };
  }

  _spin(pid) {
    if (this.phase !== "betting") return { ok: false, error: "Already spinning" };
    let anyBets = false;
    for (const m of this.bets.values()) if (m.size > 0) { anyBets = true; break; }
    if (!anyBets) return { ok: false, error: "No bets on the table" };

    this.phase = "spinning";
    const result = Core.spinResult();
    this.lastResult = result;

    const perPlayer = {};
    for (const [bpid, m] of this.bets) {
      const betArr = Array.from(m.values());
      const outcome = Core.resolveBets(betArr, result);
      if (outcome.totalReturned > 0) this.room.credit(bpid, outcome.totalReturned);
      perPlayer[bpid] = {
        staked: outcome.totalStaked,
        returned: outcome.totalReturned,
        net: outcome.netProfit,
      };
    }
    this.lastSpin = { result, color: Core.colorOf(result), perPlayer, at: Date.now(), by: pid };
    this.history.unshift(result);
    if (this.history.length > 30) this.history.pop();

    // broadcast the spinning state (so clients animate), then settle after the
    // animation window and re-open betting.
    this.ctx.broadcast();
    this._spinTimer = setTimeout(() => {
      this.phase = "betting";
      this.bets.clear();
      this.ctx.broadcast();
    }, 6500);
    return { ok: true };
  }

  dispose() {
    if (this._spinTimer) clearTimeout(this._spinTimer);
  }
}

module.exports = RouletteEngine;
module.exports.resolveKey = resolveKey;
module.exports.Engine = RouletteEngine;
