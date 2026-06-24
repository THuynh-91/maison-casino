"use strict";
/*
 * Multiplayer Blackjack engine vs a dealer.
 *
 * Up to MAX_SEATS seats (default 5). Players sit, bet, then any seated bettor
 * (or auto when every bettor has bet) triggers the deal. Each seat + the dealer
 * get two cards; the dealer's second card ("hole card") stays hidden in the
 * public state until the dealer's turn. The active seat acts (hit/stand/double/
 * split), then the dealer draws, then hands settle and chips move.
 *
 * ------------------------------------------------------------------ RULE CHOICES
 *  - Dealer STANDS on all 17, INCLUDING soft 17 (S17). Documented & standard.
 *  - Blackjack pays 3:2: a winning natural returns floor(stake * 2.5) total
 *    (i.e. profit = floor(stake * 1.5)). Rounding favors the house only on the
 *    half-chip remainder; ties go to the player on a push (stake returned).
 *  - SPLIT depth is ONE level (no re-splitting). Splitting requires two cards of
 *    equal rank VALUE (so T/J/Q/K all count as 10 and may be split together).
 *    Split aces receive exactly one card each and then auto-stand. A 21 made by
 *    hitting a split hand counts as 21, NOT a "blackjack" (no 3:2 on split 21).
 *  - DOUBLE is allowed only on the first two cards of a hand (incl. each split
 *    hand); it debits a second equal stake, deals one card, and auto-stands.
 *
 * Phases: "betting" -> "playing" -> "dealer" -> "settle" -> "betting".
 *
 * Test seam: the constructor / each round will draw from ctx.deck if it is a
 * non-empty array (cards dealt by shift() from the front), otherwise from a
 * freshly shuffled deck. This lets tests force a known deal.
 */
const { makeShuffledDeck, rankOf } = require("../lib/cards");
const { isPosInt } = require("../lib/validate");

const MAX_SEATS = 5;
const DEALER_STANDS_ON_SOFT_17 = true; // S17

// ----------------------------------------------------------------- PURE HELPERS

// Best hand value treating Aces as 11 when it doesn't bust, else 1.
// Returns { value, soft } where soft=true means an Ace is still counted as 11.
function handInfo(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = rankOf(c);
    if (r === "A") {
      aces += 1;
      total += 11;
    } else if (r === "K" || r === "Q" || r === "J" || r === "T") {
      total += 10;
    } else {
      total += parseInt(r, 10);
    }
  }
  // Demote Aces from 11 to 1 while busting.
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return { value: total, soft: softAces > 0 };
}

// Best blackjack value of a set of cards (Aces 1 or 11).
function handValue(cards) {
  return handInfo(cards).value;
}

// Is this a soft hand (an Ace still counted as 11)?
function isSoft(cards) {
  return handInfo(cards).soft;
}

function isBust(cards) {
  return handValue(cards) > 21;
}

// Blackjack = exactly two cards totalling 21 (Ace + ten-value).
function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

/*
 * Settle a single player hand against the dealer's hand.
 *  - playerHand: { cards, bet, isSplit? }  (bet = chips staked on THIS hand)
 *  - dealerHand: array of dealer cards (fully drawn out)
 * Returns { outcome, payout, net } where:
 *  - outcome ∈ "blackjack" | "win" | "push" | "lose"
 *  - payout  = chips returned to the player (0 on a loss)
 *  - net     = payout - bet (profit; negative on a loss)
 * A player natural beats a non-natural dealer 21 and pays 3:2. Two naturals push.
 */
function settleHand(playerHand, dealerHand) {
  const bet = playerHand.bet;
  const pCards = playerHand.cards;
  const dCards = dealerHand;
  const pVal = handValue(pCards);
  const dVal = handValue(dCards);
  // A natural only counts when the hand wasn't formed by splitting.
  const pBJ = isBlackjack(pCards) && !playerHand.isSplit;
  const dBJ = isBlackjack(dCards);

  const result = (outcome, payout) => ({ outcome, payout, net: payout - bet });

  if (pVal > 21) return result("lose", 0); // player bust always loses
  if (pBJ && dBJ) return result("push", bet);
  if (pBJ) return result("blackjack", Math.floor(bet * 2.5));
  if (dBJ) return result("lose", 0);
  if (dVal > 21) return result("win", bet * 2); // dealer bust
  if (pVal > dVal) return result("win", bet * 2);
  if (pVal < dVal) return result("lose", 0);
  return result("push", bet);
}

// ----------------------------------------------------------------- THE ENGINE

class BlackjackEngine {
  constructor(room, ctx) {
    this.gameId = "blackjack";
    this.room = room;
    this.ctx = ctx;
    this.phase = "betting";
    this.maxSeats = MAX_SEATS;

    // Seats: fixed-length array, each entry null or a seat object.
    // seat = {
    //   pid, bet (un-dealt stake during betting / first hand's base stake),
    //   hands: [{ cards:[], bet, status, isSplit, doubled }],
    //   active: index of hand being played, done: bool, results: [..]
    // }
    this.seats = new Array(this.maxSeats).fill(null);

    this.dealer = { cards: [] };
    this.turn = null; // { seat, hand } whose turn it is during "playing"
    this.deck = [];
    this.lastResults = null; // pid -> { net, hands:[{outcome,payout,bet}] }

    // Optional injected deck for deterministic tests (array of card strings).
    this._injectedDeck = Array.isArray(ctx && ctx.deck) ? ctx.deck : null;
  }

  // ---- seat helpers ----
  _seatOf(pid) {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] && this.seats[i].pid === pid) return i;
    }
    return -1;
  }

  _freshDeck() {
    if (this._injectedDeck && this._injectedDeck.length) {
      // Consume the injected deck (copy so we don't mutate the caller's array
      // beyond what we draw; we draw from the front via shift()).
      return this._injectedDeck.slice();
    }
    return makeShuffledDeck(1);
  }

  _draw() {
    if (this.deck.length === 0) {
      // Reshuffle a new deck if we somehow run dry (many seats / splits).
      this.deck = makeShuffledDeck(1);
    }
    return this.deck.shift();
  }

  // ---- lifecycle ----
  onPlayerLeave(pid) {
    const idx = this._seatOf(pid);
    if (idx === -1) return;
    const seat = this.seats[idx];
    // Refund any chips that are still at risk but not resolved:
    //  - during betting: the un-dealt base bet
    //  - during playing/dealer: any hands not yet settled (their bets)
    if (this.phase === "betting") {
      if (seat.bet > 0) this.room.credit(pid, seat.bet);
    } else if (this.phase === "playing" || this.phase === "dealer") {
      let refund = 0;
      for (const h of seat.hands) {
        if (h.status === "playing" || h.status === "stand" || h.status === "blackjack") {
          refund += h.bet;
        }
      }
      if (refund > 0) this.room.credit(pid, refund);
      // If it was their turn, advance so others can keep playing.
      const wasTurn = this.turn && this.turn.seat === idx;
      this.seats[idx] = null;
      if (wasTurn) {
        this._advanceTurn();
        this.ctx.broadcast();
        return;
      }
    }
    this.seats[idx] = null;
    this.ctx.broadcast();
  }

  dispose() {
    // No timers held; defined for contract completeness.
  }

  // ---- public state ----
  getPublicState(viewerId) {
    const dealerReveal = this.phase === "dealer" || this.phase === "settle";
    let dealerCards;
    if (this.phase === "betting") {
      dealerCards = [];
    } else if (dealerReveal) {
      dealerCards = this.dealer.cards.slice();
    } else {
      // playing: show upcard only, hide the hole card.
      dealerCards = this.dealer.cards.length
        ? [this.dealer.cards[0], "??"]
        : [];
    }
    const dealerValue = dealerReveal ? handValue(this.dealer.cards) : null;

    const seats = this.seats.map((seat, i) => {
      if (!seat) return { seat: i, empty: true };
      const isYou = seat.pid === viewerId;
      const hands = seat.hands.map((h, hi) => ({
        cards: h.cards.slice(),
        value: handValue(h.cards),
        soft: isSoft(h.cards),
        bet: h.bet,
        status: h.status,
        isSplit: !!h.isSplit,
        doubled: !!h.doubled,
        isTurn:
          this.phase === "playing" &&
          this.turn &&
          this.turn.seat === i &&
          this.turn.hand === hi,
      }));
      return {
        seat: i,
        empty: false,
        pid: seat.pid,
        you: isYou,
        bet: seat.bet,
        hands,
        result: this.lastResults ? this.lastResults[seat.pid] || null : null,
      };
    });

    return {
      gameId: "blackjack",
      phase: this.phase,
      maxSeats: this.maxSeats,
      dealerStandsOnSoft17: DEALER_STANDS_ON_SOFT_17,
      dealer: { cards: dealerCards, value: dealerValue },
      seats,
      turn: this.turn ? { seat: this.turn.seat, hand: this.turn.hand } : null,
      yourSeat: this._seatOf(viewerId) === -1 ? null : this._seatOf(viewerId),
      results: this.lastResults,
    };
  }

  // ---- action dispatch ----
  handleAction(pid, action) {
    const player = this.room.getPlayer(pid);
    if (!player) return { ok: false, error: "Unknown player" };
    const type = action && typeof action.type === "string" ? action.type : "";
    switch (type) {
      case "sit":
        return this._sit(pid, action);
      case "leave":
        return this._leave(pid);
      case "bet":
        return this._bet(pid, action);
      case "deal":
        return this._deal(pid);
      case "hit":
        return this._hit(pid);
      case "stand":
        return this._stand(pid);
      case "double":
        return this._double(pid);
      case "split":
        return this._split(pid);
      default:
        return { ok: false, error: "Unknown action" };
    }
  }

  _sit(pid, action) {
    if (this._seatOf(pid) !== -1) return { ok: false, error: "Already seated" };
    if (this.phase !== "betting") return { ok: false, error: "Wait for the next round to sit" };
    let idx = -1;
    if (action && action.seat !== undefined && action.seat !== null) {
      const s = action.seat;
      if (!Number.isInteger(s) || s < 0 || s >= this.maxSeats) {
        return { ok: false, error: "Invalid seat" };
      }
      if (this.seats[s]) return { ok: false, error: "Seat taken" };
      idx = s;
    } else {
      idx = this.seats.findIndex((x) => x === null);
      if (idx === -1) return { ok: false, error: "Table full" };
    }
    this.seats[idx] = { pid, bet: 0, hands: [], active: 0, done: false };
    const p = this.room.getPlayer(pid);
    if (p) p.seat = idx;
    this.ctx.broadcast();
    return { ok: true };
  }

  _leave(pid) {
    const idx = this._seatOf(pid);
    if (idx === -1) return { ok: false, error: "Not seated" };
    this.onPlayerLeave(pid);
    const p = this.room.getPlayer(pid);
    if (p) p.seat = null;
    return { ok: true };
  }

  _bet(pid, action) {
    if (this.phase !== "betting") return { ok: false, error: "Betting is closed" };
    const idx = this._seatOf(pid);
    if (idx === -1) return { ok: false, error: "Take a seat first" };
    const amount = action && action.amount;
    if (!isPosInt(amount)) return { ok: false, error: "Invalid bet amount" };
    const seat = this.seats[idx];
    // Replace any previous bet this round: refund the old, debit the new.
    if (seat.bet > 0) this.room.credit(pid, seat.bet);
    if (!this.room.debit(pid, amount)) {
      seat.bet = 0;
      this.ctx.broadcast();
      return { ok: false, error: "Insufficient balance" };
    }
    seat.bet = amount;
    this.ctx.broadcast();
    return { ok: true };
  }

  _seatedBettors() {
    return this.seats.filter((s) => s && s.bet > 0);
  }

  _deal(pid) {
    if (this.phase !== "betting") return { ok: false, error: "Round already dealt" };
    const idx = this._seatOf(pid);
    if (idx === -1) return { ok: false, error: "Take a seat first" };
    if (this.seats[idx].bet <= 0) return { ok: false, error: "Place a bet first" };
    const bettors = this._seatedBettors();
    if (bettors.length === 0) return { ok: false, error: "No bets on the table" };

    this.phase = "playing";
    this.deck = this._freshDeck();
    this.dealer = { cards: [] };
    this.lastResults = null;

    // Set up each bettor's first hand. Non-betting seats sit this round out.
    for (const seat of this.seats) {
      if (!seat) continue;
      if (seat.bet <= 0) {
        seat.hands = [];
        continue;
      }
      seat.hands = [
        { cards: [], bet: seat.bet, status: "playing", isSplit: false, doubled: false },
      ];
      seat.active = 0;
      seat.done = false;
    }

    // Deal two rounds: each active seat one card, then dealer; repeat.
    for (let round = 0; round < 2; round++) {
      for (const seat of this.seats) {
        if (!seat || seat.bet <= 0) continue;
        seat.hands[0].cards.push(this._draw());
      }
      this.dealer.cards.push(this._draw());
    }

    // Mark naturals.
    for (const seat of this.seats) {
      if (!seat || seat.bet <= 0) continue;
      if (isBlackjack(seat.hands[0].cards)) {
        seat.hands[0].status = "blackjack";
        seat.done = true;
      }
    }

    // First turn = first seat with an unfinished hand.
    this.turn = this._firstUnfinishedTurn();
    if (!this.turn) {
      // Everyone has a natural (or no playable hands) — go straight to dealer.
      this._runDealer();
    }
    this.ctx.broadcast();
    return { ok: true };
  }

  _firstUnfinishedTurn() {
    for (let i = 0; i < this.seats.length; i++) {
      const seat = this.seats[i];
      if (!seat || seat.bet <= 0) continue;
      for (let h = 0; h < seat.hands.length; h++) {
        if (seat.hands[h].status === "playing") return { seat: i, hand: h };
      }
    }
    return null;
  }

  _currentHand(pid) {
    if (this.phase !== "playing" || !this.turn) return null;
    const idx = this._seatOf(pid);
    if (idx === -1 || idx !== this.turn.seat) return null;
    const seat = this.seats[idx];
    const hand = seat.hands[this.turn.hand];
    if (!hand || hand.status !== "playing") return null;
    return { seat, hand, idx };
  }

  _advanceTurn() {
    this.turn = this._firstUnfinishedTurn();
    if (!this.turn) this._runDealer();
  }

  _hit(pid) {
    const cur = this._currentHand(pid);
    if (!cur) return { ok: false, error: "Not your turn" };
    cur.hand.cards.push(this._draw());
    if (isBust(cur.hand.cards)) {
      cur.hand.status = "bust";
      this._advanceTurn();
    } else if (handValue(cur.hand.cards) === 21) {
      cur.hand.status = "stand";
      this._advanceTurn();
    }
    this.ctx.broadcast();
    return { ok: true };
  }

  _stand(pid) {
    const cur = this._currentHand(pid);
    if (!cur) return { ok: false, error: "Not your turn" };
    cur.hand.status = "stand";
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _double(pid) {
    const cur = this._currentHand(pid);
    if (!cur) return { ok: false, error: "Not your turn" };
    if (cur.hand.cards.length !== 2) return { ok: false, error: "Double only on first two cards" };
    if (!this.room.debit(pid, cur.hand.bet)) return { ok: false, error: "Insufficient balance to double" };
    cur.hand.bet *= 2;
    cur.hand.doubled = true;
    cur.hand.cards.push(this._draw());
    cur.hand.status = isBust(cur.hand.cards) ? "bust" : "stand";
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _split(pid) {
    const cur = this._currentHand(pid);
    if (!cur) return { ok: false, error: "Not your turn" };
    const { seat, hand } = cur;
    if (hand.cards.length !== 2) return { ok: false, error: "Can only split first two cards" };
    if (hand.isSplit) return { ok: false, error: "Re-splitting is not allowed" };
    if (seat.hands.length > 1) return { ok: false, error: "Re-splitting is not allowed" };
    // Equal rank VALUE (ten-value cards may be split together).
    const v = (c) => {
      const r = rankOf(c);
      if (r === "K" || r === "Q" || r === "J" || r === "T") return 10;
      if (r === "A") return 11;
      return parseInt(r, 10);
    };
    if (v(hand.cards[0]) !== v(hand.cards[1])) {
      return { ok: false, error: "Can only split a pair of equal value" };
    }
    if (!this.room.debit(pid, hand.bet)) return { ok: false, error: "Insufficient balance to split" };

    const splittingAces = rankOf(hand.cards[0]) === "A";
    const c0 = hand.cards[0];
    const c1 = hand.cards[1];
    const baseBet = hand.bet;

    const hand0 = { cards: [c0], bet: baseBet, status: "playing", isSplit: true, doubled: false };
    const hand1 = { cards: [c1], bet: baseBet, status: "playing", isSplit: true, doubled: false };
    // Replace the current hand with the two split hands (insert in place).
    seat.hands.splice(this.turn.hand, 1, hand0, hand1);

    // Deal one card to each new hand.
    hand0.cards.push(this._draw());
    hand1.cards.push(this._draw());

    if (splittingAces) {
      // Split aces get one card each then auto-stand (standard rule).
      hand0.status = "stand";
      hand1.status = "stand";
    } else {
      if (handValue(hand0.cards) === 21) hand0.status = "stand";
      if (handValue(hand1.cards) === 21) hand1.status = "stand";
    }

    // Re-point turn to the first still-playing hand (could have auto-stood).
    this.turn = this._firstUnfinishedTurn();
    if (!this.turn) this._runDealer();
    this.ctx.broadcast();
    return { ok: true };
  }

  // ---- dealer + settle ----
  _runDealer() {
    this.phase = "dealer";
    // Dealer only needs to draw if at least one player hand is live (not bust /
    // not a settled natural-only board handled elsewhere). We draw regardless;
    // it's harmless and keeps the reveal honest.
    const anyLive = this.seats.some(
      (s) => s && s.bet > 0 && s.hands.some((h) => h.status === "stand" || h.status === "playing")
    );
    if (anyLive) {
      // Hit until hard 17+ or (S17) any 17+.
      for (;;) {
        const info = handInfo(this.dealer.cards);
        if (info.value > 21) break;
        if (info.value > 17) break;
        if (info.value === 17) {
          if (DEALER_STANDS_ON_SOFT_17) break; // stand on soft 17 too
          if (!info.soft) break; // hit soft 17 only if H17
        }
        this.dealer.cards.push(this._draw());
      }
    }
    this._settle();
  }

  _settle() {
    this.phase = "settle";
    const results = {};
    for (const seat of this.seats) {
      if (!seat || seat.bet <= 0) continue;
      const handResults = [];
      let net = 0;
      for (const h of seat.hands) {
        const r = settleHand(h, this.dealer.cards);
        if (r.payout > 0) this.room.credit(seat.pid, r.payout);
        handResults.push({ outcome: r.outcome, payout: r.payout, bet: h.bet });
        net += r.net;
      }
      results[seat.pid] = { net, hands: handResults };
    }
    this.lastResults = results;
    // Reset for the next betting round: clear hands & bets, keep the seats.
    for (const seat of this.seats) {
      if (!seat) continue;
      seat.bet = 0;
      seat.hands = [];
      seat.active = 0;
      seat.done = false;
    }
    this.dealer = { cards: [] };
    this.turn = null;
    this.phase = "betting";
    // Drop a one-shot injected deck so the next round shuffles normally unless
    // the test re-injects one.
    this._injectedDeck = null;
    this.ctx.broadcast();
  }
}

module.exports = BlackjackEngine;
module.exports.Engine = BlackjackEngine;
module.exports.handValue = handValue;
module.exports.handInfo = handInfo;
module.exports.isSoft = isSoft;
module.exports.isBust = isBust;
module.exports.isBlackjack = isBlackjack;
module.exports.settleHand = settleHand;
module.exports.MAX_SEATS = MAX_SEATS;
module.exports.DEALER_STANDS_ON_SOFT_17 = DEALER_STANDS_ON_SOFT_17;
