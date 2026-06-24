/*
 * games/blackjack.js — multiplayer Blackjack view (up to 5 seats vs the dealer).
 *
 * Registers itself as window.CasinoGames.blackjack = { mount, update, unmount }.
 * Mirrors the registration + lifecycle shape of games/roulette.js exactly so the
 * app.js game router can mount/update/unmount it the same way.
 *
 * SERVER-AUTHORITATIVE: all money + game logic live on the backend
 * (backend/games/blackjack-engine.js). This view reads the per-viewer public
 * state from roomState.game and emits actions via ctx.socket.gameAction:
 *
 *   {type:"sit", seat?}, {type:"leave"}, {type:"bet", amount}, {type:"deal"},
 *   {type:"hit"}, {type:"stand"}, {type:"double"}, {type:"split"}
 *
 * Public state (getPublicState), see engine:
 *   { gameId, phase:"betting"|"playing"|"dealer"|"settle", maxSeats, dealerStandsOnSoft17,
 *     dealer:{cards:[...], value|null}, seats:[{seat,empty}|{seat,empty:false,pid,you,bet,hands:[
 *       {cards,value,soft,bet,status,isSplit,doubled,isTurn}], result}],
 *     turn:{seat,hand}|null, yourSeat:number|null, results:{pid:{net,hands}} }
 *
 * NOTE: the engine collapses "settle" back to "betting" in the same tick but keeps
 * `results`/seat.result populated until the next deal — so results are rendered
 * whenever they're present, regardless of the phase label.
 *
 * Player NAMES + balances are resolved from the room players list via
 * ctx.getPlayers() (pid -> name/balance). Balance is never tracked locally.
 */
(function () {
  "use strict";

  const { el, clear, toast, money } = window.UI;

  const SUIT = {
    s: { glyph: "♠", red: false }, // spades
    h: { glyph: "♥", red: true },  // hearts
    d: { glyph: "♦", red: true },  // diamonds
    c: { glyph: "♣", red: false }, // clubs
  };
  const RANK_LABEL = { T: "10" }; // others render as-is (A K Q J 9..2)

  const CHIP_VALUES = [5, 25, 100, 500];

  // ---- View instance state (rebuilt each mount) ----
  let V = null;

  function freshView() {
    return {
      ctx: null,
      root: null,
      chipValue: 25,
      els: {},
      // remembers which card DOM keys we've already shown so newly-dealt cards
      // can animate in (and previously-seen ones don't re-animate on every push).
      seenCards: new Set(),
    };
  }

  // ---- public API ------------------------------------------------------
  const Blackjack = {
    mount(container, ctx) {
      V = freshView();
      V.ctx = ctx;
      V.root = container;
      buildDOM(container);
      this.update(ctx.getState());
    },

    update(roomState) {
      if (!V || !roomState || roomState.gameId !== "blackjack") return;
      const g = roomState.game;
      if (!g) return;
      renderState(g);
    },

    unmount() {
      if (!V) return;
      V = null;
    },
  };
  window.CasinoGames = window.CasinoGames || {};
  window.CasinoGames.blackjack = Blackjack;

  // =====================================================================
  // DOM scaffold
  // =====================================================================
  function buildDOM(container) {
    const phasePill = el("div", { class: "bj-phase pill", id: "bj-phase" }, "Blackjack");
    const rulePill = el("span", { class: "bj-rule caption", id: "bj-rule" }, "");

    const dealer = el("section", { class: "bj-dealer", id: "bj-dealer" }, [
      el("div", { class: "bj-dealer__head" }, [
        el("span", { class: "bj-area-label" }, "Dealer"),
        el("span", { class: "bj-value pill", id: "bj-dealer-value" }, ""),
      ]),
      el("div", { class: "bj-hand bj-dealer__hand", id: "bj-dealer-hand" }),
    ]);

    const seats = el("section", { class: "bj-seats", id: "bj-seats" });

    const felt = el("div", { class: "bj-felt" }, [
      el("div", { class: "bj-felt__head" }, [phasePill, rulePill]),
      dealer,
      el("div", { class: "bj-felt__divider", "aria-hidden": "true" }),
      seats,
    ]);

    const controls = el("section", { class: "bj-controls", id: "bj-controls" });

    clear(container).appendChild(el("div", { class: "bj-root rise-in" }, [felt, controls]));

    V.els = {
      phase: container.querySelector("#bj-phase"),
      rule: container.querySelector("#bj-rule"),
      dealerHand: container.querySelector("#bj-dealer-hand"),
      dealerValue: container.querySelector("#bj-dealer-value"),
      seats: container.querySelector("#bj-seats"),
      controls: container.querySelector("#bj-controls"),
    };
  }

  // =====================================================================
  // Server-wired actions
  // =====================================================================
  function curState() { return V.ctx.getState(); }
  function gameState() { const s = curState(); return s && s.game; }

  function act(payload, okMsg) {
    V.ctx.socket.gameAction(payload).then((res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || "Action rejected.", "error");
      } else if (okMsg) {
        toast(okMsg, "success");
      }
    });
  }

  function sit(seatIdx) {
    const payload = { type: "sit" };
    if (seatIdx != null) payload.seat = seatIdx;
    act(payload);
  }
  function leaveSeat() { act({ type: "leave" }); }
  function placeBet() {
    const me = V.ctx.getMyPlayer();
    const amt = V.chipValue;
    if (me && me.balance < amt) { toast("Not enough balance for a $" + amt + " bet.", "error"); return; }
    act({ type: "bet", amount: amt });
  }
  function deal() { act({ type: "deal" }); }
  function hit() { act({ type: "hit" }); }
  function stand() { act({ type: "stand" }); }
  function double() { act({ type: "double" }); }
  function split() { act({ type: "split" }); }

  function selectChip(v) {
    V.chipValue = v;
    const tray = V.els.controls.querySelector(".bj-chips");
    if (tray) tray.querySelectorAll(".bj-chip").forEach((c) => c.classList.toggle("selected", Number(c.dataset.val) === v));
  }

  // =====================================================================
  // Helpers: resolve player identity from the room players list
  // =====================================================================
  function nameForPid(pid) {
    const players = V.ctx.getPlayers() || [];
    const p = players.find((x) => x.id === pid);
    return p ? p.name : "Player";
  }
  function balanceForPid(pid) {
    const players = V.ctx.getPlayers() || [];
    const p = players.find((x) => x.id === pid);
    return p ? p.balance : null;
  }
  function myPid() { return V.ctx.persistentId; }

  // =====================================================================
  // Render from authoritative state
  // =====================================================================
  function renderState(g) {
    // Track which cards exist now, so we can fade in only the new ones and prune
    // the "seen" set when a round resets (no cards on the board anymore).
    const presentKeys = collectCardKeys(g);
    // Prune keys that no longer exist (new round) so a re-deal re-animates.
    for (const k of Array.from(V.seenCards)) {
      if (!presentKeys.has(k)) V.seenCards.delete(k);
    }

    const hasResults = g.results && Object.keys(g.results).length > 0;
    const inRound = g.phase === "playing" || g.phase === "dealer" || g.phase === "settle";

    // Phase label.
    let label;
    if (inRound) label = g.phase === "playing" ? "Round in play" : "Dealer plays";
    else if (hasResults) label = "Round over — place your bets";
    else label = "Place your bets";
    V.els.phase.textContent = label;
    V.els.phase.classList.toggle("is-active", inRound);

    V.els.rule.textContent = g.dealerStandsOnSoft17
      ? "Dealer stands on soft 17 · Blackjack pays 3:2"
      : "Dealer hits soft 17 · Blackjack pays 3:2";

    renderDealer(g);
    renderSeats(g);
    renderControls(g, hasResults);
  }

  function collectCardKeys(g) {
    const keys = new Set();
    (g.dealer.cards || []).forEach((c, i) => keys.add("d:" + i + ":" + c));
    (g.seats || []).forEach((seat) => {
      if (seat.empty) return;
      (seat.hands || []).forEach((h, hi) => {
        (h.cards || []).forEach((c, ci) => keys.add("s" + seat.seat + ":" + hi + ":" + ci + ":" + c));
      });
    });
    return keys;
  }

  // ---- Card rendering ----
  function cardNode(card, key) {
    const isNew = key && !V.seenCards.has(key);
    if (key) V.seenCards.add(key);

    if (card === "??") {
      const back = el("div", { class: "bj-card bj-card--back" + (isNew ? " bj-card--deal" : "") },
        el("div", { class: "bj-card__pattern", "aria-hidden": "true" }));
      return back;
    }
    const rank = card[0];
    const suit = card[1];
    const meta = SUIT[suit] || { glyph: "?", red: false };
    const rankLabel = RANK_LABEL[rank] || rank;
    const node = el("div", {
      class: "bj-card" + (meta.red ? " bj-card--red" : " bj-card--dark") + (isNew ? " bj-card--deal" : ""),
      "aria-label": rankLabel + " of " + suit,
    }, [
      el("span", { class: "bj-card__corner bj-card__corner--tl" }, [
        el("span", { class: "bj-card__rank" }, rankLabel),
        el("span", { class: "bj-card__suit" }, meta.glyph),
      ]),
      el("span", { class: "bj-card__pip", "aria-hidden": "true" }, meta.glyph),
      el("span", { class: "bj-card__corner bj-card__corner--br" }, [
        el("span", { class: "bj-card__rank" }, rankLabel),
        el("span", { class: "bj-card__suit" }, meta.glyph),
      ]),
    ]);
    return node;
  }

  function renderHandCards(container, cards, keyPrefix) {
    clear(container);
    (cards || []).forEach((c, i) => {
      container.appendChild(cardNode(c, keyPrefix + ":" + i + ":" + c));
    });
  }

  // ---- Dealer ----
  function renderDealer(g) {
    renderHandCards(V.els.dealerHand, g.dealer.cards, "d");
    const v = g.dealer.value;
    if (v == null) {
      // Hide value while the hole card is down; show a subtle hint if upcard only.
      V.els.dealerValue.textContent = (g.dealer.cards && g.dealer.cards.length) ? "?" : "";
      V.els.dealerValue.classList.remove("is-bust");
    } else {
      V.els.dealerValue.textContent = String(v);
      V.els.dealerValue.classList.toggle("is-bust", v > 21);
    }
  }

  // ---- Seats ----
  function renderSeats(g) {
    clear(V.els.seats);
    const mineSeated = g.yourSeat != null;
    (g.seats || []).forEach((seat) => {
      V.els.seats.appendChild(seat.empty ? emptySeatNode(seat, g, mineSeated) : filledSeatNode(seat, g));
    });
  }

  function emptySeatNode(seat, g, mineSeated) {
    const canSit = !mineSeated && g.phase === "betting";
    const node = el("div", { class: "bj-seat bj-seat--empty" }, [
      el("div", { class: "bj-seat__label caption" }, "Seat " + (seat.seat + 1)),
      canSit
        ? el("button", { class: "btn btn-secondary btn--sm bj-sit", onclick: () => sit(seat.seat) }, "Take a seat")
        : el("div", { class: "bj-seat__open caption" }, "Open"),
    ]);
    return node;
  }

  function statusBadge(status) {
    const map = {
      blackjack: { txt: "Blackjack", cls: "is-bj" },
      bust: { txt: "Bust", cls: "is-bust" },
      stand: { txt: "Stand", cls: "is-stand" },
      playing: { txt: "", cls: "" },
    };
    const m = map[status] || { txt: status, cls: "" };
    if (!m.txt) return null;
    return el("span", { class: "bj-badge " + m.cls }, m.txt);
  }

  function resultLine(result) {
    if (!result) return null;
    // result = { net, hands:[{outcome,payout,bet}] }
    const net = result.net;
    const kind = net > 0 ? "win" : (net < 0 ? "lose" : "push");
    const label = net > 0 ? "Won " + money(net) : (net < 0 ? "Lost " + money(-net) : "Push");
    const outcomes = (result.hands || []).map((h) => h.outcome);
    const tag = outcomes.includes("blackjack") ? "Blackjack! " : "";
    return el("div", { class: "bj-result bj-result--" + kind }, tag + label);
  }

  function filledSeatNode(seat, g) {
    const isMe = seat.you;
    const name = nameForPid(seat.pid);
    const bal = balanceForPid(seat.pid);
    const seatIsTurn = g.phase === "playing" && g.turn && g.turn.seat === seat.seat;

    const head = el("div", { class: "bj-seat__head" }, [
      el("span", { class: "bj-seat__name" }, [
        name,
        isMe ? el("span", { class: "bj-seat__you" }, "you") : null,
      ]),
      bal != null ? el("span", { class: "bj-seat__bal" }, money(bal)) : null,
    ]);

    const hands = el("div", { class: "bj-hands" });
    if (seat.hands && seat.hands.length) {
      seat.hands.forEach((h, hi) => hands.appendChild(handNode(seat, h, hi)));
    } else {
      // Betting phase (or sitting out): show the pending bet, if any.
      hands.appendChild(el("div", { class: "bj-hand-empty caption" },
        seat.bet > 0 ? "Bet " + money(seat.bet) + " · waiting to deal" : "No bet yet"));
    }

    const result = seat.result ? resultLine(seat.result) : null;

    const node = el("div", {
      class: "bj-seat bj-seat--filled"
        + (isMe ? " bj-seat--me" : "")
        + (seatIsTurn ? " bj-seat--turn" : ""),
    }, [head, hands, result]);
    return node;
  }

  function handNode(seat, h, hi) {
    const cards = el("div", { class: "bj-hand" });
    renderHandCards(cards, h.cards, "s" + seat.seat + ":" + hi);

    const valueTxt = h.value != null ? String(h.value) : "";
    const softTxt = h.soft && h.value <= 21 ? " soft" : "";
    const meta = el("div", { class: "bj-hand__meta" }, [
      el("span", { class: "bj-value pill" + (h.value > 21 ? " is-bust" : "") }, valueTxt + softTxt),
      h.bet ? el("span", { class: "bj-hand__bet pill" }, money(h.bet)) : null,
      h.doubled ? el("span", { class: "bj-badge is-stand" }, "Doubled") : null,
      h.isSplit ? el("span", { class: "bj-badge" }, "Split") : null,
      statusBadge(h.status),
    ]);

    return el("div", {
      class: "bj-hand-wrap" + (h.isTurn ? " bj-hand-wrap--turn" : ""),
    }, [cards, meta]);
  }

  // =====================================================================
  // Controls — depend on phase + whether you're seated + whose turn
  // =====================================================================
  function renderControls(g, hasResults) {
    const box = V.els.controls;
    clear(box);

    const seated = g.yourSeat != null;
    const mySeat = seated ? g.seats[g.yourSeat] : null;
    const me = V.ctx.getMyPlayer();
    const myBalance = me ? me.balance : 0;

    // ---- Not seated: offer to sit (if a seat is open + betting phase) ----
    if (!seated) {
      const anyOpen = (g.seats || []).some((s) => s.empty);
      const msg = g.phase === "betting"
        ? (anyOpen ? "Take a seat to join the next deal." : "Table is full — watching this round.")
        : "A round is in play. You can sit when betting reopens.";
      box.appendChild(el("div", { class: "bj-controls__row" }, [
        el("p", { class: "bj-controls__hint caption" }, msg),
        (g.phase === "betting" && anyOpen)
          ? el("button", { class: "btn btn-primary", onclick: () => sit(null) }, "Take a seat")
          : null,
      ]));
      return;
    }

    // ---- Seated, betting phase: chip selector + Bet + Deal + Leave ----
    if (g.phase === "betting") {
      const tray = el("div", { class: "bj-chips" });
      CHIP_VALUES.forEach((v) => {
        tray.appendChild(el("button", {
          class: "bj-chip chip-" + v + (v === V.chipValue ? " selected" : "") + (v > myBalance ? " is-poor" : ""),
          dataset: { val: String(v) },
          title: "$" + v + " chip",
          onclick: () => selectChip(v),
        }, String(v)));
      });

      const pendingBet = mySeat && mySeat.bet > 0 ? mySeat.bet : 0;
      const betLabel = pendingBet > 0 ? "Bet " + money(V.chipValue) + " (replaces)" : "Bet " + money(V.chipValue);

      const row = el("div", { class: "bj-controls__row" }, [
        el("div", { class: "bj-controls__bet" }, [
          el("span", { class: "bj-controls__hint caption" },
            pendingBet > 0 ? "Your bet: " + money(pendingBet) : "Select a chip, then Bet."),
          tray,
        ]),
        el("div", { class: "bj-controls__buttons" }, [
          el("button", { class: "btn btn-secondary", disabled: V.chipValue > myBalance, onclick: placeBet }, betLabel),
          el("button", { class: "btn btn-primary", disabled: !(pendingBet > 0), onclick: deal, title: pendingBet > 0 ? "Deal the round" : "Place a bet first" }, "Deal"),
          el("button", { class: "btn btn-ghost btn--sm", onclick: leaveSeat }, "Leave seat"),
        ]),
      ]);
      box.appendChild(row);
      return;
    }

    // ---- Seated, round in play: action buttons when it's my turn ----
    const myTurn = g.phase === "playing" && g.turn && g.turn.seat === g.yourSeat;
    const turnHand = myTurn && mySeat ? mySeat.hands[g.turn.hand] : null;

    let hint;
    if (myTurn) hint = "Your turn — choose an action.";
    else if (g.phase === "playing") hint = "Waiting for " + nameForPid(g.seats[g.turn.seat].pid) + " to act…";
    else hint = "Dealer is playing the hand…";

    const buttons = el("div", { class: "bj-controls__buttons" });
    if (myTurn && turnHand) {
      const twoCards = turnHand.cards.length === 2;
      const canDouble = twoCards && myBalance >= turnHand.bet;
      // Split legal when first two cards share rank-value and not already split.
      const canSplit = twoCards && !turnHand.isSplit && (mySeat.hands.length === 1) &&
        sameRankValue(turnHand.cards[0], turnHand.cards[1]) && myBalance >= turnHand.bet;

      buttons.appendChild(el("button", { class: "btn btn-primary", onclick: hit }, "Hit"));
      buttons.appendChild(el("button", { class: "btn btn-secondary", onclick: stand }, "Stand"));
      buttons.appendChild(el("button", {
        class: "btn btn-secondary", disabled: !canDouble, onclick: double,
        title: twoCards ? (canDouble ? "Double your bet, take one card" : "Not enough balance to double") : "Double only on first two cards",
      }, "Double"));
      buttons.appendChild(el("button", {
        class: "btn btn-secondary", disabled: !canSplit, onclick: split,
        title: canSplit ? "Split your pair" : "Split needs a matching pair on the first two cards",
      }, "Split"));
    }

    box.appendChild(el("div", { class: "bj-controls__row" }, [
      el("p", { class: "bj-controls__hint caption" + (myTurn ? " is-turn" : "") }, hint),
      buttons,
    ]));
  }

  function rankValueOf(card) {
    const r = card[0];
    if (r === "A") return 11;
    if (r === "K" || r === "Q" || r === "J" || r === "T") return 10;
    return parseInt(r, 10);
  }
  function sameRankValue(a, b) {
    return a && b && rankValueOf(a) === rankValueOf(b);
  }
})();
