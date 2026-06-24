import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Core = require("../roulette-core.js");

// ---- Number properties ----
test("colors: known red/black/green numbers", () => {
  assert.equal(Core.colorOf(0), "green");
  assert.equal(Core.colorOf(1), "red");
  assert.equal(Core.colorOf(2), "black");
  assert.equal(Core.colorOf(36), "red");
  assert.equal(Core.colorOf(35), "black");
  // 18 reds, 18 blacks
  let reds = 0, blacks = 0;
  for (let n = 1; n <= 36; n++) {
    if (Core.isRed(n)) reds++;
    if (Core.isBlack(n)) blacks++;
  }
  assert.equal(reds, 18);
  assert.equal(blacks, 18);
});

test("European wheel order has 37 unique pockets 0-36", () => {
  assert.equal(Core.WHEEL_ORDER.length, 37);
  assert.equal(new Set(Core.WHEEL_ORDER).size, 37);
  for (let n = 0; n <= 36; n++) {
    assert.ok(Core.WHEEL_ORDER.includes(n), `wheel missing ${n}`);
  }
});

// ---- Helper: single-bet net profit on a win ----
function winNet(bet, result) {
  const r = Core.resolveBets([bet], result);
  assert.ok(r.details[0].won, "expected this bet to win");
  return r.netProfit;
}

// ---- Payout multipliers (X-to-1): net profit = amount * X on a win ----
test("straight-up pays 35:1", () => {
  assert.equal(winNet({ type: "straight", numbers: [17], amount: 10 }, 17), 350);
});

test("split pays 17:1", () => {
  assert.equal(winNet({ type: "split", numbers: [1, 2], amount: 10 }, 2), 170);
});

test("street pays 11:1", () => {
  assert.equal(winNet({ type: "street", numbers: [1, 2, 3], amount: 10 }, 3), 110);
});

test("corner pays 8:1", () => {
  assert.equal(winNet({ type: "corner", numbers: [1, 2, 4, 5], amount: 10 }, 5), 80);
});

test("line (six-line) pays 5:1", () => {
  assert.equal(winNet({ type: "line", numbers: [1, 2, 3, 4, 5, 6], amount: 10 }, 4), 50);
});

test("column pays 2:1", () => {
  const col3 = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36];
  assert.equal(winNet({ type: "column", numbers: col3, amount: 10 }, 36), 20);
});

test("dozen pays 2:1", () => {
  const d2 = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  assert.equal(winNet({ type: "dozen", numbers: d2, amount: 10 }, 20), 20);
});

test("even-money bets pay 1:1", () => {
  assert.equal(winNet({ type: "red", amount: 10 }, 1), 10);
  assert.equal(winNet({ type: "black", amount: 10 }, 2), 10);
  assert.equal(winNet({ type: "odd", amount: 10 }, 7), 10);
  assert.equal(winNet({ type: "even", amount: 10 }, 8), 10);
  assert.equal(winNet({ type: "low", amount: 10 }, 18), 10);
  assert.equal(winNet({ type: "high", amount: 10 }, 19), 10);
});

// ---- Total returned = stake + winnings ----
test("totalReturned includes the original stake", () => {
  const r = Core.resolveBets([{ type: "straight", numbers: [7], amount: 10 }], 7);
  assert.equal(r.totalReturned, 360); // 10 stake + 350 profit
  assert.equal(r.netProfit, 350);
});

// ---- Losing bets ----
test("losing bet returns 0 and loses the stake", () => {
  const r = Core.resolveBets([{ type: "straight", numbers: [7], amount: 10 }], 8);
  assert.equal(r.details[0].won, false);
  assert.equal(r.totalReturned, 0);
  assert.equal(r.netProfit, -10);
});

// ---- Zero behaviour: all outside/even-money bets lose ----
test("zero loses all even-money and outside bets", () => {
  const losers = ["red", "black", "odd", "even", "low", "high"].map((t) => ({ type: t, amount: 10 }));
  const r = Core.resolveBets(losers, 0);
  assert.equal(r.totalReturned, 0);
  assert.ok(r.details.every((d) => !d.won));
});

test("zero wins straight-up on 0", () => {
  assert.equal(winNet({ type: "straight", numbers: [0], amount: 10 }, 0), 350);
});

test("zero is not odd, even, low, or high", () => {
  assert.equal(Core.betWins({ type: "odd" }, 0), false);
  assert.equal(Core.betWins({ type: "even" }, 0), false);
  assert.equal(Core.betWins({ type: "low" }, 0), false);
  assert.equal(Core.betWins({ type: "high" }, 0), false);
});

// ---- Mixed board resolution ----
test("multiple simultaneous bets resolve independently", () => {
  const bets = [
    { type: "straight", numbers: [17], amount: 5 }, // win  -> 5*36 = 180 returned
    { type: "red", amount: 20 },                    // 17 is black -> lose
    { type: "black", amount: 20 },                  // win -> 40 returned
    { type: "dozen", numbers: [13,14,15,16,17,18,19,20,21,22,23,24], amount: 10 }, // win -> 30
  ];
  const r = Core.resolveBets(bets, 17);
  assert.equal(r.totalStaked, 55);
  assert.equal(r.totalReturned, 180 + 0 + 40 + 30); // 250
  assert.equal(r.netProfit, 250 - 55); // 195
});

// ---- Board geometry helpers: splitNumbers ----
test("splitNumbers: valid horizontal splits (same row, adjacent columns)", () => {
  assert.deepEqual(Core.splitNumbers(1, 4), [1, 4]); // bottom row
  assert.deepEqual(Core.splitNumbers(4, 1), [1, 4]); // order-independent
  assert.deepEqual(Core.splitNumbers(2, 5), [2, 5]); // middle row
  assert.deepEqual(Core.splitNumbers(3, 6), [3, 6]); // top row
  assert.deepEqual(Core.splitNumbers(33, 36), [33, 36]);
});

test("splitNumbers: valid vertical splits (same column, differ by 1)", () => {
  assert.deepEqual(Core.splitNumbers(1, 2), [1, 2]);
  assert.deepEqual(Core.splitNumbers(2, 1), [1, 2]);
  assert.deepEqual(Core.splitNumbers(2, 3), [2, 3]);
  assert.deepEqual(Core.splitNumbers(34, 35), [34, 35]);
  assert.deepEqual(Core.splitNumbers(35, 36), [35, 36]);
});

test("splitNumbers: valid zero-splits", () => {
  assert.deepEqual(Core.splitNumbers(0, 1), [0, 1]);
  assert.deepEqual(Core.splitNumbers(1, 0), [0, 1]);
  assert.deepEqual(Core.splitNumbers(0, 2), [0, 2]);
  assert.deepEqual(Core.splitNumbers(0, 3), [0, 3]);
});

test("splitNumbers: illegal splits return null", () => {
  // 3 & 4: 3 is top-of-column-1, 4 is bottom-of-column-2 -> different rows, diff 1
  assert.equal(Core.splitNumbers(3, 4), null);
  // 1 & 5: diagonal
  assert.equal(Core.splitNumbers(1, 5), null);
  // 34 & 1: far apart
  assert.equal(Core.splitNumbers(34, 1), null);
  // same number
  assert.equal(Core.splitNumbers(5, 5), null);
  // vertical-looking but crossing a column boundary (6 top col2, 7 bottom col3)
  assert.equal(Core.splitNumbers(6, 7), null);
  // 0 with a non-bottom-row number
  assert.equal(Core.splitNumbers(0, 4), null);
  // off-board
  assert.equal(Core.splitNumbers(36, 37), null);
});

// ---- streetNumbers ----
test("streetNumbers: standard streets", () => {
  assert.deepEqual(Core.streetNumbers(1), [1, 2, 3]);
  assert.deepEqual(Core.streetNumbers(2), [4, 5, 6]);
  assert.deepEqual(Core.streetNumbers(12), [34, 35, 36]);
});

test("streetNumbers: out-of-range returns null", () => {
  assert.equal(Core.streetNumbers(0), null);
  assert.equal(Core.streetNumbers(13), null);
  assert.equal(Core.streetNumbers(1.5), null);
});

// ---- cornerNumbers ----
test("cornerNumbers: valid 2x2 corners", () => {
  assert.deepEqual(Core.cornerNumbers(1), [1, 2, 4, 5]);
  assert.deepEqual(Core.cornerNumbers(2), [2, 3, 5, 6]);
  assert.deepEqual(Core.cornerNumbers(4), [4, 5, 7, 8]);
  assert.deepEqual(Core.cornerNumbers(31), [31, 32, 34, 35]);
  assert.deepEqual(Core.cornerNumbers(32), [32, 33, 35, 36]);
});

test("cornerNumbers: invalid corners return null", () => {
  // top row of a column has nothing above (3,6,...36)
  assert.equal(Core.cornerNumbers(3), null);
  assert.equal(Core.cornerNumbers(6), null);
  // last column (34,35,36) has no column to the right
  assert.equal(Core.cornerNumbers(34), null);
  assert.equal(Core.cornerNumbers(35), null);
  assert.equal(Core.cornerNumbers(36), null);
  // off-board / zero
  assert.equal(Core.cornerNumbers(0), null);
  assert.equal(Core.cornerNumbers(37), null);
});

// ---- lineNumbers ----
test("lineNumbers: standard six-lines", () => {
  assert.deepEqual(Core.lineNumbers(1), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(Core.lineNumbers(2), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(Core.lineNumbers(11), [31, 32, 33, 34, 35, 36]);
});

test("lineNumbers: out-of-range returns null", () => {
  assert.equal(Core.lineNumbers(0), null);
  assert.equal(Core.lineNumbers(12), null);
});

// ---- Integration: helpers feed resolveBets ----
test("split bet from splitNumbers wins on a covered number, loses otherwise", () => {
  const numbers = Core.splitNumbers(1, 4);
  assert.deepEqual(numbers, [1, 4]);
  assert.equal(winNet({ type: "split", numbers, amount: 10 }, 4), 170);
  const loss = Core.resolveBets([{ type: "split", numbers, amount: 10 }], 5);
  assert.equal(loss.details[0].won, false);
  assert.equal(loss.netProfit, -10);
});

test("corner bet from cornerNumbers resolves at 8:1", () => {
  const numbers = Core.cornerNumbers(1);
  assert.deepEqual(numbers, [1, 2, 4, 5]);
  assert.equal(winNet({ type: "corner", numbers, amount: 10 }, 5), 80);
  const loss = Core.resolveBets([{ type: "corner", numbers, amount: 10 }], 3);
  assert.equal(loss.details[0].won, false);
});

// ---- spinResult bounds ----
test("spinResult always in 0..36", () => {
  for (let i = 0; i < 5000; i++) {
    const x = Core.spinResult();
    assert.ok(Number.isInteger(x) && x >= 0 && x <= 36, `out of range: ${x}`);
  }
});
