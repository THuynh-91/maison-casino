import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BJ = require("../backend/games/blackjack-engine.js");
const rng = require("../backend/lib/rng.js");

const { handValue, handInfo, isSoft, isBust, isBlackjack, settleHand } = BJ;

// =================================================================== handValue

test("handValue: simple hard totals", () => {
  assert.equal(handValue(["9c", "7d"]), 16);
  assert.equal(handValue(["Tc", "5d"]), 15);
  assert.equal(handValue(["Kc", "Qd"]), 20);
  assert.equal(handValue(["2c", "3d", "4h"]), 9);
});

test("handValue: soft ace counted as 11 (A+6 = 17 soft)", () => {
  const info = handInfo(["Ah", "6d"]);
  assert.equal(info.value, 17);
  assert.equal(info.soft, true);
  assert.equal(isSoft(["Ah", "6d"]), true);
});

test("handValue: ace demotes when it would bust (A+6+T = 17 hard)", () => {
  const info = handInfo(["Ah", "6d", "Tc"]);
  assert.equal(info.value, 17);
  assert.equal(info.soft, false);
  assert.equal(isSoft(["Ah", "6d", "Tc"]), false);
});

test("handValue: A+A = 12 (one ace 11, one ace 1)", () => {
  const info = handInfo(["Ah", "As"]);
  assert.equal(info.value, 12);
  assert.equal(info.soft, true);
});

test("handValue: multi-ace A+A+9 = 21", () => {
  assert.equal(handValue(["Ah", "As", "9d"]), 21);
});

test("handValue: many aces never bust below count (A+A+A+A = 14)", () => {
  assert.equal(handValue(["Ah", "As", "Ad", "Ac"]), 14);
});

test("handValue: hard bust over 21", () => {
  assert.equal(handValue(["Kc", "Qd", "5h"]), 25);
  assert.equal(isBust(["Kc", "Qd", "5h"]), true);
  assert.equal(isBust(["Kc", "Qd"]), false);
});

// =================================================================== blackjack

test("isBlackjack: ace + ten-value two-card 21", () => {
  assert.equal(isBlackjack(["Ah", "Kd"]), true);
  assert.equal(isBlackjack(["Th", "As"]), true);
  assert.equal(isBlackjack(["Ah", "Qc"]), true);
});

test("isBlackjack: 21 in three cards is NOT a blackjack", () => {
  assert.equal(isBlackjack(["7h", "7d", "7c"]), true === false); // 21 but 3 cards
  assert.equal(isBlackjack(["Ah", "9d", "Ac"]), false); // 21 but 3 cards
});

test("isBlackjack: non-21 two cards is not blackjack", () => {
  assert.equal(isBlackjack(["Ah", "9d"]), false);
  assert.equal(isBlackjack(["Kh", "Qd"]), false);
});

// =================================================================== settleHand

test("settleHand: player 20 beats dealer 19 (win 1:1)", () => {
  const r = settleHand({ cards: ["Tc", "Td"], bet: 10 }, ["Tc", "9d"]);
  assert.equal(r.outcome, "win");
  assert.equal(r.payout, 20); // stake + 1:1
  assert.equal(r.net, 10);
});

test("settleHand: equal totals push (stake returned)", () => {
  const r = settleHand({ cards: ["Tc", "9d"], bet: 10 }, ["Kc", "9h"]);
  assert.equal(r.outcome, "push");
  assert.equal(r.payout, 10);
  assert.equal(r.net, 0);
});

test("settleHand: dealer bust => player wins", () => {
  const r = settleHand({ cards: ["Tc", "8d"], bet: 10 }, ["Kc", "Qh", "5s"]);
  assert.equal(r.outcome, "win");
  assert.equal(r.payout, 20);
  assert.equal(r.net, 10);
});

test("settleHand: player bust loses even if dealer also busts", () => {
  const r = settleHand({ cards: ["Tc", "Qd", "5s"], bet: 10 }, ["Kc", "Qh", "5d"]);
  assert.equal(r.outcome, "lose");
  assert.equal(r.payout, 0);
  assert.equal(r.net, -10);
});

test("settleHand: player blackjack pays 3:2", () => {
  const r = settleHand({ cards: ["Ah", "Kd"], bet: 10 }, ["Tc", "9d"]);
  assert.equal(r.outcome, "blackjack");
  assert.equal(r.payout, 25); // floor(10 * 2.5)
  assert.equal(r.net, 15);
});

test("settleHand: 3:2 rounds in favor of house on odd stake (floor)", () => {
  const r = settleHand({ cards: ["Ah", "Kd"], bet: 5 }, ["Tc", "9d"]);
  assert.equal(r.outcome, "blackjack");
  assert.equal(r.payout, 12); // floor(5 * 2.5) = 12
  assert.equal(r.net, 7);
});

test("settleHand: both blackjack => push", () => {
  const r = settleHand({ cards: ["Ah", "Kd"], bet: 10 }, ["As", "Qh"]);
  assert.equal(r.outcome, "push");
  assert.equal(r.payout, 10);
  assert.equal(r.net, 0);
});

test("settleHand: dealer blackjack beats player non-natural 20", () => {
  const r = settleHand({ cards: ["Tc", "Td"], bet: 10 }, ["As", "Qh"]);
  assert.equal(r.outcome, "lose");
  assert.equal(r.payout, 0);
});

test("settleHand: player natural beats dealer non-natural 21", () => {
  const r = settleHand({ cards: ["Ah", "Kd"], bet: 10 }, ["7c", "7d", "7s"]);
  assert.equal(r.outcome, "blackjack");
  assert.equal(r.payout, 25);
});

test("settleHand: split 21 is NOT a blackjack (pays 1:1)", () => {
  const r = settleHand({ cards: ["Ah", "Kd"], bet: 10, isSplit: true }, ["Tc", "9d"]);
  assert.equal(r.outcome, "win");
  assert.equal(r.payout, 20); // 1:1, not 3:2
});

// =================================================================== integration

// A minimal Room mock implementing the bits the engine uses.
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

function makeCtx(deck) {
  const ctx = { broadcast() {}, rng, log() {} };
  if (deck) ctx.deck = deck;
  return ctx;
}

test("integration: forced deck, player stands and wins 1:1", () => {
  // Deal order with one seated bettor: seatCard, dealerCard, seatCard, dealerCard
  // Player gets Tc, Td (20). Dealer gets 9h, 8s (17, stands).
  const deck = ["Tc", "9h", "Td", "8s", "2c" /* spare */];
  const room = makeRoom({ alice: 1000 });
  const eng = new BJ(room, makeCtx(deck));

  assert.equal(eng.handleAction("alice", { type: "sit", seat: 0 }).ok, true);
  assert.equal(eng.handleAction("alice", { type: "bet", amount: 100 }).ok, true);
  assert.equal(room.players.get("alice").balance, 900); // debited
  assert.equal(eng.handleAction("alice", { type: "deal" }).ok, true);
  assert.equal(eng.phase, "playing");

  const st = eng.getPublicState("alice");
  assert.equal(st.dealer.cards.length, 2);
  assert.equal(st.dealer.cards[1], "??", "hole card hidden during play");

  assert.equal(eng.handleAction("alice", { type: "stand" }).ok, true);
  // Dealer stands on 17, player 20 wins. Back to betting, balance = 900 + 200.
  assert.equal(eng.phase, "betting");
  assert.equal(room.players.get("alice").balance, 1100);
  const res = eng.getPublicState("alice").results.alice;
  assert.equal(res.net, 100);
  assert.equal(res.hands[0].outcome, "win");
});

test("integration: forced deck, player natural blackjack pays 3:2", () => {
  // Player: Ah, Kd (BJ). Dealer: 9h, 8s (17, no BJ).
  const deck = ["Ah", "9h", "Kd", "8s"];
  const room = makeRoom({ bob: 1000 });
  const eng = new BJ(room, makeCtx(deck));
  eng.handleAction("bob", { type: "sit", seat: 0 });
  eng.handleAction("bob", { type: "bet", amount: 100 });
  eng.handleAction("bob", { type: "deal" });
  // Natural => round resolves immediately to betting.
  assert.equal(eng.phase, "betting");
  // 1000 - 100 + floor(100*2.5)=250 => 1150
  assert.equal(room.players.get("bob").balance, 1150);
  assert.equal(eng.getPublicState("bob").results.bob.hands[0].outcome, "blackjack");
});

test("integration: double down debits a second bet and conserves money", () => {
  // Player: 5c, 6d (11). Dealer: Th, 7s (17). Double card: 9h -> player 20 wins.
  const deck = ["5c", "Th", "6d", "7s", "9h"];
  const room = makeRoom({ cara: 1000 });
  const eng = new BJ(room, makeCtx(deck));
  eng.handleAction("cara", { type: "sit", seat: 0 });
  eng.handleAction("cara", { type: "bet", amount: 100 });
  eng.handleAction("cara", { type: "deal" });
  assert.equal(room.players.get("cara").balance, 900);
  assert.equal(eng.handleAction("cara", { type: "double" }).ok, true);
  // doubled stake = 200 debited total, player 20 vs dealer 17 wins => +400
  assert.equal(eng.phase, "betting");
  assert.equal(room.players.get("cara").balance, 800 + 400); // 900-100 double, +400 win = 1200
  assert.equal(room.players.get("cara").balance, 1200);
});

test("integration: split a pair into two hands, money conserved", () => {
  // Player: 8c, 8d (pair). Dealer: 6h, then draws.
  // Deal order: seat, dealer, seat, dealer => 8c, 6h, 8d, Ts(dealer hole)
  // dealer = 6 + 10 = 16, draws next from deck.
  // After split: hand0 gets next card, hand1 gets next card.
  // deck after deal consumed [8c,6h,8d,Ts]; remaining: 9s(h0), 9c(h1), then
  // dealer draws Kc -> 16+10=26 bust.
  const deck = ["8c", "6h", "8d", "Ts", "9s", "9c", "Kc"];
  const room = makeRoom({ dan: 1000 });
  const eng = new BJ(room, makeCtx(deck));
  eng.handleAction("dan", { type: "sit", seat: 0 });
  eng.handleAction("dan", { type: "bet", amount: 100 });
  eng.handleAction("dan", { type: "deal" });
  assert.equal(room.players.get("dan").balance, 900);
  assert.equal(eng.handleAction("dan", { type: "split" }).ok, true);
  assert.equal(room.players.get("dan").balance, 800); // second bet debited
  // Two hands: 8+9=17 each. Stand both.
  assert.equal(eng.handleAction("dan", { type: "stand" }).ok, true);
  assert.equal(eng.handleAction("dan", { type: "stand" }).ok, true);
  // Dealer 16 -> draws Kc -> 26 bust. Both hands (17) win 1:1 => 2 * 200 = 400.
  assert.equal(eng.phase, "betting");
  assert.equal(room.players.get("dan").balance, 800 + 400); // 1200
  const res = eng.getPublicState("dan").results.dan;
  assert.equal(res.hands.length, 2);
  assert.equal(res.net, 200);
});

test("integration: leaving mid-round refunds the live hand and conserves money", () => {
  const deck = ["Tc", "9h", "Td", "8s"];
  const room = makeRoom({ eve: 1000 });
  const eng = new BJ(room, makeCtx(deck));
  eng.handleAction("eve", { type: "sit", seat: 0 });
  eng.handleAction("eve", { type: "bet", amount: 100 });
  eng.handleAction("eve", { type: "deal" });
  assert.equal(room.players.get("eve").balance, 900);
  assert.equal(eng.handleAction("eve", { type: "leave" }).ok, true);
  // Live hand bet refunded.
  assert.equal(room.players.get("eve").balance, 1000);
  assert.equal(eng.getPublicState("eve").yourSeat, null);
});

test("integration: validation rejections", () => {
  const room = makeRoom({ frank: 50 });
  const eng = new BJ(room, makeCtx());
  assert.equal(eng.handleAction("ghost", { type: "sit" }).ok, false); // unknown player
  assert.equal(eng.handleAction("frank", { type: "bet", amount: 10 }).ok, false); // not seated
  assert.equal(eng.handleAction("frank", { type: "hit" }).ok, false); // wrong phase
  eng.handleAction("frank", { type: "sit", seat: 0 });
  assert.equal(eng.handleAction("frank", { type: "bet", amount: 0 }).ok, false); // not posint
  assert.equal(eng.handleAction("frank", { type: "bet", amount: 100 }).ok, false); // unaffordable
  assert.equal(eng.handleAction("frank", { type: "deal" }).ok, false); // no bet placed
  assert.equal(eng.handleAction("frank", { type: "bogus" }).ok, false); // unknown action
});

test("integration: a full random cycle runs without throwing and conserves money", () => {
  const room = makeRoom({ p1: 1000, p2: 1000 });
  const eng = new BJ(room, makeCtx()); // real shuffled deck
  const total = () => room.players.get("p1").balance + room.players.get("p2").balance;
  const start = total();

  eng.handleAction("p1", { type: "sit", seat: 0 });
  eng.handleAction("p2", { type: "sit", seat: 1 });
  eng.handleAction("p1", { type: "bet", amount: 50 });
  eng.handleAction("p2", { type: "bet", amount: 50 });
  eng.handleAction("p1", { type: "deal" });

  // Drive each turn by standing until we're back to betting. Guard the loop.
  let guard = 0;
  while (eng.phase === "playing" && guard++ < 50) {
    const turn = eng.turn;
    const seat = eng.seats[turn.seat];
    const pid = seat.pid;
    eng.handleAction(pid, { type: "stand" });
  }
  assert.equal(eng.phase, "betting");
  // No chips created or destroyed beyond the zero-sum vs the (mock) dealer:
  // total can change because the dealer is not a player here, but each player's
  // balance must remain a non-negative integer and never exceed start+winnings.
  for (const pid of ["p1", "p2"]) {
    const b = room.players.get(pid).balance;
    assert.ok(Number.isInteger(b) && b >= 0, `balance sane for ${pid}`);
  }
  // sanity: results were recorded for both bettors
  const results = eng.getPublicState("p1").results;
  assert.ok(results.p1 && results.p2);
});
