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

// ---- spinResult bounds ----
test("spinResult always in 0..36", () => {
  for (let i = 0; i < 5000; i++) {
    const x = Core.spinResult();
    assert.ok(Number.isInteger(x) && x >= 0 && x <= 36, `out of range: ${x}`);
  }
});
