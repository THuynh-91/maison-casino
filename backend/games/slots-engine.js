"use strict";
/*
 * Multiplayer Slots engine.
 *
 * Each player spins their OWN 5-reel x 3-row machine (server-authoritative),
 * but all machines live in one shared room so everyone sees a small feed of
 * recent big wins. There are no shared phases / turns: a spin resolves
 * instantly for the spinning player only.
 *
 * --- Grid -------------------------------------------------------------------
 * 5 reels (columns) x 3 rows. grid[col][row], col in [0,4], row in [0,2].
 * Each cell holds one symbol id, chosen independently with weighted RNG.
 *
 * --- Symbols & weights ------------------------------------------------------
 * Rarer symbols are worth more. WILD is the rarest and substitutes for any
 * symbol when forming a left-to-right run. Weights are relative (they need
 * not sum to anything in particular); the weighted picker normalizes them.
 *
 *   id      weight   note
 *   cherry    32     most common, smallest pay
 *   lemon     26
 *   bell      18
 *   star      12
 *   seven      8     high value
 *   wild       4     rarest, substitutes for any symbol
 *
 * --- Paylines (5) -----------------------------------------------------------
 * Each payline is an array of 5 [col,row] cells, one per reel, read left to
 * right. We use the 3 straight rows plus the two diagonals (V and ^):
 *   0: top row
 *   1: middle row
 *   2: bottom row
 *   3: V-diagonal  (top-left down to middle then back up)
 *   4: ^-diagonal  (bottom-left up to middle then back down)
 *
 * --- Paytable ---------------------------------------------------------------
 * PAYTABLE[symbol] = { 3, 4, 5 } multipliers applied to the PER-LINE stake.
 * The per-line stake = bet / PAYLINES.length (we evaluate every payline as
 * active and split the stake evenly across them, classic "bet covers all
 * lines" model). A payline pays for the longest left-to-right run (>=3) of a
 * single symbol starting at reel 0, with WILD substituting for that symbol.
 * Only the single best (longest) run on a line is paid, standard slot rules.
 */

const { isPosInt } = require("../lib/validate");

const REELS = 5;
const ROWS = 3;

// --- Symbol set with relative weights (rarer pays more) ---------------------
const SYMBOLS = [
  { id: "cherry", weight: 32 },
  { id: "lemon", weight: 26 },
  { id: "bell", weight: 18 },
  { id: "star", weight: 12 },
  { id: "seven", weight: 8 },
  { id: "wild", weight: 4 },
];

const WILD = "wild";

// --- Paylines: 3 rows + 2 diagonals over the 5x3 grid -----------------------
// Each entry is 5 [col,row] pairs, one per reel.
const PAYLINES = [
  // top row
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  // middle row
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]],
  // bottom row
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  // V-diagonal: top -> middle -> bottom-ish -> middle -> top
  [[0, 0], [1, 1], [2, 2], [3, 1], [4, 0]],
  // ^-diagonal: bottom -> middle -> top -> middle -> bottom
  [[0, 2], [1, 1], [2, 0], [3, 1], [4, 2]],
];

// --- Paytable: multipliers on the per-line stake, by run length -------------
// Tuned so the overall RTP is < 1 (house edge) while wins hit regularly.
const PAYTABLE = {
  cherry: { 3: 2, 4: 8, 5: 20 },
  lemon: { 3: 5, 4: 14, 5: 35 },
  bell: { 3: 10, 4: 28, 5: 70 },
  star: { 3: 22, 4: 55, 5: 160 },
  seven: { 3: 40, 4: 130, 5: 500 },
  wild: { 3: 60, 4: 250, 5: 1200 },
};

// --- Weighted symbol picker -------------------------------------------------
// rng must expose randInt(n) -> uniform integer in [0, n). Returns a symbol id.
function weightedPick(rng, symbols = SYMBOLS) {
  let total = 0;
  for (const s of symbols) total += s.weight;
  // pick an integer in [0, total) and walk the cumulative weights
  let r = rng.randInt(total);
  for (const s of symbols) {
    if (r < s.weight) return s.id;
    r -= s.weight;
  }
  // unreachable if weights are positive integers, but be safe
  return symbols[symbols.length - 1].id;
}

// Build a full 5x3 grid: grid[col] = [row0, row1, row2].
function spinGrid(rng, symbols = SYMBOLS) {
  const grid = [];
  for (let c = 0; c < REELS; c++) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(weightedPick(rng, symbols));
    grid.push(col);
  }
  return grid;
}

// --- Pure line evaluation ---------------------------------------------------
// Evaluate one payline. Returns { symbol, count, amount } for the best
// (longest) left-to-right run of >=3, or null if no paying run.
//   line     : array of [col,row] cells
//   grid     : grid[col][row]
//   paytable : PAYTABLE
//   lineBet  : the stake assigned to this single line
function evaluateLine(line, grid, paytable, lineBet) {
  // Read the symbols along the line, left to right.
  const cells = line.map(([c, r]) => grid[c][r]);

  // Determine the "base" symbol of the run starting at reel 0. If reel 0 is a
  // wild, the run takes the identity of the first non-wild symbol; an all-wild
  // run counts as wild.
  let base = cells[0];
  if (base === WILD) {
    const firstNonWild = cells.find((s) => s !== WILD);
    base = firstNonWild === undefined ? WILD : firstNonWild;
  }

  // Count consecutive matches from reel 0: a cell matches if it equals base or
  // is a wild.
  let count = 0;
  for (const s of cells) {
    if (s === base || s === WILD) count++;
    else break;
  }

  if (count < 3) return null;
  const table = paytable[base];
  if (!table || !table[count]) return null;
  const amount = Math.floor(table[count] * lineBet);
  if (amount <= 0) return null;
  return { symbol: base, count, amount };
}

// --- Pure spin computation --------------------------------------------------
// Given a grid + paylines + paytable + total bet, compute the total win and
// the list of winning lines. The per-line stake is bet split evenly across
// all paylines (so larger bets scale wins linearly).
//   returns { win, lines: [{ lineIndex, symbol, count, amount }] }
function computeSpin(grid, paylines, paytable, bet) {
  const lineBet = bet / paylines.length;
  let win = 0;
  const lines = [];
  for (let i = 0; i < paylines.length; i++) {
    const res = evaluateLine(paylines[i], grid, paytable, lineBet);
    if (res) {
      lines.push({ lineIndex: i, symbol: res.symbol, count: res.count, amount: res.amount });
      win += res.amount;
    }
  }
  return { win, lines };
}

const MAX_BET = 100000;
const BIG_WIN_FEED_LEN = 8;

class SlotsEngine {
  constructor(room, ctx) {
    this.gameId = "slots";
    this.room = room;
    this.ctx = ctx;
    // per-player last spin: persistentId -> { grid, lines, win, bet, at }
    this.lastSpins = new Map();
    // shared feed of recent wins (any sizeable win), newest first
    this.recentWins = []; // { name, amount, at }
  }

  onPlayerLeave(pid) {
    this.lastSpins.delete(pid);
  }

  getPublicState(viewerId) {
    const mine = this.lastSpins.get(viewerId) || null;
    return {
      gameId: "slots",
      reels: REELS,
      rows: ROWS,
      symbols: SYMBOLS,
      paylines: PAYLINES,
      paytable: PAYTABLE,
      maxBet: MAX_BET,
      // viewer's own last spin only — never another player's full grid
      lastSpin: mine
        ? { grid: mine.grid, lines: mine.lines, win: mine.win, bet: mine.bet, at: mine.at }
        : null,
      // shared, low-information feed: who won and how much
      recentWins: this.recentWins.slice(0, BIG_WIN_FEED_LEN),
    };
  }

  handleAction(pid, action) {
    const player = this.room.getPlayer(pid);
    if (!player) return { ok: false, error: "Unknown player" };
    if (!action || action.type !== "spin") return { ok: false, error: "Unknown action" };

    const bet = action.bet;
    if (!isPosInt(bet) || bet > MAX_BET) return { ok: false, error: "Invalid bet amount" };
    if (player.balance < bet) return { ok: false, error: "Insufficient balance" };
    if (!this.room.debit(pid, bet)) return { ok: false, error: "Insufficient balance" };

    const grid = spinGrid(this.ctx.rng);
    const { win, lines } = computeSpin(grid, PAYLINES, PAYTABLE, bet);
    if (win > 0) this.room.credit(pid, win);

    const at = Date.now();
    this.lastSpins.set(pid, { grid, lines, win, bet, at });

    // Add to shared feed when the player wins at least their stake back (a
    // "notable" win), so the feed shows wins without leaking grid details.
    if (win >= bet && win > 0) {
      this.recentWins.unshift({ name: player.name, amount: win, at });
      if (this.recentWins.length > 30) this.recentWins.pop();
    }

    this.ctx.broadcast();
    return { ok: true };
  }

  dispose() {
    this.lastSpins.clear();
    this.recentWins.length = 0;
  }
}

module.exports = SlotsEngine;
module.exports.Engine = SlotsEngine;
module.exports.computeSpin = computeSpin;
module.exports.evaluateLine = evaluateLine;
module.exports.weightedPick = weightedPick;
module.exports.spinGrid = spinGrid;
module.exports.SYMBOLS = SYMBOLS;
module.exports.PAYLINES = PAYLINES;
module.exports.PAYTABLE = PAYTABLE;
module.exports.WILD = WILD;
module.exports.REELS = REELS;
module.exports.ROWS = ROWS;
