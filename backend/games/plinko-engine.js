"use strict";
/*
 * Multiplayer Plinko engine. Server-authoritative: the server flips a fair coin
 * (rng.randInt(2)) once per row to decide the ball's path and the landing slot,
 * then ships the exact path to the dropping client so it can animate the ball
 * deterministically falling into the slot the server already chose.
 *
 * Board: N rows of pegs -> N+1 bottom slots. A ball drops from the top and at
 * each row bounces left (0) or right (1). slot = number of right-bounces (0..N).
 * Counting rights gives a binomial distribution, so middle slots are common and
 * the edges are rare. Multipliers are symmetric, high at the edges and low in
 * the middle, tuned so EV per unit bet is < 1 (house edge).
 *
 * There are no phases/turns: any player may "drop" at any time; each drop is an
 * independent, instantly-resolved round for that player. A small shared
 * recent-wins feed lets everyone see the action without leaking internals.
 */
const { isPosInt, isOneOf, asString } = require("../lib/validate");

const ROWS = 12; // default number of peg rows -> 13 slots

// Symmetric payout arrays of length ROWS+1 (13), high at the edges, low in the
// middle. Each has expected value < 1 (house edge) given binomial slot
// probabilities; see expectedValue() and the tests.
//   low    EV ~ 0.863
//   medium EV ~ 0.864
//   high   EV ~ 0.823
const MULTIPLIERS = {
  low: [3, 2, 1.4, 1.1, 1, 0.8, 0.6, 0.8, 1, 1.1, 1.4, 2, 3],
  medium: [11, 5, 2, 1.3, 1, 0.7, 0.5, 0.7, 1, 1.3, 2, 5, 11],
  high: [50, 15, 4, 2, 0.6, 0.4, 0.3, 0.4, 0.6, 2, 4, 15, 50],
};

const RISKS = Object.keys(MULTIPLIERS); // ["low","medium","high"]
const DEFAULT_RISK = "medium";
const MAX_BET = 1_000_000;
const RECENT_WINS_MAX = 12;

// ---- Pure helpers (exported, tested in isolation) ----

// Normalize a coin source into a function returning 0 or 1. Accepts either a
// function (() => 0|1) for deterministic tests, or an rng object with
// randInt(max) (the production path). The coin must be FAIR.
function _coinFn(rngOrCoin) {
  if (typeof rngOrCoin === "function") return () => (rngOrCoin() ? 1 : 0);
  if (rngOrCoin && typeof rngOrCoin.randInt === "function") {
    return () => rngOrCoin.randInt(2);
  }
  throw new Error("simulatePath: need a coin function or an rng with randInt");
}

// Simulate a ball falling through `rows` peg rows. At each row flip a fair coin:
// 0 = bounce left ('L'), 1 = bounce right ('R'). The landing slot is the number
// of right-bounces (0..rows). Returns { path, slot }; path.length === rows.
function simulatePath(rngOrCoin, rows = ROWS) {
  if (!Number.isInteger(rows) || rows <= 0) throw new Error("simulatePath: rows must be a positive integer");
  const coin = _coinFn(rngOrCoin);
  const path = [];
  let rights = 0;
  for (let i = 0; i < rows; i++) {
    const c = coin();
    if (c === 1) {
      rights++;
      path.push("R");
    } else {
      path.push("L");
    }
  }
  return { path, slot: rights };
}

// Binomial slot probabilities: P(slot=k) = C(rows,k) / 2^rows. Array length
// rows+1, sums to 1, symmetric, peaked in the middle.
function slotProbabilities(rows = ROWS) {
  if (!Number.isInteger(rows) || rows <= 0) throw new Error("slotProbabilities: rows must be a positive integer");
  const probs = new Array(rows + 1);
  const denom = Math.pow(2, rows);
  let c = 1; // C(rows, 0)
  for (let k = 0; k <= rows; k++) {
    probs[k] = c / denom;
    c = (c * (rows - k)) / (k + 1); // C(rows, k+1)
  }
  return probs;
}

// Expected payout per unit bet for a multiplier array: sum_k P(slot=k)*mult[k].
function expectedValue(multipliers, rows = ROWS) {
  if (!Array.isArray(multipliers) || multipliers.length !== rows + 1) {
    throw new Error("expectedValue: multipliers must have length rows+1");
  }
  const probs = slotProbabilities(rows);
  let ev = 0;
  for (let k = 0; k <= rows; k++) ev += probs[k] * multipliers[k];
  return ev;
}

class PlinkoEngine {
  constructor(room, ctx) {
    this.gameId = "plinko";
    this.room = room;
    this.ctx = ctx;
    this.rows = ROWS;
    // viewerId -> last drop result { path, slot, multiplier, bet, payout, risk, at }
    this.lastDrops = new Map();
    // shared feed of recent wins (newest first), no per-player internals
    this.recentWins = [];
  }

  _multipliersFor(risk) {
    return MULTIPLIERS[isOneOf(risk, RISKS) ? risk : DEFAULT_RISK];
  }

  onPlayerLeave(pid) {
    this.lastDrops.delete(pid);
  }

  getPublicState(viewerId) {
    const lastDrop = this.lastDrops.get(viewerId) || null;
    // board config reflects the viewer's own last-used risk (or the default)
    const risk = (lastDrop && lastDrop.risk) || DEFAULT_RISK;
    return {
      gameId: "plinko",
      rows: this.rows,
      risk,
      risks: RISKS.slice(),
      multipliers: this._multipliersFor(risk).slice(),
      multipliersByRisk: {
        low: MULTIPLIERS.low.slice(),
        medium: MULTIPLIERS.medium.slice(),
        high: MULTIPLIERS.high.slice(),
      },
      lastDrop, // viewer's own only — never another player's path
      recentWins: this.recentWins.slice(0, RECENT_WINS_MAX),
    };
  }

  handleAction(pid, action) {
    const player = this.room.getPlayer(pid);
    if (!player) return { ok: false, error: "Unknown player" };
    const type = asString(action && action.type, 20);
    if (type === "drop") return this._drop(pid, action);
    return { ok: false, error: "Unknown action" };
  }

  _drop(pid, action) {
    const bet = action && action.bet;
    if (!isPosInt(bet) || bet > MAX_BET) return { ok: false, error: "Invalid bet amount" };

    const risk = action && action.risk != null ? action.risk : DEFAULT_RISK;
    if (!isOneOf(risk, RISKS)) return { ok: false, error: "Invalid risk" };

    if (!this.room.debit(pid, bet)) return { ok: false, error: "Insufficient balance" };

    const { path, slot } = simulatePath(this.ctx.rng, this.rows);
    const multipliers = this._multipliersFor(risk);
    const multiplier = multipliers[slot];
    const payout = Math.floor(bet * multiplier);
    if (payout > 0) this.room.credit(pid, payout);

    const result = { path, slot, multiplier, bet, payout, risk, at: Date.now() };
    this.lastDrops.set(pid, result);

    const player = this.room.getPlayer(pid);
    this.recentWins.unshift({
      name: (player && player.name) || "Player",
      slot,
      multiplier,
      payout,
      bet,
      risk,
      at: result.at,
    });
    if (this.recentWins.length > RECENT_WINS_MAX) this.recentWins.pop();

    this.ctx.broadcast();
    return { ok: true };
  }

  dispose() {}
}

module.exports = PlinkoEngine;
module.exports.Engine = PlinkoEngine;
module.exports.simulatePath = simulatePath;
module.exports.slotProbabilities = slotProbabilities;
module.exports.expectedValue = expectedValue;
module.exports.MULTIPLIERS = MULTIPLIERS;
module.exports.ROWS = ROWS;
module.exports.RISKS = RISKS;
module.exports.DEFAULT_RISK = DEFAULT_RISK;
