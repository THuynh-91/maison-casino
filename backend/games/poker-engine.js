"use strict";
/*
 * Multiplayer No-Limit Texas Hold'em engine.
 *
 * Up to MAX_SEATS seats (default 6). Players sit, and when >=2 seated players
 * have chips a hand can start (manually via {type:"startHand"} or auto when a
 * seated player triggers it). Blinds rotate with the dealer button.
 *
 * Phases: "waiting" -> "preflop" -> "flop" -> "turn" -> "river" -> "showdown"
 *         -> "waiting" (next hand).
 *
 * ----------------------------------------------------------------- RULE CHOICES
 *  - Blinds default SB=5, BB=10 (configurable via ctx.config.{sb,bb}).
 *  - Dealer button rotates one seat clockwise each hand (to the next occupied
 *    seat). Heads-up: the button posts the small blind and acts first preflop
 *    (standard heads-up rule).
 *
 *  - BET/RAISE AMOUNT CONVENTION:  The `amount` field is the player's NEW TOTAL
 *    wager for this betting round (i.e. the total they want their `bet` to reach
 *    this round), NOT the additional chips. This matches "raise to X" table
 *    language and is documented here and in the contract report.
 *      * {type:"bet",   amount} — legal only when currentBet === 0. `amount` is
 *        the total bet this round and must be >= bigBlind (or all of the stack).
 *      * {type:"raise", amount} — legal only when currentBet > 0. `amount` is the
 *        new total to match and must be >= currentBet + minRaise (the size of
 *        the last bet/raise), unless it is an all-in for less.
 *      * {type:"call"}          — match currentBet (capped at the stack => all-in
 *        for less if short).
 *      * {type:"check"}         — only when the player already matches currentBet.
 *      * {type:"fold"}          — forfeit.
 *      * {type:"allin"}         — push the entire remaining stack; treated as a
 *        bet or raise depending on whether it exceeds currentBet.
 *
 *  - MIN-RAISE: equals the size of the last bet or raise increment this round
 *    (initialized to bigBlind preflop). A raise must increase the current bet by
 *    at least this much. An all-in that does not meet the min-raise is allowed
 *    but does NOT reopen the betting for players who already acted (standard NLHE
 *    incomplete-raise rule).
 *
 *  - SIDE POTS: every chip a player commits is tracked per player for the whole
 *    hand. At showdown we sort committed amounts and slice the pot into layers
 *    (main + side pots); each layer is contested only by players who contributed
 *    to that layer and have not folded. Each pot is awarded to the best eligible
 *    hand(s); ties split the pot evenly. ODD CHIPS left over from a split go to
 *    the eligible winner(s) in seat order starting from the first seat left of
 *    the dealer button (standard "odd chip to the left of the button" rule).
 *
 *  - HIDDEN INFO: getPublicState reveals only the viewer's own hole cards before
 *    showdown. At showdown, only non-folded players who reached showdown have
 *    their hole cards revealed in the last-hand summary.
 *
 * Test seam: draws from ctx.deck if it is a non-empty array (one-shot, consumed
 * front-to-back via shift()), otherwise makeShuffledDeck(1). Matches blackjack.
 */

const { makeShuffledDeck } = require("../lib/cards");
const { isPosInt } = require("../lib/validate");
const { evaluate7, compareHands, compareScores } = require("../lib/poker-hand");

const MAX_SEATS = 6;
const DEFAULT_SB = 5;
const DEFAULT_BB = 10;

class PokerEngine {
  constructor(room, ctx) {
    this.gameId = "poker";
    this.room = room;
    this.ctx = ctx;
    this.maxSeats = MAX_SEATS;

    const cfg = (ctx && ctx.config) || {};
    this.smallBlind = isPosInt(cfg.sb) ? cfg.sb : DEFAULT_SB;
    this.bigBlind = isPosInt(cfg.bb) ? cfg.bb : DEFAULT_BB;

    this.phase = "waiting";
    // seat = {
    //   pid, holeCards:[], folded, allin, inHand (dealt this hand),
    //   bet (chips in front this round), committed (chips in pot this hand),
    //   hasActed (acted since last raise this round)
    // }
    this.seats = new Array(this.maxSeats).fill(null);

    this.button = -1; // seat index of dealer button
    this.board = []; // community cards revealed so far
    this.deck = [];
    this.pot = 0; // total chips committed this hand (display)
    this.currentBet = 0; // highest bet this round
    this.minRaise = this.bigBlind; // min legal raise increment this round
    this.turn = -1; // seat index to act, or -1
    this.lastAggressor = -1; // seat that made the last bet/raise this round
    this.lastResult = null; // summary of the previous hand

    this._injectedDeck = Array.isArray(ctx && ctx.deck) ? ctx.deck : null;
  }

  // ----------------------------------------------------------- seat helpers
  _seatOf(pid) {
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i] && this.seats[i].pid === pid) return i;
    }
    return -1;
  }

  _occupiedSeats() {
    const out = [];
    for (let i = 0; i < this.seats.length; i++) if (this.seats[i]) out.push(i);
    return out;
  }

  // Next occupied seat strictly after `from` (wrapping), optionally requiring a
  // predicate. Returns -1 if none.
  _nextSeat(from, pred) {
    for (let step = 1; step <= this.maxSeats; step++) {
      const i = (from + step) % this.maxSeats;
      if (this.seats[i] && (!pred || pred(this.seats[i], i))) return i;
    }
    return -1;
  }

  _balanceOf(pid) {
    const p = this.room.getPlayer(pid);
    return p ? p.balance : 0;
  }

  // ----------------------------------------------------------- deck
  _freshDeck() {
    if (this._injectedDeck && this._injectedDeck.length) return this._injectedDeck.slice();
    return makeShuffledDeck(1);
  }

  _draw() {
    if (this.deck.length === 0) this.deck = makeShuffledDeck(1);
    return this.deck.shift();
  }

  // ----------------------------------------------------------- lifecycle
  onPlayerJoin() {
    // Players must explicitly sit; nothing to do here.
  }

  onPlayerLeave(pid) {
    const idx = this._seatOf(pid);
    if (idx === -1) return;
    const seat = this.seats[idx];
    const inLiveHand =
      this.phase !== "waiting" && this.phase !== "showdown" && seat.inHand && !seat.folded;
    if (inLiveHand) {
      // Fold them; their committed chips stay in the pot.
      seat.folded = true;
      seat.hasActed = true;
      const wasTurn = this.turn === idx;
      // Free the seat after folding so the table reconciles, but keep their
      // committed contribution recorded for side-pot math by leaving a ghost.
      this.seats[idx] = null;
      this._ghosts = this._ghosts || [];
      this._ghosts.push({ pid, committed: seat.committed, folded: true });
      const p = this.room.getPlayer(pid);
      if (p) p.seat = null;
      if (this._onlyOneLeft()) {
        this._endHandByFold();
      } else if (wasTurn) {
        this._advanceTurn();
      }
      this.ctx.broadcast();
      return;
    }
    // Not in a live hand: just clear the seat.
    this.seats[idx] = null;
    const p = this.room.getPlayer(pid);
    if (p) p.seat = null;
    this.ctx.broadcast();
  }

  dispose() {
    if (this._timer) clearTimeout(this._timer);
  }

  // ----------------------------------------------------------- action dispatch
  handleAction(pid, action) {
    const player = this.room.getPlayer(pid);
    if (!player) return { ok: false, error: "Unknown player" };
    const type = action && typeof action.type === "string" ? action.type : "";
    switch (type) {
      case "sit":
        return this._sit(pid, action);
      case "leave":
        return this._leave(pid);
      case "startHand":
        return this._startHand(pid);
      case "fold":
        return this._fold(pid);
      case "check":
        return this._check(pid);
      case "call":
        return this._call(pid);
      case "bet":
        return this._bet(pid, action);
      case "raise":
        return this._raise(pid, action);
      case "allin":
        return this._allin(pid);
      default:
        return { ok: false, error: "Unknown action" };
    }
  }

  _sit(pid, action) {
    if (this._seatOf(pid) !== -1) return { ok: false, error: "Already seated" };
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
    this.seats[idx] = this._newSeat(pid);
    const p = this.room.getPlayer(pid);
    if (p) p.seat = idx;
    this.ctx.broadcast();
    return { ok: true };
  }

  _newSeat(pid) {
    return {
      pid,
      holeCards: [],
      folded: false,
      allin: false,
      inHand: false,
      bet: 0,
      committed: 0,
      hasActed: false,
    };
  }

  _leave(pid) {
    const idx = this._seatOf(pid);
    if (idx === -1) return { ok: false, error: "Not seated" };
    this.onPlayerLeave(pid);
    return { ok: true };
  }

  // ----------------------------------------------------------- hand start
  _readySeats() {
    // Seated players with chips can be dealt in.
    return this._occupiedSeats().filter((i) => this._balanceOf(this.seats[i].pid) > 0);
  }

  _startHand(pid) {
    if (this.phase !== "waiting") return { ok: false, error: "Hand already in progress" };
    if (pid && this._seatOf(pid) === -1) return { ok: false, error: "Take a seat first" };
    const ready = this._readySeats();
    if (ready.length < 2) return { ok: false, error: "Need at least 2 players with chips" };

    // Reset per-hand state.
    this._ghosts = [];
    this.board = [];
    this.pot = 0;
    this.deck = this._freshDeck();
    this.lastResult = null;

    for (const i of this._occupiedSeats()) {
      const s = this.seats[i];
      s.holeCards = [];
      s.folded = false;
      s.allin = false;
      s.bet = 0;
      s.committed = 0;
      s.hasActed = false;
      s.inHand = ready.includes(i);
    }

    // Move button to the next ready seat.
    this.button = this._nextReady(this.button === -1 ? this.maxSeats - 1 : this.button, ready);

    // Determine blinds + first to act.
    const headsUp = ready.length === 2;
    let sbSeat;
    let bbSeat;
    if (headsUp) {
      // Heads-up: button is the small blind.
      sbSeat = this.button;
      bbSeat = this._nextReady(this.button, ready);
    } else {
      sbSeat = this._nextReady(this.button, ready);
      bbSeat = this._nextReady(sbSeat, ready);
    }

    // Deal two hole cards to each in-hand seat (one at a time, starting left of
    // the button as in a real deal — order is cosmetic for known decks).
    for (let round = 0; round < 2; round++) {
      let i = this._nextReady(this.button, ready);
      for (let n = 0; n < ready.length; n++) {
        this.seats[i].holeCards.push(this._draw());
        i = this._nextReady(i, ready);
      }
    }

    // Post blinds (debit balances into committed chips).
    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);

    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.lastAggressor = bbSeat;
    this.phase = "preflop";

    // First to act preflop: left of BB (or the button/SB heads-up = left of BB).
    this.turn = this._nextReady(bbSeat, ready, true);
    // If everyone is all-in from blinds (tiny stacks), resolve.
    this._maybeAutoAdvance();
    this.ctx.broadcast();
    return { ok: true };
  }

  // Next ready seat after `from`, optionally only among players who can still
  // act (in hand, not folded, not all-in).
  _nextReady(from, ready, actableOnly) {
    for (let step = 1; step <= this.maxSeats; step++) {
      const i = (from + step) % this.maxSeats;
      const s = this.seats[i];
      if (!s) continue;
      if (!ready.includes(i)) continue;
      if (actableOnly && (s.folded || s.allin)) continue;
      return i;
    }
    return -1;
  }

  _postBlind(seatIdx, amount) {
    const seat = this.seats[seatIdx];
    const bal = this._balanceOf(seat.pid);
    const post = Math.min(amount, bal); // short stack posts what it has (all-in)
    if (post > 0) this.room.debit(seat.pid, post);
    seat.bet = post;
    seat.committed += post;
    this.pot += post;
    if (this._balanceOf(seat.pid) === 0) seat.allin = true;
  }

  // ----------------------------------------------------------- betting actions
  _activeSeat(pid) {
    if (this.phase === "waiting" || this.phase === "showdown") {
      return { err: "No betting round in progress" };
    }
    const idx = this._seatOf(pid);
    if (idx === -1) return { err: "Not seated" };
    if (idx !== this.turn) return { err: "Not your turn" };
    const seat = this.seats[idx];
    if (!seat.inHand || seat.folded || seat.allin) return { err: "You cannot act" };
    return { idx, seat };
  }

  _fold(pid) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    a.seat.folded = true;
    a.seat.hasActed = true;
    if (this._onlyOneLeft()) {
      this._endHandByFold();
    } else {
      this._advanceTurn();
    }
    this.ctx.broadcast();
    return { ok: true };
  }

  _check(pid) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    if (a.seat.bet < this.currentBet) {
      return { ok: false, error: "Cannot check facing a bet" };
    }
    a.seat.hasActed = true;
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _call(pid) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    const seat = a.seat;
    const owe = this.currentBet - seat.bet;
    if (owe <= 0) return { ok: false, error: "Nothing to call — check instead" };
    const bal = this._balanceOf(seat.pid);
    const pay = Math.min(owe, bal); // call all-in for less if short
    if (pay <= 0) return { ok: false, error: "No chips to call" };
    this.room.debit(seat.pid, pay);
    seat.bet += pay;
    seat.committed += pay;
    this.pot += pay;
    if (this._balanceOf(seat.pid) === 0) seat.allin = true;
    seat.hasActed = true;
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _bet(pid, action) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    if (this.currentBet !== 0) return { ok: false, error: "There is a bet — raise instead" };
    const amount = action && action.amount;
    if (!isPosInt(amount)) return { ok: false, error: "Invalid bet amount" };
    const seat = a.seat;
    const bal = this._balanceOf(seat.pid);
    if (amount > bal) return { ok: false, error: "Bet exceeds your stack" };
    const isAllin = amount === bal;
    if (amount < this.bigBlind && !isAllin) {
      return { ok: false, error: `Minimum bet is ${this.bigBlind}` };
    }
    this._commit(seat, amount);
    this.currentBet = seat.bet;
    this.minRaise = Math.max(this.bigBlind, seat.bet);
    this.lastAggressor = a.idx;
    this._reopenAction(a.idx);
    seat.hasActed = true;
    if (this._balanceOf(seat.pid) === 0) seat.allin = true;
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _raise(pid, action) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    if (this.currentBet === 0) return { ok: false, error: "Nothing to raise — bet instead" };
    const amount = action && action.amount; // new TOTAL to match
    if (!isPosInt(amount)) return { ok: false, error: "Invalid raise amount" };
    const seat = a.seat;
    const bal = this._balanceOf(seat.pid);
    const maxTotal = seat.bet + bal; // most this player can have in front
    if (amount <= this.currentBet) {
      return { ok: false, error: "Raise must exceed the current bet" };
    }
    if (amount > maxTotal) return { ok: false, error: "Raise exceeds your stack" };
    const isAllin = amount === maxTotal;
    const raiseBy = amount - this.currentBet;
    if (raiseBy < this.minRaise && !isAllin) {
      return { ok: false, error: `Minimum raise is to ${this.currentBet + this.minRaise}` };
    }
    const add = amount - seat.bet;
    this._commit(seat, add);
    const fullRaise = raiseBy >= this.minRaise;
    if (fullRaise) {
      this.minRaise = raiseBy;
      this._reopenAction(a.idx);
      this.lastAggressor = a.idx;
    } else {
      // Incomplete (all-in for less): does NOT reopen action for players who
      // already acted, but the bet amount still increases.
      this.lastAggressor = a.idx;
    }
    this.currentBet = seat.bet;
    seat.hasActed = true;
    if (this._balanceOf(seat.pid) === 0) seat.allin = true;
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  _allin(pid) {
    const a = this._activeSeat(pid);
    if (a.err) return { ok: false, error: a.err };
    const seat = a.seat;
    const bal = this._balanceOf(seat.pid);
    if (bal <= 0) return { ok: false, error: "No chips to push" };
    const total = seat.bet + bal; // total in front after pushing
    if (total > this.currentBet) {
      // Acts as a bet (if currentBet 0) or raise.
      const raiseBy = total - this.currentBet;
      this._commit(seat, bal);
      if (this.currentBet === 0) {
        this.currentBet = seat.bet;
        this.minRaise = Math.max(this.bigBlind, seat.bet);
        this._reopenAction(a.idx);
        this.lastAggressor = a.idx;
      } else if (raiseBy >= this.minRaise) {
        this.minRaise = raiseBy;
        this.currentBet = seat.bet;
        this._reopenAction(a.idx);
        this.lastAggressor = a.idx;
      } else {
        // incomplete raise — increases bet but doesn't reopen
        this.currentBet = seat.bet;
        this.lastAggressor = a.idx;
      }
    } else {
      // All-in for a call (or less than the current bet).
      this._commit(seat, bal);
    }
    seat.allin = true;
    seat.hasActed = true;
    this._advanceTurn();
    this.ctx.broadcast();
    return { ok: true };
  }

  // Debit `add` chips from the player and move them into the round bet / pot.
  _commit(seat, add) {
    if (add <= 0) return;
    this.room.debit(seat.pid, add);
    seat.bet += add;
    seat.committed += add;
    this.pot += add;
  }

  // When someone bets/raises (a full raise), everyone else who hasn't folded /
  // isn't all-in must act again.
  _reopenAction(exceptIdx) {
    for (const i of this._occupiedSeats()) {
      const s = this.seats[i];
      if (i === exceptIdx) continue;
      if (s.folded || s.allin || !s.inHand) continue;
      s.hasActed = false;
    }
  }

  // ----------------------------------------------------------- turn / round flow
  _liveSeats() {
    // Seats still in the hand (dealt, not folded). Includes all-ins.
    return this._occupiedSeats().filter((i) => this.seats[i].inHand && !this.seats[i].folded);
  }

  _onlyOneLeft() {
    return this._liveSeats().length <= 1;
  }

  // Seats that can still act (in hand, not folded, not all-in).
  _actableSeats() {
    return this._liveSeats().filter((i) => !this.seats[i].allin);
  }

  _roundComplete() {
    const actable = this._actableSeats();
    // Round is complete when every actable seat has acted AND matched currentBet.
    for (const i of actable) {
      const s = this.seats[i];
      if (!s.hasActed) return false;
      if (s.bet !== this.currentBet) return false;
    }
    return true;
  }

  // Betting is closed for the rest of the hand when at most one player can still
  // act AND that player (if any) has already matched the current bet — i.e. no
  // meaningful decision remains (everyone else is all-in or folded).
  _bettingClosed() {
    const actable = this._actableSeats();
    if (actable.length === 0) return true;
    if (actable.length === 1) {
      const s = this.seats[actable[0]];
      return s.hasActed && s.bet === this.currentBet;
    }
    return false;
  }

  _advanceTurn() {
    if (this._onlyOneLeft()) {
      this._endHandByFold();
      return;
    }
    // If no meaningful betting decision remains, run out the board to showdown.
    if (this._bettingClosed()) {
      this._runOutAndShowdown();
      return;
    }
    if (this._roundComplete()) {
      this._nextStreet();
      return;
    }
    // Find next actable seat after current turn.
    const next = this._nextActable(this.turn);
    if (next === -1) {
      this._nextStreet();
    } else {
      this.turn = next;
    }
  }

  _nextActable(from) {
    for (let step = 1; step <= this.maxSeats; step++) {
      const i = (from + step) % this.maxSeats;
      const s = this.seats[i];
      if (!s) continue;
      if (!s.inHand || s.folded || s.allin) continue;
      if (!s.hasActed || s.bet !== this.currentBet) return i;
    }
    return -1;
  }

  // After blinds: if only one or zero players can act (e.g. everyone all-in),
  // skip straight to running out the board.
  _maybeAutoAdvance() {
    if (this._actableSeats().length <= 1) {
      // Heads-up preflop, if the only actable player still owes the blind they
      // should still get to act; only auto-advance when nobody can act at all.
      if (this._actableSeats().length === 0) {
        this._runOutAndShowdown();
      }
    }
  }

  _nextStreet() {
    // Reset per-round bet state.
    for (const i of this._occupiedSeats()) {
      const s = this.seats[i];
      s.bet = 0;
      if (s.inHand && !s.folded && !s.allin) s.hasActed = false;
      else s.hasActed = true;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressor = -1;

    if (this.phase === "preflop") {
      this.phase = "flop";
      this.board.push(this._draw(), this._draw(), this._draw());
    } else if (this.phase === "flop") {
      this.phase = "turn";
      this.board.push(this._draw());
    } else if (this.phase === "turn") {
      this.phase = "river";
      this.board.push(this._draw());
    } else if (this.phase === "river") {
      this._showdown();
      return;
    }

    // If no meaningful betting remains (all-but-one all-in), run it out.
    if (this._bettingClosed()) {
      this._runOutAndShowdown();
      return;
    }
    // First to act post-flop: first actable seat left of the button.
    this.turn = this._nextActable(this.button);
    if (this.turn === -1) {
      // No one can act — advance again.
      this._nextStreet();
    }
  }

  _runOutAndShowdown() {
    // Deal any missing community cards, then showdown.
    while (this.board.length < 5 && this._liveSeats().length > 1) {
      if (this.phase === "preflop") {
        this.phase = "flop";
        this.board.push(this._draw(), this._draw(), this._draw());
      } else if (this.phase === "flop") {
        this.phase = "turn";
        this.board.push(this._draw());
      } else if (this.phase === "turn") {
        this.phase = "river";
        this.board.push(this._draw());
      } else break;
    }
    this._showdown();
  }

  // ----------------------------------------------------------- end of hand
  _endHandByFold() {
    // Exactly one live seat — award the whole pot, no showdown / no card reveal.
    const live = this._liveSeats();
    const summary = {
      type: "fold",
      board: this.board.slice(),
      pot: this.pot,
      winners: [],
      revealed: [],
    };
    if (live.length === 1) {
      const i = live[0];
      const seat = this.seats[i];
      if (this.pot > 0) this.room.credit(seat.pid, this.pot);
      summary.winners.push({ pid: seat.pid, seat: i, amount: this.pot });
    }
    this._finishHand(summary);
  }

  _showdown() {
    this.phase = "showdown";
    const live = this._liveSeats();
    // Build contributions for everyone who put chips in (including folded &
    // ghosts) so side pots are correct.
    const contributions = this._allContributions();
    const pots = this._buildPots(contributions);

    // Evaluate hands for live (non-folded) seats reaching showdown.
    const scores = {}; // seatIdx -> score
    const revealed = [];
    for (const i of live) {
      const seat = this.seats[i];
      const seven = seat.holeCards.concat(this.board);
      scores[i] = evaluate7(seven);
      revealed.push({ pid: seat.pid, seat: i, holeCards: seat.holeCards.slice(), hand: scores[i] });
    }

    const winnersBySeat = {}; // seatIdx -> total won
    const potResults = [];
    for (const pot of pots) {
      // Eligible = contributors to this pot that are still live (not folded).
      const eligible = pot.eligible.filter((pid) => {
        const si = this._seatOf(pid);
        return si !== -1 && live.includes(si);
      });
      if (eligible.length === 0) {
        // Everyone eligible folded (rare: only folded contributors). Pot is dead
        // chips — should not normally happen because the fold-to-one path handles
        // it; guard by giving to nobody. Skip.
        continue;
      }
      // Find best score among eligible.
      let best = null;
      let bestSeats = [];
      for (const pid of eligible) {
        const si = this._seatOf(pid);
        const sc = scores[si];
        if (best === null || compareScores(sc, best) > 0) {
          best = sc;
          bestSeats = [si];
        } else if (compareScores(sc, best) === 0) {
          bestSeats.push(si);
        }
      }
      // Split this pot among bestSeats; odd chips to the first seat left of the
      // button.
      const share = Math.floor(pot.amount / bestSeats.length);
      let remainder = pot.amount - share * bestSeats.length;
      const orderedWinners = this._orderFromButton(bestSeats);
      for (const si of orderedWinners) {
        let amt = share;
        if (remainder > 0) {
          amt += 1;
          remainder -= 1;
        }
        winnersBySeat[si] = (winnersBySeat[si] || 0) + amt;
      }
      potResults.push({
        amount: pot.amount,
        winners: orderedWinners.map((si) => this.seats[si].pid),
      });
    }

    // Credit winners.
    const winners = [];
    for (const si of Object.keys(winnersBySeat)) {
      const seatIdx = Number(si);
      const seat = this.seats[seatIdx];
      const amt = winnersBySeat[si];
      if (amt > 0) this.room.credit(seat.pid, amt);
      winners.push({ pid: seat.pid, seat: seatIdx, amount: amt, hand: scores[seatIdx] });
    }

    const summary = {
      type: "showdown",
      board: this.board.slice(),
      pot: this.pot,
      pots: potResults,
      winners,
      revealed,
    };
    this._finishHand(summary);
  }

  // Gather { pid, committed } for all contributors this hand (seated + ghosts).
  _allContributions() {
    const out = [];
    for (const i of this._occupiedSeats()) {
      const s = this.seats[i];
      if (s.committed > 0) out.push({ pid: s.pid, committed: s.committed, folded: s.folded });
    }
    for (const g of this._ghosts || []) {
      if (g.committed > 0) out.push({ pid: g.pid, committed: g.committed, folded: true });
    }
    return out;
  }

  // Build main + side pots from per-player contributions. Returns an array of
  // { amount, eligible:[pid...] } ordered main-first. `eligible` lists all pids
  // that contributed to that layer (folded filtered out at award time).
  _buildPots(contributions) {
    const pots = [];
    // Distinct positive contribution levels, ascending.
    const levels = [...new Set(contributions.map((c) => c.committed))]
      .filter((x) => x > 0)
      .sort((a, b) => a - b);
    let prev = 0;
    for (const level of levels) {
      const layer = level - prev;
      const contributors = contributions.filter((c) => c.committed >= level);
      const amount = layer * contributors.length;
      // Eligible to WIN = contributors at this level who did not fold.
      const eligible = contributors.filter((c) => !c.folded).map((c) => c.pid);
      if (amount > 0) {
        // Merge with previous pot if eligibility set is identical (keeps pot
        // count minimal, but separate layers with different eligibility stay
        // separate).
        pots.push({ amount, eligible });
      }
      prev = level;
    }
    return pots;
  }

  // Order a list of seat indices starting from the first seat left of the button
  // (button+1, wrapping). Used for odd-chip distribution.
  _orderFromButton(seatIdxs) {
    const set = new Set(seatIdxs);
    const ordered = [];
    for (let step = 1; step <= this.maxSeats; step++) {
      const i = (this.button + step) % this.maxSeats;
      if (set.has(i)) ordered.push(i);
    }
    return ordered;
  }

  _finishHand(summary) {
    this.lastResult = summary;
    this.phase = "waiting";
    this.turn = -1;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressor = -1;
    // Reset per-hand seat flags (keep seats + balances).
    for (const i of this._occupiedSeats()) {
      const s = this.seats[i];
      s.holeCards = [];
      s.bet = 0;
      s.committed = 0;
      s.folded = false;
      s.allin = false;
      s.inHand = false;
      s.hasActed = false;
    }
    this.pot = 0;
    this._ghosts = [];
    // Drop a one-shot injected deck so the next hand shuffles unless re-injected.
    this._injectedDeck = null;
    this.ctx.broadcast();
  }

  // ----------------------------------------------------------- public state
  getPublicState(viewerId) {
    const showdown = this.phase === "showdown";
    const seats = this.seats.map((seat, i) => {
      if (!seat) return { seat: i, empty: true };
      const isYou = seat.pid === viewerId;
      // Hole cards: own cards always; others only if revealed at showdown via
      // lastResult (handled below for the *finished* hand). During a live hand,
      // never reveal other players' cards.
      let holeCards = null;
      let hasCards = seat.holeCards.length > 0;
      if (isYou) {
        holeCards = seat.holeCards.slice();
      }
      return {
        seat: i,
        empty: false,
        pid: seat.pid,
        you: isYou,
        stack: this._balanceOf(seat.pid),
        bet: seat.bet,
        committed: seat.committed,
        folded: seat.folded,
        allin: seat.allin,
        inHand: seat.inHand,
        hasCards,
        isButton: i === this.button,
        isTurn: i === this.turn,
        holeCards, // null unless it's you
      };
    });

    const youSeat = this._seatOf(viewerId);
    const youOwe =
      youSeat !== -1 && this.turn === youSeat && this.seats[youSeat]
        ? Math.max(0, this.currentBet - this.seats[youSeat].bet)
        : 0;

    return {
      gameId: "poker",
      phase: this.phase,
      maxSeats: this.maxSeats,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      board: this.board.slice(),
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      // The minimum legal "raise to" total for the player to act.
      minRaiseTo: this.currentBet > 0 ? this.currentBet + this.minRaise : this.bigBlind,
      button: this.button,
      turn: this.turn,
      toCall: youOwe,
      yourSeat: youSeat === -1 ? null : youSeat,
      seats,
      lastResult: this.lastResult,
    };
  }
}

module.exports = PokerEngine;
module.exports.Engine = PokerEngine;
module.exports.evaluate7 = evaluate7;
module.exports.compareHands = compareHands;
module.exports.MAX_SEATS = MAX_SEATS;
module.exports.DEFAULT_SB = DEFAULT_SB;
module.exports.DEFAULT_BB = DEFAULT_BB;
