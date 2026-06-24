import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Plinko = require("../backend/games/plinko-engine.js");

const {
  simulatePath,
  slotProbabilities,
  expectedValue,
  MULTIPLIERS,
  ROWS,
  RISKS,
} = Plinko;

// Coin stubs: deterministic () => 0|1 functions.
const allRights = () => 1;
const allLefts = () => 0;
function alternating(start = 1) {
  let v = start;
  return () => {
    const out = v;
    v = v ? 0 : 1;
    return out;
  };
}

// ====================================================================== simulatePath

test("simulatePath: all-rights lands slot=rows, path all 'R'", () => {
  const { path, slot } = simulatePath(allRights, ROWS);
  assert.equal(slot, ROWS);
  assert.equal(path.length, ROWS);
  assert.ok(path.every((c) => c === "R"));
});

test("simulatePath: all-lefts lands slot=0, path all 'L'", () => {
  const { path, slot } = simulatePath(allLefts, ROWS);
  assert.equal(slot, 0);
  assert.equal(path.length, ROWS);
  assert.ok(path.every((c) => c === "L"));
});

test("simulatePath: alternating lands the right count", () => {
  // start with a right; over 12 rows -> R,L,R,L... = 6 rights
  const { path, slot } = simulatePath(alternating(1), ROWS);
  assert.equal(path.length, ROWS);
  const rights = path.filter((c) => c === "R").length;
  assert.equal(slot, rights);
  assert.equal(slot, ROWS / 2); // 6 for 12 rows
});

test("simulatePath: path length equals rows for various row counts", () => {
  for (const rows of [1, 4, 8, 12, 16]) {
    const { path } = simulatePath(allRights, rows);
    assert.equal(path.length, rows);
  }
});

test("simulatePath: accepts an rng object with randInt(2)", () => {
  // fake rng that always returns 1 for randInt(2)
  const fakeRng = { randInt: (max) => (max === 2 ? 1 : 0) };
  const { slot } = simulatePath(fakeRng, ROWS);
  assert.equal(slot, ROWS);
});

// ================================================================== slotProbabilities

test("slotProbabilities: length rows+1 and sums to 1", () => {
  for (const rows of [4, 8, 12, 16]) {
    const p = slotProbabilities(rows);
    assert.equal(p.length, rows + 1);
    const sum = p.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum was ${sum}`);
  }
});

test("slotProbabilities: symmetric and peaks in the middle", () => {
  const p = slotProbabilities(ROWS);
  for (let k = 0; k <= ROWS; k++) {
    assert.ok(Math.abs(p[k] - p[ROWS - k]) < 1e-12, "not symmetric");
  }
  const mid = ROWS / 2;
  const max = Math.max(...p);
  assert.equal(p[mid], max); // center slot is the most likely
  assert.ok(p[0] < p[mid] && p[ROWS] < p[mid]); // edges rarer than center
});

// ===================================================================== expectedValue

test("expectedValue: house edge for every risk (0.8 < EV < 1)", () => {
  for (const risk of RISKS) {
    const ev = expectedValue(MULTIPLIERS[risk], ROWS);
    // REPORTED EVs (rows=12): low ~0.863, medium ~0.864, high ~0.823
    console.log(`  EV[${risk}] = ${ev.toFixed(5)}`);
    assert.ok(ev < 1, `${risk} EV ${ev} should be < 1 (house edge)`);
    assert.ok(ev > 0.8, `${risk} EV ${ev} should be > 0.8 (not a ripoff)`);
  }
});

test("expectedValue: throws if multipliers length != rows+1", () => {
  assert.throws(() => expectedValue([1, 2, 3], ROWS));
});

// ====================================================================== multipliers

test("multiplier arrays are length rows+1 and symmetric", () => {
  for (const risk of RISKS) {
    const m = MULTIPLIERS[risk];
    assert.equal(m.length, ROWS + 1);
    for (let k = 0; k <= ROWS; k++) {
      assert.equal(m[k], m[ROWS - k], `${risk} not symmetric at ${k}`);
    }
    // edges should be the high-payout end, center the low
    assert.ok(m[0] >= m[ROWS / 2]);
  }
});

// =============================================================== engine integration

function mockRoom(startBalance = 1000) {
  const players = new Map();
  players.set("p1", { persistentId: "p1", name: "Alice", balance: startBalance });
  return {
    players,
    getPlayer(id) {
      return players.get(id);
    },
    debit(id, amt) {
      const p = players.get(id);
      amt = Math.floor(amt);
      if (!p || amt <= 0 || p.balance < amt) return false;
      p.balance -= amt;
      return true;
    },
    credit(id, amt) {
      const p = players.get(id);
      amt = Math.floor(amt);
      if (!p || amt <= 0) return false;
      p.balance += amt;
      return true;
    },
  };
}

function fakeCtx(coin) {
  return {
    rng: { randInt: () => coin() },
    broadcast() {
      this.broadcasts = (this.broadcasts || 0) + 1;
    },
    log() {},
  };
}

test("engine: drop deducts bet and credits floor(bet*mult), records path", () => {
  const room = mockRoom(1000);
  // all-rights -> slot = ROWS, medium multiplier at the edge is 11
  const ctx = fakeCtx(() => 1);
  const engine = new Plinko(room, ctx);

  const res = engine.handleAction("p1", { type: "drop", bet: 10, risk: "medium" });
  assert.equal(res.ok, true);

  const expectedMult = MULTIPLIERS.medium[ROWS];
  const expectedPayout = Math.floor(10 * expectedMult);
  // balance: 1000 - 10 (debit) + payout
  assert.equal(room.getPlayer("p1").balance, 1000 - 10 + expectedPayout);

  const state = engine.getPublicState("p1");
  assert.equal(state.lastDrop.slot, ROWS);
  assert.equal(state.lastDrop.path.length, ROWS);
  assert.ok(state.lastDrop.path.every((c) => c === "R"));
  assert.equal(state.lastDrop.multiplier, expectedMult);
  assert.equal(state.lastDrop.payout, expectedPayout);
  assert.equal(state.recentWins.length, 1);
});

test("engine: default risk is used when risk omitted", () => {
  const room = mockRoom(1000);
  const engine = new Plinko(room, fakeCtx(() => 0)); // all-lefts -> slot 0
  const res = engine.handleAction("p1", { type: "drop", bet: 20 });
  assert.equal(res.ok, true);
  const state = engine.getPublicState("p1");
  assert.equal(state.lastDrop.risk, Plinko.DEFAULT_RISK);
  assert.equal(state.lastDrop.slot, 0);
});

test("engine: rejects bad bets and unknown actions", () => {
  const room = mockRoom(50);
  const engine = new Plinko(room, fakeCtx(() => 1));

  assert.equal(engine.handleAction("p1", { type: "drop", bet: 0 }).ok, false);
  assert.equal(engine.handleAction("p1", { type: "drop", bet: -5 }).ok, false);
  assert.equal(engine.handleAction("p1", { type: "drop", bet: 2.5 }).ok, false);
  assert.equal(engine.handleAction("p1", { type: "drop", bet: "10" }).ok, false);
  assert.equal(engine.handleAction("p1", { type: "drop", bet: 1000 }).ok, false); // unaffordable
  assert.equal(engine.handleAction("p1", { type: "drop", bet: 10, risk: "extreme" }).ok, false);
  assert.equal(engine.handleAction("p1", { type: "nope", bet: 10 }).ok, false);
  assert.equal(engine.handleAction("ghost", { type: "drop", bet: 10 }).ok, false);

  // balance untouched by rejections
  assert.equal(room.getPlayer("p1").balance, 50);
});

test("engine: a losing slot still resolves (payout can be < bet)", () => {
  const room = mockRoom(1000);
  // alternating from a right -> slot 6 (center), medium center mult 0.5
  const engine = new Plinko(room, fakeCtx(alternating(1)));
  const res = engine.handleAction("p1", { type: "drop", bet: 10, risk: "medium" });
  assert.equal(res.ok, true);
  const state = engine.getPublicState("p1");
  assert.equal(state.lastDrop.slot, ROWS / 2);
  assert.equal(state.lastDrop.multiplier, MULTIPLIERS.medium[ROWS / 2]); // 0.5
  assert.equal(state.lastDrop.payout, Math.floor(10 * 0.5)); // 5
  assert.equal(room.getPlayer("p1").balance, 1000 - 10 + 5);
});
