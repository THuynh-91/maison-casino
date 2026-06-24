/*
 * games/poker.js — multiplayer No-Limit Texas Hold'em view (up to 6 seats).
 *
 * Registers itself as window.CasinoGames.poker = { mount, update, unmount } so
 * the app.js game router can mount/update/unmount it exactly like blackjack.
 *
 * SERVER-AUTHORITATIVE: all money + game logic live on the backend
 * (backend/games/poker-engine.js). This view reads the per-viewer public state
 * from roomState.game and emits actions via ctx.socket.gameAction:
 *
 *   {type:"sit", seat?}, {type:"leave"}, {type:"startHand"},
 *   {type:"fold"}, {type:"check"}, {type:"call"},
 *   {type:"bet", amount}, {type:"raise", amount}, {type:"allin"}
 *
 * AMOUNT CONVENTION (verified in poker-engine.js):
 *   For bet/raise, `amount` is the NEW TOTAL wager for THIS betting round
 *   ("raise to X"), not the additional chips. The minimum legal total is
 *   state.minRaiseTo. A plain bet (currentBet === 0) must be >= bigBlind.
 *   Our raise/bet slider is therefore bounded [minRaiseTo, seat.bet + stack].
 *
 * Public state (getPublicState), see engine:
 *   { gameId:"poker", phase:"waiting"|"preflop"|"flop"|"turn"|"river"|"showdown",
 *     maxSeats:6, smallBlind, bigBlind, board:[...], pot, currentBet, minRaise,
 *     minRaiseTo, button, turn, toCall, yourSeat,
 *     seats:[ {seat,empty:true} | {seat,empty:false,pid,you,stack,bet,committed,
 *              folded,allin,inHand,hasCards,isButton,isTurn,holeCards} ],
 *     lastResult:{ type, board, pot, pots, winners:[{pid,seat,amount,hand}],
 *                  revealed:[{pid,seat,holeCards,hand:{rank,name,tiebreak}}] }|null }
 *
 * Other players' holeCards are ALWAYS null mid-hand; we render face-down backs
 * when hasCards. Opponent cards only appear via lastResult.revealed at showdown.
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

  // Seat anchor positions around the oval felt (percent of the table box).
  // Index 0 is bottom-center (closest to the viewer); the rest fan around.
  const SEAT_ANCHORS = [
    { x: 50, y: 92 },  // 0 bottom center
    { x: 11, y: 70 },  // 1 lower left
    { x: 7,  y: 28 },  // 2 upper left
    { x: 50, y: 8 },   // 3 top center
    { x: 93, y: 28 },  // 4 upper right
    { x: 89, y: 70 },  // 5 lower right
  ];

  // ---- View instance state (rebuilt each mount) ----
  let V = null;

  function freshView() {
    return {
      ctx: null,
      root: null,
      els: {},
      raiseTo: null,        // sticky raise amount across re-renders while my turn
      raiseTurnKey: null,   // identifies the betting situation the raiseTo belongs to
      // remembers which card DOM keys we've already shown so newly-dealt cards
      // animate in (and previously-seen ones don't re-animate on each push).
      seenCards: new Set(),
    };
  }

  // ---- public API ------------------------------------------------------
  const Poker = {
    mount(container, ctx) {
      V = freshView();
      V.ctx = ctx;
      V.root = container;
      buildDOM(container);
      this.update(ctx.getState());
    },

    update(roomState) {
      if (!V || !roomState || roomState.gameId !== "poker") return;
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
  window.CasinoGames.poker = Poker;

  // =====================================================================
  // DOM scaffold
  // =====================================================================
  function buildDOM(container) {
    const phasePill = el("div", { class: "pk-phase pill", id: "pk-phase" }, "Poker");
    const rulePill = el("span", { class: "pk-rule caption", id: "pk-rule" }, "");

    const board = el("div", { class: "pk-board", id: "pk-board" });
    const pot = el("div", { class: "pk-pot", id: "pk-pot" }, [
      el("span", { class: "pk-pot__label" }, "Pot"),
      el("strong", { class: "pk-pot__val", id: "pk-pot-val" }, money(0)),
    ]);
    const center = el("div", { class: "pk-center" }, [pot, board]);

    const seats = el("div", { class: "pk-seats", id: "pk-seats" });

    const table = el("div", { class: "pk-table" }, [
      el("div", { class: "pk-table__rail", "aria-hidden": "true" }),
      el("div", { class: "pk-table__felt" }, [center]),
      seats,
    ]);

    const felt = el("div", { class: "pk-felt" }, [
      el("div", { class: "pk-felt__head" }, [phasePill, rulePill]),
      table,
    ]);

    const result = el("section", { class: "pk-result", id: "pk-result", hidden: true });
    const controls = el("section", { class: "pk-controls", id: "pk-controls" });

    clear(container).appendChild(el("div", { class: "pk-root rise-in" }, [felt, result, controls]));

    V.els = {
      phase: container.querySelector("#pk-phase"),
      rule: container.querySelector("#pk-rule"),
      board: container.querySelector("#pk-board"),
      potVal: container.querySelector("#pk-pot-val"),
      seats: container.querySelector("#pk-seats"),
      result: container.querySelector("#pk-result"),
      controls: container.querySelector("#pk-controls"),
    };
  }

  // =====================================================================
  // Server-wired actions
  // =====================================================================
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
  function startHand() { act({ type: "startHand" }); }
  function fold() { act({ type: "fold" }); }
  function check() { act({ type: "check" }); }
  function call() { act({ type: "call" }); }
  function bet(amount) { act({ type: "bet", amount }); }
  function raise(amount) { act({ type: "raise", amount }); }
  function allin() { act({ type: "allin" }); }

  // =====================================================================
  // Helpers: resolve player identity from the room players list
  // =====================================================================
  function nameForPid(pid) {
    const players = V.ctx.getPlayers() || [];
    const p = players.find((x) => x.id === pid);
    return p ? p.name : "Player";
  }

  // =====================================================================
  // Render from authoritative state
  // =====================================================================
  const PHASE_LABEL = {
    waiting: "Waiting",
    preflop: "Pre-flop",
    flop: "Flop",
    turn: "Turn",
    river: "River",
    showdown: "Showdown",
  };

  function renderState(g) {
    // Track which cards exist now so only newly-dealt cards animate in. Prune
    // keys that no longer exist (a new hand) so a re-deal re-animates.
    const presentKeys = collectCardKeys(g);
    for (const k of Array.from(V.seenCards)) {
      if (!presentKeys.has(k)) V.seenCards.delete(k);
    }

    const inHand = g.phase !== "waiting";
    V.els.phase.textContent = PHASE_LABEL[g.phase] || g.phase;
    V.els.phase.classList.toggle("is-active", inHand && g.phase !== "showdown");

    V.els.rule.textContent =
      "No-Limit Hold'em · Blinds " + money(g.smallBlind) + " / " + money(g.bigBlind);

    V.els.potVal.textContent = money(g.pot);

    renderBoard(g);
    renderSeats(g);
    renderResult(g);
    renderControls(g);
  }

  function collectCardKeys(g) {
    const keys = new Set();
    (g.board || []).forEach((c, i) => keys.add("b:" + i + ":" + c));
    (g.seats || []).forEach((seat) => {
      if (seat.empty) return;
      if (seat.holeCards) {
        seat.holeCards.forEach((c, ci) => keys.add("h" + seat.seat + ":" + ci + ":" + c));
      } else if (seat.hasCards) {
        keys.add("h" + seat.seat + ":back");
      }
    });
    return keys;
  }

  // ---- Card rendering ----
  function cardNode(card, key, opts) {
    opts = opts || {};
    const isNew = key && !V.seenCards.has(key);
    if (key) V.seenCards.add(key);
    const small = opts.small ? " pk-card--sm" : "";

    if (card == null) {
      // Face-down back.
      return el("div", { class: "pk-card pk-card--back" + small + (isNew ? " pk-card--deal" : "") },
        el("div", { class: "pk-card__pattern", "aria-hidden": "true" }));
    }
    const rank = card[0];
    const suit = card[1];
    const meta = SUIT[suit] || { glyph: "?", red: false };
    const rankLabel = RANK_LABEL[rank] || rank;
    return el("div", {
      class: "pk-card" + (meta.red ? " pk-card--red" : " pk-card--dark") + small + (isNew ? " pk-card--deal" : ""),
      "aria-label": rankLabel + " of " + suit,
    }, [
      el("span", { class: "pk-card__corner pk-card__corner--tl" }, [
        el("span", { class: "pk-card__rank" }, rankLabel),
        el("span", { class: "pk-card__suit" }, meta.glyph),
      ]),
      el("span", { class: "pk-card__pip", "aria-hidden": "true" }, meta.glyph),
      el("span", { class: "pk-card__corner pk-card__corner--br" }, [
        el("span", { class: "pk-card__rank" }, rankLabel),
        el("span", { class: "pk-card__suit" }, meta.glyph),
      ]),
    ]);
  }

  // ---- Community board ----
  function renderBoard(g) {
    clear(V.els.board);
    const board = g.board || [];
    // Render up to 5 slots: filled with revealed cards, the rest as placeholders.
    for (let i = 0; i < 5; i++) {
      if (i < board.length) {
        V.els.board.appendChild(cardNode(board[i], "b:" + i + ":" + board[i]));
      } else {
        V.els.board.appendChild(el("div", { class: "pk-card pk-card--slot", "aria-hidden": "true" }));
      }
    }
  }

  // ---- Seats ----
  function renderSeats(g) {
    clear(V.els.seats);
    const mineSeated = g.yourSeat != null;
    (g.seats || []).forEach((seat) => {
      const anchor = SEAT_ANCHORS[seat.seat] || { x: 50, y: 50 };
      const node = seat.empty
        ? emptySeatNode(seat, g, mineSeated)
        : filledSeatNode(seat, g);
      node.style.left = anchor.x + "%";
      node.style.top = anchor.y + "%";
      V.els.seats.appendChild(node);
    });
  }

  function emptySeatNode(seat, g, mineSeated) {
    const canSit = !mineSeated;
    return el("div", { class: "pk-seat pk-seat--empty" }, [
      el("div", { class: "pk-seat__plate" }, [
        canSit
          ? el("button", { class: "btn btn-secondary btn--sm pk-sit", onclick: () => sit(seat.seat) }, "Take a seat")
          : el("span", { class: "pk-seat__open caption" }, "Seat " + (seat.seat + 1)),
      ]),
    ]);
  }

  function filledSeatNode(seat, g) {
    const isMe = seat.you;
    const name = nameForPid(seat.pid);
    const isTurn = seat.isTurn && g.phase !== "showdown";
    const dimmed = seat.folded;

    // Hole cards: your own face-up; others face-down backs when they have cards.
    // At showdown, reveal from lastResult for non-folded players who showed.
    const cards = el("div", { class: "pk-seat__cards" });
    const revealed = revealedFor(g, seat.seat);
    if (seat.holeCards && seat.holeCards.length) {
      seat.holeCards.forEach((c, i) => cards.appendChild(cardNode(c, "h" + seat.seat + ":" + i + ":" + c, { small: true })));
    } else if (revealed && revealed.holeCards) {
      revealed.holeCards.forEach((c, i) => cards.appendChild(cardNode(c, "r" + seat.seat + ":" + i + ":" + c, { small: true })));
    } else if (seat.hasCards) {
      cards.appendChild(cardNode(null, "h" + seat.seat + ":back", { small: true }));
      cards.appendChild(cardNode(null, "h" + seat.seat + ":back2", { small: true }));
    }

    const badges = el("div", { class: "pk-seat__badges" });
    if (seat.isButton) badges.appendChild(el("span", { class: "pk-dealer-btn", title: "Dealer button" }, "D"));
    if (seat.allin) badges.appendChild(el("span", { class: "pk-badge is-allin" }, "All-in"));
    if (seat.folded) badges.appendChild(el("span", { class: "pk-badge is-fold" }, "Folded"));

    // Winning-hand label at showdown.
    const win = winnerFor(g, seat.seat);
    let handLabel = null;
    if (g.phase === "showdown" || (g.lastResult && g.phase === "waiting")) {
      if (revealed && revealed.hand && revealed.hand.name) {
        handLabel = el("div", { class: "pk-seat__hand caption" }, revealed.hand.name);
      }
    }

    const head = el("div", { class: "pk-seat__head" }, [
      el("span", { class: "pk-seat__name" }, [
        name,
        isMe ? el("span", { class: "pk-seat__you" }, "you") : null,
      ]),
      el("span", { class: "pk-seat__stack" }, money(seat.stack)),
    ]);

    const node = el("div", {
      class: "pk-seat pk-seat--filled"
        + (isMe ? " pk-seat--me" : "")
        + (isTurn ? " pk-seat--turn" : "")
        + (dimmed ? " pk-seat--folded" : "")
        + (win ? " pk-seat--winner" : ""),
    }, [
      isTurn ? el("span", { class: "pk-turn-ring", "aria-hidden": "true" }) : null,
      cards,
      el("div", { class: "pk-seat__plate" }, [head, badges, handLabel]),
      // Current-round bet chip near the table.
      seat.bet > 0
        ? el("div", { class: "pk-bet-chip", title: "Bet this round" }, [
            el("span", { class: "pk-bet-chip__disc", "aria-hidden": "true" }),
            el("span", { class: "pk-bet-chip__amt" }, money(seat.bet)),
          ])
        : null,
      win ? el("div", { class: "pk-seat__won" }, "+" + money(win.amount)) : null,
    ]);
    return node;
  }

  function revealedFor(g, seatIdx) {
    const lr = g.lastResult;
    if (!lr || !lr.revealed) return null;
    return lr.revealed.find((r) => r.seat === seatIdx) || null;
  }
  function winnerFor(g, seatIdx) {
    const lr = g.lastResult;
    if (!lr || !lr.winners) return null;
    return lr.winners.find((w) => w.seat === seatIdx && w.amount > 0) || null;
  }

  // ---- Result panel (after a hand) ----
  function renderResult(g) {
    const lr = g.lastResult;
    const box = V.els.result;
    // Only show between hands (waiting) or at showdown.
    if (!lr || (g.phase !== "waiting" && g.phase !== "showdown")) {
      box.hidden = true;
      clear(box);
      return;
    }
    clear(box);
    box.hidden = false;

    const isFold = lr.type === "fold";
    const head = el("div", { class: "pk-result__head" }, [
      el("span", { class: "pk-result__title" }, isFold ? "Hand over" : "Showdown"),
      el("span", { class: "pk-result__pot pill" }, "Pot " + money(lr.pot)),
    ]);

    const lines = el("div", { class: "pk-result__lines" });
    (lr.winners || []).forEach((w) => {
      if (!(w.amount > 0)) return;
      const handName = w.hand && w.hand.name ? " with " + w.hand.name : "";
      lines.appendChild(el("div", { class: "pk-result__win" }, [
        el("strong", {}, nameForPid(w.pid)),
        " won " + money(w.amount) + (isFold ? " (all folded)" : handName),
      ]));
    });

    // Multiple pots breakdown (side pots), if present and more than one.
    if (lr.pots && lr.pots.length > 1) {
      const pl = el("div", { class: "pk-result__pots caption" });
      lr.pots.forEach((p, i) => {
        const label = i === 0 ? "Main pot" : "Side pot " + i;
        const who = (p.winners || []).map(nameForPid).join(", ");
        pl.appendChild(el("div", {}, label + " " + money(p.amount) + " → " + who));
      });
      lines.appendChild(pl);
    }

    box.appendChild(head);
    box.appendChild(lines);
  }

  // =====================================================================
  // Controls — phase + turn aware
  // =====================================================================
  function renderControls(g) {
    const box = V.els.controls;
    clear(box);

    const seated = g.yourSeat != null;
    const mySeat = seated ? g.seats[g.yourSeat] : null;
    const me = V.ctx.getMyPlayer();
    const myStack = mySeat ? mySeat.stack : (me ? me.balance : 0);

    // ---- Not seated ----
    if (!seated) {
      const anyOpen = (g.seats || []).some((s) => s.empty);
      const msg = anyOpen
        ? "Take an open seat to join the next hand."
        : "Table is full — watching this hand.";
      box.appendChild(el("div", { class: "pk-controls__row" }, [
        el("p", { class: "pk-controls__hint caption" }, msg),
        anyOpen ? el("button", { class: "btn btn-primary", onclick: () => sit(null) }, "Take a seat") : null,
      ]));
      return;
    }

    // ---- Seated, waiting between hands ----
    if (g.phase === "waiting") {
      const seatedCount = (g.seats || []).filter((s) => !s.empty).length;
      const fundedCount = (g.seats || []).filter((s) => !s.empty && s.stack > 0).length;
      const canStart = fundedCount >= 2;
      const hint = canStart
        ? "Ready when you are — start the next hand."
        : "Waiting for at least 2 funded players (" + seatedCount + " seated).";
      box.appendChild(el("div", { class: "pk-controls__row" }, [
        el("p", { class: "pk-controls__hint caption" }, hint),
        el("div", { class: "pk-controls__buttons" }, [
          el("button", {
            class: "btn btn-primary", disabled: !canStart, onclick: startHand,
            title: canStart ? "Deal the next hand" : "Need 2+ players with chips",
          }, "Start hand"),
          el("button", { class: "btn btn-ghost btn--sm", onclick: leaveSeat }, "Leave"),
        ]),
      ]));
      return;
    }

    // ---- Seated, hand in play ----
    const myTurn = g.phase !== "showdown" && mySeat && mySeat.isTurn;
    const toCall = g.toCall || 0;

    // Betting-situation key so the raise slider resets when the situation changes
    // (new street, new current bet) but persists across innocuous re-renders.
    const turnKey = g.phase + ":" + g.currentBet + ":" + (mySeat ? mySeat.bet : 0);

    if (!myTurn) {
      let hint;
      if (g.phase === "showdown") hint = "Showdown — revealing hands…";
      else if (g.turn != null && g.turn >= 0 && g.seats[g.turn] && !g.seats[g.turn].empty) {
        hint = "Waiting for " + nameForPid(g.seats[g.turn].pid) + " to act…";
      } else hint = "Hand in progress…";
      box.appendChild(el("div", { class: "pk-controls__row" }, [
        el("p", { class: "pk-controls__hint caption" }, hint),
        betInfo(g, toCall),
      ]));
      return;
    }

    // It's my turn — build action buttons.
    const maxTotal = mySeat.bet + myStack; // most I can have in front this round
    const facingBet = g.currentBet > 0 && toCall > 0;

    const buttons = el("div", { class: "pk-controls__buttons" });

    // Fold
    buttons.appendChild(el("button", { class: "btn btn-ghost", onclick: fold }, "Fold"));

    // Check or Call
    if (toCall <= 0) {
      buttons.appendChild(el("button", { class: "btn btn-secondary", onclick: check }, "Check"));
    } else {
      const callAmt = Math.min(toCall, myStack);
      buttons.appendChild(el("button", {
        class: "btn btn-secondary", onclick: call,
        title: callAmt < toCall ? "Call all-in for " + money(callAmt) : "Call " + money(toCall),
      }, "Call " + money(callAmt)));
    }

    // Bet / Raise control — only if I have chips beyond a flat call.
    const minTo = g.minRaiseTo;
    const canAggress = myStack > 0 && maxTotal > g.currentBet && maxTotal >= Math.min(minTo, maxTotal);
    if (canAggress) {
      // Sticky raise amount, clamped to [minTo, maxTotal].
      const lo = Math.min(minTo, maxTotal);
      const hi = maxTotal;
      if (V.raiseTurnKey !== turnKey || V.raiseTo == null) {
        V.raiseTo = lo;
        V.raiseTurnKey = turnKey;
      }
      V.raiseTo = Math.max(lo, Math.min(hi, V.raiseTo));

      const label = facingBet ? "Raise to" : "Bet";
      const slider = el("input", {
        class: "pk-slider", type: "range",
        min: String(lo), max: String(hi), step: String(g.bigBlind > 0 ? g.bigBlind : 1),
        value: String(V.raiseTo),
      });
      const amtInput = el("input", {
        class: "input pk-amt", type: "number",
        min: String(lo), max: String(hi), step: "1", value: String(V.raiseTo),
      });
      function setAmt(v) {
        v = Math.round(Number(v) || lo);
        v = Math.max(lo, Math.min(hi, v));
        V.raiseTo = v;
        slider.value = String(v);
        amtInput.value = String(v);
      }
      slider.addEventListener("input", () => setAmt(slider.value));
      amtInput.addEventListener("input", () => setAmt(amtInput.value));

      const aggressBtn = el("button", {
        class: "btn btn-primary",
        onclick: () => {
          const amt = V.raiseTo;
          if (facingBet) raise(amt);
          else bet(amt);
        },
      }, [label, " ", el("span", { class: "pk-amt-out" }, money(V.raiseTo))]);
      // keep button label in sync
      const syncLabel = () => { aggressBtn.querySelector(".pk-amt-out").textContent = money(V.raiseTo); };
      slider.addEventListener("input", syncLabel);
      amtInput.addEventListener("input", syncLabel);

      const stepBtns = el("div", { class: "pk-step" }, [
        el("button", { class: "btn btn-ghost btn--sm", onclick: () => { setAmt(V.raiseTo - g.bigBlind); syncLabel(); }, title: "Down a big blind" }, "−"),
        el("button", { class: "btn btn-ghost btn--sm", onclick: () => { setAmt(V.raiseTo + g.bigBlind); syncLabel(); }, title: "Up a big blind" }, "+"),
      ]);

      buttons.appendChild(el("div", { class: "pk-raise" }, [
        el("div", { class: "pk-raise__row" }, [stepBtns, amtInput, aggressBtn]),
        slider,
      ]));
    }

    // All-in (always available on my turn if I have chips).
    if (myStack > 0) {
      buttons.appendChild(el("button", {
        class: "btn btn-secondary pk-allin", onclick: allin,
        title: "Push your whole stack (" + money(myStack) + ")",
      }, "All-in"));
    }

    box.appendChild(el("div", { class: "pk-controls__row" }, [
      el("div", { class: "pk-controls__lead" }, [
        el("p", { class: "pk-controls__hint caption is-turn" }, "Your turn"),
        betInfo(g, toCall),
      ]),
      buttons,
    ]));
  }

  function betInfo(g, toCall) {
    const parts = [];
    parts.push(chipFact("Pot", money(g.pot)));
    if (g.currentBet > 0) parts.push(chipFact("Current bet", money(g.currentBet)));
    if (toCall > 0) parts.push(chipFact("To call", money(toCall)));
    if (g.phase !== "showdown" && g.phase !== "waiting") {
      parts.push(chipFact(g.currentBet > 0 ? "Min raise to" : "Min bet", money(g.currentBet > 0 ? g.minRaiseTo : g.bigBlind)));
    }
    return el("div", { class: "pk-facts" }, parts);
  }
  function chipFact(label, val) {
    return el("span", { class: "pk-fact" }, [
      el("span", { class: "pk-fact__label" }, label),
      el("span", { class: "pk-fact__val" }, val),
    ]);
  }
})();
