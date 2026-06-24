import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const Slots = require("../backend/games/slots-engine.js");

const { computeSpin, evaluateLine, weightedPick, spinGrid, SYMBOLS, PAYLINES, PAYTABLE } = Slots;

// A real, unbiased RNG matching the lib/rng contract (randInt(n) -> [0,n)).
const rng = {
  randInt(max) {
    if (!Number.isInteger(max) || max <= 0) throw new Error("bad max");
    if (max === 1) return 0;
    const limit = Math.floor(0xffffffff / max) * max;
    let x;
    do {
      x = crypto.randomBytes(4).readUInt32BE(0);
    } while (x >= limit);
    return x % max;
  },
};

// Helper: build a 5x3 grid from 3 rows of 5 symbols (row-major, readable).
function gridFromRows(rows) {
  // rows: [ [r0c0..r0c4], [r1...], [r2...] ]
  const grid = [];
  for (let c = 0; c < 5; c++) grid.push([rows[0][c], rows[1][c], rows[2][c]]);
  return grid;
}

// ---- computeSpin: known wins -------------------------------------------------

test("3-of-a-kind on the top row pays the right amount", () => {
  // bet 100, 5 lines -> lineBet 20. cherry 3-of-a-kind multiplier = 2.
  const grid = gridFromRows([
    ["cherry", "cherry", "cherry", "lemon", "bell"],
    ["seven", "star", "bell", "seven", "lemon"],
    ["bell", "lemon", "star", "cherry", "seven"],
  ]);
  const { win, lines } = computeSpin(grid, PAYLINES, PAYTABLE, 100);
  // top row: cherry x3 then lemon breaks -> count 3 -> 1 * 20 = 20
  const topLine = lines.find((l) => l.lineIndex === 0);
  assert.ok(topLine, "expected a winning top row");
  assert.equal(topLine.symbol, "cherry");
  assert.equal(topLine.count, 3);
  assert.equal(topLine.amount, 40); // 2 * 20
  // top row is the only winning line here
  assert.equal(lines.length, 1);
  assert.equal(win, 40);
});

test("5-of-a-kind pays more than 3-of-a-kind for the same symbol", () => {
  const three = gridFromRows([
    ["seven", "seven", "seven", "cherry", "lemon"],
    ["lemon", "bell", "star", "bell", "cherry"],
    ["bell", "star", "lemon", "seven", "bell"],
  ]);
  const five = gridFromRows([
    ["seven", "seven", "seven", "seven", "seven"],
    ["lemon", "bell", "star", "bell", "cherry"],
    ["bell", "star", "lemon", "cherry", "bell"],
  ]);
  const r3 = computeSpin(three, PAYLINES, PAYTABLE, 100);
  const r5 = computeSpin(five, PAYLINES, PAYTABLE, 100);
  // lineBet 20: seven 3 -> 40*20=800 ; seven 5 -> 500*20=10000
  assert.equal(r3.win, 800);
  assert.equal(r5.win, 10000);
  assert.ok(r5.win > r3.win);
});

test("wild substitutes to complete a line", () => {
  // top row: bell, bell, wild, bell, lemon -> bell run of 4 (wild fills reel 2).
  // Evaluate the top payline directly so other lines don't affect the assertion.
  const grid = gridFromRows([
    ["bell", "bell", "wild", "bell", "lemon"],
    ["cherry", "star", "lemon", "seven", "cherry"],
    ["star", "lemon", "cherry", "lemon", "seven"],
  ]);
  const top = evaluateLine(PAYLINES[0], grid, PAYTABLE, 20);
  assert.ok(top, "wild should complete the bell run");
  assert.equal(top.symbol, "bell");
  assert.equal(top.count, 4);
  // bell 4-of-a-kind = 28 * lineBet(20) = 560
  assert.equal(top.amount, 560);
});

test("leading wild takes the identity of the next symbol", () => {
  // top row: wild, seven, seven, cherry, lemon -> base = seven, count 3
  const grid = gridFromRows([
    ["wild", "seven", "seven", "cherry", "lemon"],
    ["cherry", "star", "lemon", "bell", "cherry"],
    ["star", "lemon", "cherry", "star", "bell"],
  ]);
  const top = evaluateLine(PAYLINES[0], grid, PAYTABLE, 20);
  assert.ok(top);
  assert.equal(top.symbol, "seven");
  assert.equal(top.count, 3);
  assert.equal(top.amount, 40 * 20);
});

test("all-wild line counts as wild and pays the wild table", () => {
  // A run only counts as WILD when the entire line is wild; a non-wild later on
  // the line would instead become the run's base symbol.
  const grid = gridFromRows([
    ["wild", "wild", "wild", "wild", "wild"],
    ["cherry", "star", "lemon", "bell", "cherry"],
    ["star", "lemon", "cherry", "star", "bell"],
  ]);
  const top = evaluateLine(PAYLINES[0], grid, PAYTABLE, 20);
  assert.ok(top);
  assert.equal(top.symbol, "wild");
  assert.equal(top.count, 5);
  assert.equal(top.amount, PAYTABLE.wild[5] * 20);
});

test("no match pays 0", () => {
  // engineered so no payline has a 3+ run from reel 0
  const grid = gridFromRows([
    ["cherry", "lemon", "cherry", "lemon", "cherry"],
    ["lemon", "cherry", "lemon", "cherry", "lemon"],
    ["bell", "star", "bell", "star", "bell"],
  ]);
  const { win, lines } = computeSpin(grid, PAYLINES, PAYTABLE, 100);
  assert.equal(win, 0);
  assert.equal(lines.length, 0);
});

test("multiple simultaneous winning lines sum correctly", () => {
  // top row cherry x3, middle row lemon x3 -> two winning lines
  const grid = gridFromRows([
    ["cherry", "cherry", "cherry", "bell", "star"],
    ["lemon", "lemon", "lemon", "bell", "star"],
    ["bell", "star", "seven", "cherry", "lemon"],
  ]);
  const { win, lines } = computeSpin(grid, PAYLINES, PAYTABLE, 100);
  const idxs = lines.map((l) => l.lineIndex).sort();
  assert.deepEqual(idxs, [0, 1]);
  // cherry3 = 2*20 = 40 ; lemon3 = 5*20 = 100 ; sum 140
  assert.equal(win, 140);
  const summed = lines.reduce((a, l) => a + l.amount, 0);
  assert.equal(summed, win);
});

test("a run shorter than 3 does not pay", () => {
  const grid = gridFromRows([
    ["seven", "seven", "cherry", "lemon", "bell"],
    ["lemon", "bell", "star", "bell", "cherry"],
    ["bell", "star", "lemon", "seven", "bell"],
  ]);
  const { win, lines } = computeSpin(grid, PAYLINES, PAYTABLE, 100);
  assert.equal(win, 0);
  assert.equal(lines.length, 0);
});

// ---- weighted picker ---------------------------------------------------------

test("weightedPick only ever returns valid symbol ids", () => {
  const valid = new Set(SYMBOLS.map((s) => s.id));
  for (let i = 0; i < 5000; i++) {
    assert.ok(valid.has(weightedPick(rng)), "picked an unknown symbol");
  }
});

test("rarer symbols appear less often than common ones", () => {
  const counts = Object.create(null);
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const s = weightedPick(rng);
    counts[s] = (counts[s] || 0) + 1;
  }
  // weight order: cherry > lemon > bell > star > seven > wild
  assert.ok(counts.cherry > counts.lemon, "cherry should beat lemon");
  assert.ok(counts.lemon > counts.bell, "lemon should beat bell");
  assert.ok(counts.bell > counts.star, "bell should beat star");
  assert.ok(counts.star > counts.seven, "star should beat seven");
  assert.ok(counts.seven > counts.wild, "seven should beat wild");

  // sanity: observed frequency of cherry near its weight share (32/100)
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, N);
  const cherryFreq = counts.cherry / total;
  assert.ok(cherryFreq > 0.27 && cherryFreq < 0.37, `cherry freq off: ${cherryFreq}`);
});

// ---- RTP / fairness ----------------------------------------------------------

test("RTP over many spins is in a sane band (house edge, < 1)", () => {
  const SPINS = 20000;
  const BET = 100;
  let totalBet = 0;
  let totalWin = 0;
  for (let i = 0; i < SPINS; i++) {
    const grid = spinGrid(rng);
    const { win } = computeSpin(grid, PAYLINES, PAYTABLE, BET);
    totalBet += BET;
    totalWin += win;
  }
  const rtp = totalWin / totalBet;
  // report
  console.log(`measured RTP over ${SPINS} spins: ${rtp.toFixed(4)}`);
  // must hit wins regularly but keep a house edge
  assert.ok(totalWin > 0, "game never paid out");
  assert.ok(rtp >= 0.5 && rtp <= 1.2, `RTP out of band: ${rtp}`);
  assert.ok(rtp < 1, `expected house edge (RTP < 1), got ${rtp}`);
});

// ---- engine integration (light) ---------------------------------------------

test("engine rejects non-spin actions and bad bets; settles a spin", () => {
  // minimal fake room implementing the money contract
  function makeRoom(balance) {
    const player = { name: "Tester", balance };
    return {
      _player: player,
      getPlayer() { return player; },
      debit(_pid, amt) {
        amt = Math.floor(amt);
        if (amt <= 0 || player.balance < amt) return false;
        player.balance -= amt;
        return true;
      },
      credit(_pid, amt) {
        amt = Math.floor(amt);
        if (amt <= 0) return false;
        player.balance += amt;
        return true;
      },
    };
  }
  let broadcasts = 0;
  const ctx = { rng, log() {}, broadcast() { broadcasts++; } };
  const room = makeRoom(1000);
  const eng = new Slots(room, ctx);
  assert.equal(eng.gameId, "slots");

  assert.deepEqual(eng.handleAction("p1", { type: "nope" }), { ok: false, error: "Unknown action" });
  assert.equal(eng.handleAction("p1", { type: "spin", bet: 0 }).ok, false);
  assert.equal(eng.handleAction("p1", { type: "spin", bet: -5 }).ok, false);
  assert.equal(eng.handleAction("p1", { type: "spin", bet: 1.5 }).ok, false);
  assert.equal(eng.handleAction("p1", { type: "spin", bet: 5000 }).ok, false); // > balance

  const res = eng.handleAction("p1", { type: "spin", bet: 100 });
  assert.equal(res.ok, true);
  assert.ok(broadcasts >= 1);

  const state = eng.getPublicState("p1");
  assert.equal(state.gameId, "slots");
  assert.ok(state.lastSpin, "viewer should see their own last spin");
  assert.equal(state.lastSpin.bet, 100);
  assert.ok(Array.isArray(state.paylines) && state.paylines.length >= 5);
  assert.ok(state.paytable && state.symbols);
  // a different viewer must not see p1's grid
  const other = eng.getPublicState("p2");
  assert.equal(other.lastSpin, null);
  assert.ok(Array.isArray(other.recentWins));

  // balance moved consistently: started 1000, bet 100, plus any win
  const expected = 1000 - 100 + state.lastSpin.win;
  assert.equal(room._player.balance, expected);
});
