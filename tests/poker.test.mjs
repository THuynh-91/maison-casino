import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PH = require("../backend/lib/poker-hand.js");
const Poker = require("../backend/games/poker-engine.js");
const rng = require("../backend/lib/rng.js");

const { evaluate7, compareHands, bestFive } = PH;

// ============================================================ HAND EVAL: categories

test("eval: straight flush detected and named", () => {
  const s = evaluate7(["9h", "8h", "7h", "6h", "5h", "2c", "Ad"]);
  assert.equal(s.rank, PH.STRAIGHT_FLUSH);
  assert.equal(s.name, "Straight Flush");
  assert.equal(s.tiebreak[0], 9);
});

test("eval: four of a kind with best kicker", () => {
  const s = evaluate7(["7h", "7d", "7c", "7s", "Kd", "2c", "3h"]);
  assert.equal(s.rank, PH.FOUR_KIND);
  assert.deepEqual(s.tiebreak, [7, 13]);
});

test("eval: full house, trips over pair", () => {
  const s = evaluate7(["Qh", "Qd", "Qc", "4s", "4d", "2c", "3h"]);
  assert.equal(s.rank, PH.FULL_HOUSE);
  assert.deepEqual(s.tiebreak, [12, 4]);
});

test("eval: full house picks best trips then best pair from two trips", () => {
  // Two trips: KKK and QQQ => KKK full of QQ.
  const s = evaluate7(["Kh", "Kd", "Kc", "Qs", "Qd", "Qc", "2h"]);
  assert.equal(s.rank, PH.FULL_HOUSE);
  assert.deepEqual(s.tiebreak, [13, 12]);
});

test("eval: flush, top 5 of suit", () => {
  const s = evaluate7(["Ah", "Kh", "9h", "5h", "2h", "Kd", "Qc"]);
  assert.equal(s.rank, PH.FLUSH);
  assert.deepEqual(s.tiebreak, [14, 13, 9, 5, 2]);
});

test("eval: straight, no flush", () => {
  const s = evaluate7(["9c", "8d", "7h", "6s", "5c", "Kd", "2h"]);
  assert.equal(s.rank, PH.STRAIGHT);
  assert.equal(s.tiebreak[0], 9);
});

test("eval: wheel straight A-2-3-4-5 recognized as straight high=5", () => {
  const s = evaluate7(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"]);
  assert.equal(s.rank, PH.STRAIGHT);
  assert.equal(s.tiebreak[0], 5, "wheel high card is 5, ace plays low");
});

test("eval: wheel loses to 2-3-4-5-6", () => {
  const wheel = evaluate7(["Ah", "2d", "3c", "4s", "5h", "Kd", "Qc"]);
  const sixHigh = evaluate7(["2h", "3d", "4c", "5s", "6h", "Kd", "Qc"]);
  assert.equal(compareHands(sixHigh, wheel), 1);
  assert.equal(compareHands(wheel, sixHigh), -1);
});

test("eval: three of a kind with two kickers", () => {
  const s = evaluate7(["8h", "8d", "8c", "Ks", "4d", "2c", "3h"]);
  assert.equal(s.rank, PH.THREE_KIND);
  assert.deepEqual(s.tiebreak, [8, 13, 4]);
});

test("eval: two pair with kicker", () => {
  const s = evaluate7(["Jh", "Jd", "5c", "5s", "Ad", "2c", "3h"]);
  assert.equal(s.rank, PH.TWO_PAIR);
  assert.deepEqual(s.tiebreak, [11, 5, 14]);
});

test("eval: one pair with three kickers", () => {
  const s = evaluate7(["9h", "9d", "Kc", "7s", "4d", "2c", "3h"]);
  assert.equal(s.rank, PH.ONE_PAIR);
  assert.deepEqual(s.tiebreak, [9, 13, 7, 4]);
});

test("eval: high card top 5", () => {
  const s = evaluate7(["Ah", "Kd", "9c", "7s", "5d", "3c", "2h"]);
  assert.equal(s.rank, PH.HIGH_CARD);
  assert.deepEqual(s.tiebreak, [14, 13, 9, 7, 5]);
});

// ============================================================ HAND EVAL: ordering

test("eval: category ladder strictly increasing", () => {
  const sf = evaluate7(["9h", "8h", "7h", "6h", "5h"]);
  const quads = evaluate7(["7h", "7d", "7c", "7s", "Kd"]);
  const fh = evaluate7(["Qh", "Qd", "Qc", "4s", "4d"]);
  const flush = evaluate7(["Ah", "Kh", "9h", "5h", "2h"]);
  const straight = evaluate7(["9c", "8d", "7h", "6s", "5c"]);
  const trips = evaluate7(["8h", "8d", "8c", "Ks", "4d"]);
  const twoPair = evaluate7(["Jh", "Jd", "5c", "5s", "Ad"]);
  const pair = evaluate7(["9h", "9d", "Kc", "7s", "4d"]);
  const high = evaluate7(["Ah", "Kd", "9c", "7s", "5d"]);
  const ladder = [high, pair, twoPair, trips, straight, flush, fh, quads, sf];
  for (let i = 1; i < ladder.length; i++) {
    assert.equal(compareHands(ladder[i], ladder[i - 1]), 1, `tier ${i} beats ${i - 1}`);
  }
});

test("eval: flush beats straight", () => {
  const flush = evaluate7(["2h", "5h", "8h", "Jh", "Kh"]);
  const straight = evaluate7(["9c", "8d", "7h", "6s", "5c"]);
  assert.equal(compareHands(flush, straight), 1);
});

test("eval: kicker tiebreak — same pair, higher kicker wins", () => {
  const a = evaluate7(["As", "Ad", "Kc", "7s", "4d", "2c", "3h"]); // pair A, K kicker
  const b = evaluate7(["Ah", "Ac", "Qc", "7d", "4h", "2s", "3d"]); // pair A, Q kicker
  assert.equal(compareHands(a, b), 1);
});

test("eval: full house tie broken by trips then pair", () => {
  const a = evaluate7(["Kh", "Kd", "Kc", "2s", "2d"]); // KKK22
  const b = evaluate7(["Qh", "Qd", "Qc", "Ah", "Ad"]); // QQQAA
  assert.equal(compareHands(a, b), 1, "higher trips wins");
  const c = evaluate7(["Kh", "Kd", "Kc", "5s", "5d"]); // KKK55
  assert.equal(compareHands(c, a), 1, "same trips, higher pair wins");
});

test("eval: identical hands compare equal (split)", () => {
  const a = evaluate7(["Ah", "Kh", "Qd", "Jc", "9s", "2h", "3d"]);
  const b = evaluate7(["As", "Kc", "Qh", "Jd", "9c", "2s", "3h"]);
  assert.equal(compareHands(a, b), 0);
});

test("eval: bestFive returns 5 cards forming the best hand", () => {
  const five = bestFive(["Ah", "Kh", "9h", "5h", "2h", "Kd", "Qc"]);
  assert.equal(five.length, 5);
  // best is the heart flush
  assert.equal(evaluate7(five).rank, PH.FLUSH);
});

// ============================================================ ENGINE: mock room

function makeRoom(balances) {
  const players = new Map();
  for (const [pid, bal] of Object.entries(balances)) {
    players.set(pid, { persistentId: pid, balance: bal, seat: null });
  }
  return {
    players,
    getPlayer: (pid) => players.get(pid),
    debit(pid, amt) {
      const p = players.get(pid);
      amt = Math.floor(amt);
      if (!p || amt <= 0 || p.balance < amt) return false;
      p.balance -= amt;
      return true;
    },
    credit(pid, amt) {
      const p = players.get(pid);
      amt = Math.floor(amt);
      if (!p || amt <= 0) return false;
      p.balance += amt;
      return true;
    },
  };
}

function makeCtx(deck, config) {
  const ctx = { broadcast() {}, rng, log() {} };
  if (deck) ctx.deck = deck;
  if (config) ctx.config = config;
  return ctx;
}

const bal = (room, pid) => room.players.get(pid).balance;
const totalChips = (room) => {
  let t = 0;
  for (const p of room.players.values()) t += p.balance;
  return t;
};

// Helper: build a deck where hole cards deal in the engine's order. With 2 ready
// seats and button at seat b, dealing starts at the first ready seat AFTER the
// button and alternates, two rounds. We expose seat layout explicitly per test.

test("engine: sit/start requires 2 players with chips", () => {
  const room = makeRoom({ a: 1000 });
  const eng = new Poker(room, makeCtx());
  assert.equal(eng.handleAction("a", { type: "sit", seat: 0 }).ok, true);
  assert.equal(eng.handleAction("a", { type: "startHand" }).ok, false);
});

test("engine: blinds posted, hole cards dealt, balances debited", () => {
  // Two seats 0 (a) and 1 (b). First hand button moves to seat 0 (from -1).
  // Heads-up: button=seat0=SB, seat1=BB.
  // Deal order: start at nextReady(button=0) => seat1 first, then seat0, repeat.
  // Round1: b card, a card. Round2: b card, a card.
  const deck = [
    "Ah", "Kh", // b1, a1
    "Ad", "Kd", // b2, a2
    "2c", "3c", "4c", // flop
    "5d", // turn
    "6s", // river
  ];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  assert.equal(eng.handleAction("a", { type: "startHand" }).ok, true);
  assert.equal(eng.phase, "preflop");
  assert.equal(eng.button, 0);
  // SB=5 from a (button heads-up), BB=10 from b.
  assert.equal(bal(room, "a"), 995);
  assert.equal(bal(room, "b"), 990);
  assert.equal(eng.pot, 15);
  // a holds the second-dealt of each round: a got Kh, Kd.
  const sa = eng.getPublicState("a");
  assert.deepEqual(sa.seats[0].holeCards, ["Kh", "Kd"]);
  // b cannot see a's cards.
  const sb = eng.getPublicState("b");
  assert.equal(sb.seats[0].holeCards, null);
  assert.deepEqual(sb.seats[1].holeCards, ["Ah", "Ad"]);
});

test("engine: fold-to-one wins pot without showdown, no cards revealed", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // Heads-up preflop: SB (a, button) acts first. a folds.
  assert.equal(eng.turn, 0);
  assert.equal(eng.handleAction("a", { type: "fold" }).ok, true);
  assert.equal(eng.phase, "waiting");
  // b wins the 15 pot. a: 995, b: 990+15=1005.
  assert.equal(bal(room, "a"), 995);
  assert.equal(bal(room, "b"), 1005);
  assert.equal(totalChips(room), 2000, "chips conserved");
  const res = eng.lastResult;
  assert.equal(res.type, "fold");
  assert.equal(res.revealed.length, 0, "no hole cards revealed on a fold");
  assert.equal(res.winners[0].pid, "b");
});

test("engine: full hand to showdown, correct winner, chips conserved", () => {
  // 2 seats. Button -> seat0 (a) = SB heads-up, seat1 (b) = BB.
  // Deal order start = seat1 then seat0.
  // Give b the winning hand. b: Ah Ad (pair aces). a: Kh Kd (pair kings).
  // Board: 2c 7d 9s Tc 3h => b wins with pair of aces.
  const deck = [
    "Ah", "Kh", // b1, a1
    "Ad", "Kd", // b2, a2
    "2c", "7d", "9s", // flop
    "Tc", // turn
    "3h", // river
  ];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });

  // Preflop: a (SB/button) to act, owes 5 to call BB. a calls.
  assert.equal(eng.turn, 0);
  assert.equal(eng.handleAction("a", { type: "call" }).ok, true);
  // b (BB) to act, can check.
  assert.equal(eng.turn, 1);
  assert.equal(eng.handleAction("b", { type: "check" }).ok, true);
  assert.equal(eng.phase, "flop");
  // Postflop first to act = first actable left of button(0) => seat1 (b).
  assert.equal(eng.turn, 1);
  eng.handleAction("b", { type: "check" });
  eng.handleAction("a", { type: "check" });
  assert.equal(eng.phase, "turn");
  eng.handleAction("b", { type: "check" });
  eng.handleAction("a", { type: "check" });
  assert.equal(eng.phase, "river");
  eng.handleAction("b", { type: "check" });
  eng.handleAction("a", { type: "check" });
  assert.equal(eng.phase, "waiting");
  // Pot was 20 (each put in 10). b wins it. a:990, b:1010.
  assert.equal(bal(room, "a"), 990);
  assert.equal(bal(room, "b"), 1010);
  assert.equal(totalChips(room), 2000);
  const res = eng.lastResult;
  assert.equal(res.type, "showdown");
  assert.equal(res.winners[0].pid, "b");
  // both revealed at showdown
  assert.equal(res.revealed.length, 2);
});

test("engine: split pot on identical hands, chips conserved", () => {
  // Both make the same straight off the board (board plays). Give each a
  // useless low card; board is a made straight 5-6-7-8-9 ish but to play the
  // board we give a board straight and players hold lower cards.
  // Board: Ts Jh Qd Kc 9s. Best 5 from board = T J Q K 9 (K-high straight? no,
  // need consecutive). Use board A K Q J T (broadway) so it plays for both.
  // a: 2c 3d, b: 2h 3s. Both play broadway -> tie.
  const deck = [
    "2h", "2c", // b1, a1
    "3s", "3d", // b2, a2
    "As", "Kd", "Qc", // flop
    "Jh", // turn
    "Ts", // river
  ];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  eng.handleAction("a", { type: "call" }); // a calls to 10
  eng.handleAction("b", { type: "check" });
  // check down
  for (const street of ["flop", "turn", "river"]) {
    eng.handleAction("b", { type: "check" });
    eng.handleAction("a", { type: "check" });
  }
  assert.equal(eng.phase, "waiting");
  // Pot 20 split evenly => each gets 10 back. Net zero.
  assert.equal(bal(room, "a"), 1000);
  assert.equal(bal(room, "b"), 1000);
  assert.equal(totalChips(room), 2000);
  assert.equal(eng.lastResult.winners.length, 2);
});

test("engine: heads-up all-in showdown, winner takes all, chips conserved", () => {
  // a has 100, b has 1000. a (button/SB) shoves preflop, b calls. a wins.
  // a: As Ac, b: Kh Kd. Board: 2c 7d 9s Tc 3h => a wins pair of aces.
  const deck = [
    "Kh", "As", // b1, a1
    "Kd", "Ac", // b2, a2
    "2c", "7d", "9s", // flop
    "Tc", // turn
    "3h", // river
  ];
  const room = makeRoom({ a: 100, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // a is SB(5), b BB(10). a to act, owes 5. a shoves all-in (95 left => total 100).
  assert.equal(eng.turn, 0);
  assert.equal(eng.handleAction("a", { type: "allin" }).ok, true);
  assert.equal(eng.seats[0].allin, true);
  // b to act, calls. b has only 100 at risk (matches a's 100); side pot none.
  assert.equal(eng.turn, 1);
  assert.equal(eng.handleAction("b", { type: "call" }).ok, true);
  // Both all/matched -> run out the board to showdown.
  assert.equal(eng.phase, "waiting");
  // a wins 200 total pot. a: 0 -> 200. b: 1000-100=900.
  assert.equal(bal(room, "a"), 200);
  assert.equal(bal(room, "b"), 900);
  assert.equal(totalChips(room), 1100);
  assert.equal(eng.lastResult.winners[0].pid, "a");
});

test("engine: three-way side pot — short all-in wins main, second pot to runner-up", () => {
  // Seats 0(a)=100, 1(b)=1000, 2(c)=1000. 3-handed.
  // Button moves to seat0 (from -1). 3-handed: SB=seat1(b), BB=seat2(c),
  // first to act preflop = seat0 (a, the button/UTG in 3-handed).
  // Deal order start = nextReady(button=0) => seat1(b) first, then seat2(c),
  // then seat0(a); two rounds.
  // We want: a (short) makes the best hand and wins main pot; b makes 2nd best
  // and wins the side pot vs c.
  // a: As Ac (will make trips/quad aces). b: Ks Kc. c: Qs Qc.
  // Board: Ah 2d 7s 9c 3h => a has trip aces; b pair K; c pair Q. b > c.
  const deck = [
    "Ks", "Qs", "As", // b1, c1, a1
    "Kc", "Qc", "Ac", // b2, c2, a2
    "Ah", "2d", "7s", // flop
    "9c", // turn
    "3h", // river
  ];
  const room = makeRoom({ a: 100, b: 1000, c: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("c", { type: "sit", seat: 2 });
  eng.handleAction("a", { type: "startHand" });
  assert.equal(eng.button, 0);
  // Blinds: b posts 5, c posts 10. a to act first preflop.
  assert.equal(bal(room, "b"), 995);
  assert.equal(bal(room, "c"), 990);
  assert.equal(eng.turn, 0);
  // a shoves all-in 100.
  eng.handleAction("a", { type: "allin" });
  assert.equal(eng.turn, 1);
  // b raises all-in to 1000 (covering). raise to 1000.
  eng.handleAction("b", { type: "raise", amount: 1000 });
  assert.equal(eng.turn, 2);
  // c calls 1000.
  eng.handleAction("c", { type: "allin" });
  // Everyone all-in -> board runs out, showdown.
  assert.equal(eng.phase, "waiting");
  // Contributions: a=100, b=1000, c=1000. Total = 2100.
  // Main pot: 100*3 = 300, eligible a,b,c => a wins (trip aces). a gets 300.
  // Side pot: 900*2 = 1800, eligible b,c => b wins (KK > QQ). b gets 1800.
  // a: 0 -> 300. b: 0 -> 1800. c: 0.
  assert.equal(bal(room, "a"), 300);
  assert.equal(bal(room, "b"), 1800);
  assert.equal(bal(room, "c"), 0);
  assert.equal(totalChips(room), 2100, "chips conserved");
});

// ============================================================ ENGINE: validation

test("engine: reject acting out of turn", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // Turn is seat0 (a). b acting is rejected.
  assert.equal(eng.turn, 0);
  const r = eng.handleAction("b", { type: "call" });
  assert.equal(r.ok, false);
  assert.match(r.error, /turn/i);
});

test("engine: reject check when facing a bet", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // a (SB) owes 5 vs BB; checking is illegal.
  const r = eng.handleAction("a", { type: "check" });
  assert.equal(r.ok, false);
  assert.match(r.error, /check/i);
});

test("engine: reject bet/raise exceeding stack", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 100, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // a has 95 left after SB. Raise to 1000 exceeds stack.
  const r = eng.handleAction("a", { type: "raise", amount: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /stack/i);
});

test("engine: reject raise below minimum", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  // currentBet=10, minRaise=10 => min legal raise-to is 20. Raise to 15 illegal.
  const r = eng.handleAction("a", { type: "raise", amount: 15 });
  assert.equal(r.ok, false);
  assert.match(r.error, /[Mm]inimum raise/);
  // Raise to 20 is legal.
  assert.equal(eng.handleAction("a", { type: "raise", amount: 20 }).ok, true);
});

test("engine: leaving mid-hand folds the player and keeps hand playable", () => {
  // 3-handed so the hand survives one leaver.
  const deck = [
    "Ks", "Qs", "As", "Kc", "Qc", "Ac",
    "Ah", "2d", "7s", "9c", "3h",
  ];
  const room = makeRoom({ a: 1000, b: 1000, c: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("c", { type: "sit", seat: 2 });
  eng.handleAction("a", { type: "startHand" });
  // a to act first. a leaves -> folds, turn advances to b.
  assert.equal(eng.turn, 0);
  assert.equal(eng.handleAction("a", { type: "leave" }).ok, true);
  assert.equal(eng.seats[0], null);
  assert.notEqual(eng.phase, "waiting", "hand still live with 2 players");
});

test("engine: validation — unknown player and unknown action", () => {
  const room = makeRoom({ a: 1000 });
  const eng = new Poker(room, makeCtx());
  assert.equal(eng.handleAction("ghost", { type: "sit" }).ok, false);
  eng.handleAction("a", { type: "sit", seat: 0 });
  assert.equal(eng.handleAction("a", { type: "bogus" }).ok, false);
});

test("engine: getPublicState never leaks opponents' hole cards mid-hand", () => {
  const deck = ["Ah", "Kh", "Ad", "Kd", "2c", "3c", "4c", "5d", "6s"];
  const room = makeRoom({ a: 1000, b: 1000 });
  const eng = new Poker(room, makeCtx(deck));
  eng.handleAction("a", { type: "sit", seat: 0 });
  eng.handleAction("b", { type: "sit", seat: 1 });
  eng.handleAction("a", { type: "startHand" });
  const view = eng.getPublicState("a");
  // a sees own cards, not b's; b's hasCards is true.
  assert.ok(view.seats[0].holeCards);
  assert.equal(view.seats[1].holeCards, null);
  assert.equal(view.seats[1].hasCards, true);
});
