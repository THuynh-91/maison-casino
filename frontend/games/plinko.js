/*
 * games/plinko.js — multiplayer Plinko view.
 *
 * Registers itself as window.CasinoGames.plinko = { mount, update, unmount }
 * (EXACT same shape as games/roulette.js, picked up by app.js's game router).
 *
 * What it does:
 *   - Draws a real triangular peg field on a <canvas>: row r has r+1 pegs,
 *     centered, with state.rows rows -> rows+1 bottom multiplier slots. Slot
 *     labels (the multiplier row) live in the DOM below the canvas and are
 *     color-scaled by magnitude (edges hot = coral/amber, middle muted).
 *   - Bet selector (positive int, capped to balance) + risk selector
 *     (low/medium/high, redraws multipliers from multipliersByRisk) + DROP.
 *   - DROP is SERVER-AUTHORITATIVE: clicking DROP emits game:action
 *     {type:"drop", bet, risk}. The server decides the path & slot; we detect a
 *     new lastDrop via lastDrop.at and animate the ball falling EXACTLY along
 *     lastDrop.path ("L"/"R" per row) so it lands in lastDrop.slot. We never
 *     roll our own RNG. Reduced-motion snaps the ball to the slot instantly.
 *   - Balance is read from the room player list (ctx.getMyPlayer), never tracked
 *     locally. Errors are toasted. A small shared recentWins feed shows action.
 *
 * Backend public state (plinko-engine.js getPublicState):
 *   { gameId:"plinko", rows, risk, risks, multipliers, multipliersByRisk,
 *     lastDrop:{ path, slot, multiplier, bet, payout, risk, at }|null,
 *     recentWins:[{ name, slot, multiplier, payout, bet, risk, at }] }
 */
(function () {
  "use strict";

  const { el, clear, toast, money } = window.UI;

  // ---- Self-load our stylesheet if the host page didn't include it. --------
  // (index.html lists each game's CSS via <link>; if plinko.css is absent we
  // inject it so the view is styled regardless of how this script got loaded.)
  (function ensureCss() {
    const href = "/games/plinko.css";
    const has = Array.from(document.styleSheets).some(
      (s) => s.href && s.href.indexOf(href) !== -1
    );
    const linked = document.querySelector('link[href="' + href + '"]');
    if (!has && !linked) {
      document.head.appendChild(el("link", { rel: "stylesheet", href }));
    }
  })();

  const QUICK_BETS = [10, 50, 100, 500];

  // ---- View instance state (rebuilt each mount) ----
  let V = null;

  function freshView() {
    return {
      ctx: null,
      root: null,
      bet: 10,
      risk: "medium",
      rows: 12,
      multipliers: [],
      multipliersByRisk: null,
      // canvas
      canvas: null,
      c2d: null,
      cssW: 0,
      cssH: 0,
      dpr: 1,
      pegs: [],          // [{x,y}] in CSS px, flattened, with rowStart offsets
      pegRows: [],       // [[{x,y}...] per row]
      slotCenters: [],   // x center per slot (rows+1)
      topY: 0,
      bottomY: 0,
      pegGapX: 0,
      pegGapY: 0,
      ballRadius: 6,
      // animation
      animatedAt: null,  // lastDrop.at we've already animated
      animating: false,
      ball: null,        // {x,y} current draw position
      raf: null,
      resizeHandler: null,
      els: {},
    };
  }

  // ---- public API (identical shape to roulette.js) ---------------------
  const Plinko = {
    mount(container, ctx) {
      V = freshView();
      V.ctx = ctx;
      V.root = container;

      // seed risk/rows from current state so the first paint matches the server
      const s = ctx.getState();
      const g = s && s.game;
      if (g) {
        V.risk = g.risk || V.risk;
        V.rows = g.rows || V.rows;
        V.multipliers = (g.multipliers || []).slice();
        V.multipliersByRisk = g.multipliersByRisk || null;
      }

      buildDOM(container);
      setupCanvas();
      layoutBoard();
      drawBoard();

      V.resizeHandler = () => {
        setupCanvas();
        layoutBoard();
        if (!V.animating) drawBoard();
      };
      window.addEventListener("resize", V.resizeHandler);

      this.update(s);
    },

    update(roomState) {
      if (!V || !roomState || roomState.gameId !== "plinko") return;
      const g = roomState.game;
      if (!g) return;
      renderState(g);
    },

    unmount() {
      if (!V) return;
      if (V.resizeHandler) window.removeEventListener("resize", V.resizeHandler);
      if (V.raf) cancelAnimationFrame(V.raf);
      V = null;
    },
  };
  window.CasinoGames = window.CasinoGames || {};
  window.CasinoGames.plinko = Plinko;

  // =====================================================================
  // DOM scaffold
  // =====================================================================
  function buildDOM(container) {
    const canvas = el("canvas", { class: "pk-canvas", id: "pk-canvas" });
    const boardWrap = el("div", { class: "pk-board-wrap" }, [
      el("div", { class: "pk-board-glow", "aria-hidden": "true" }),
      canvas,
    ]);
    const slots = el("div", { class: "pk-slots", id: "pk-slots" });

    const boardSide = el("section", { class: "pk-board-side" }, [
      el("span", { class: "pill accent pk-eyebrow" }, "Drop the ball — the pegs decide"),
      boardWrap,
      slots,
    ]);

    // ---- controls panel ----
    const betInput = el("input", {
      class: "input",
      id: "pk-bet",
      type: "number",
      min: "1",
      step: "1",
      value: String(V.bet),
      inputmode: "numeric",
      autocomplete: "off",
    });
    betInput.addEventListener("input", () => {
      const n = parseInt(betInput.value, 10);
      if (Number.isFinite(n) && n > 0) V.bet = n;
    });
    betInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doDrop(); });

    const quick = el("div", { class: "pk-bet-quick" },
      QUICK_BETS.map((q) =>
        el("button", { class: "pk-quick", type: "button", onclick: () => setBet(q) }, "$" + q)
      ).concat([
        el("button", { class: "pk-quick", type: "button", title: "Bet half your balance", onclick: () => betFraction(0.5) }, "½"),
        el("button", { class: "pk-quick", type: "button", title: "Bet your whole balance", onclick: () => betFraction(1) }, "Max"),
      ])
    );

    const riskBtns = (V.ctx.getState()?.game?.risks || ["low", "medium", "high"]).map((r) =>
      el("button", {
        class: "pk-risk__btn" + (r === V.risk ? " is-active" : ""),
        type: "button",
        dataset: { risk: r },
        onclick: () => setRisk(r),
      }, r)
    );
    const riskCtl = el("div", { class: "pk-risk", id: "pk-risk", role: "group", "aria-label": "Risk level" }, riskBtns);

    const dropBtn = el("button", { class: "btn btn-primary pk-drop", id: "pk-drop", onclick: doDrop }, "DROP");

    const balanceLine = el("div", { class: "pk-balance-line" }, [
      el("span", {}, "Balance"),
      el("strong", { id: "pk-balance" }, "$0"),
    ]);

    const last = el("div", { class: "pk-last", id: "pk-last" });

    const controlPanel = el("div", { class: "pk-panel" }, [
      el("div", { class: "pk-field" }, [
        el("span", { class: "pk-field__label" }, "Bet"),
        el("div", { class: "pk-bet-row" }, [betInput]),
        quick,
      ]),
      el("div", { class: "pk-field" }, [
        el("span", { class: "pk-field__label" }, "Risk"),
        riskCtl,
      ]),
      dropBtn,
      balanceLine,
      last,
    ]);

    const feed = el("div", { class: "pk-feed", id: "pk-feed" });
    const feedPanel = el("div", { class: "pk-panel" }, [
      el("h4", { class: "panel__title" }, "Recent wins"),
      feed,
    ]);

    const controlsSide = el("aside", { class: "pk-controls-side" }, [controlPanel, feedPanel]);

    clear(container).appendChild(el("div", { class: "pk-root rise-in" }, [boardSide, controlsSide]));

    V.canvas = container.querySelector("#pk-canvas");
    V.els = {
      slots: container.querySelector("#pk-slots"),
      betInput,
      risk: container.querySelector("#pk-risk"),
      dropBtn,
      balance: container.querySelector("#pk-balance"),
      last,
      feed,
    };
  }

  function setBet(n) {
    V.bet = n;
    V.els.betInput.value = String(n);
  }
  function betFraction(f) {
    const me = V.ctx.getMyPlayer();
    const bal = me ? me.balance : 0;
    const n = Math.max(1, Math.floor(bal * f));
    setBet(n);
  }

  function setRisk(r) {
    if (V.risk === r) return;
    V.risk = r;
    V.els.risk.querySelectorAll(".pk-risk__btn").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.risk === r)
    );
    // update the displayed multipliers immediately from multipliersByRisk
    if (V.multipliersByRisk && V.multipliersByRisk[r]) {
      V.multipliers = V.multipliersByRisk[r].slice();
      renderSlots();
      drawBoard();
    }
  }

  // =====================================================================
  // Server-wired action
  // =====================================================================
  function doDrop() {
    if (V.animating) { toast("Ball still falling — hold on.", "info"); return; }
    const bet = parseInt(V.els.betInput.value, 10);
    if (!Number.isFinite(bet) || bet <= 0) { toast("Enter a positive bet.", "error"); return; }
    const me = V.ctx.getMyPlayer();
    if (me && me.balance < bet) { toast("Not enough balance for a $" + bet + " bet.", "error"); return; }
    V.bet = bet;
    V.els.dropBtn.disabled = true;
    V.ctx.socket.gameAction({ type: "drop", bet, risk: V.risk }).then((res) => {
      if (!res.ok) {
        V.els.dropBtn.disabled = false;
        toast(res.error || "Drop rejected.", "error");
      }
      // on success the room:state push triggers update() -> animation.
    });
  }

  // =====================================================================
  // Render from authoritative state
  // =====================================================================
  function renderState(g) {
    // keep config in sync with the server
    if (g.rows && g.rows !== V.rows) { V.rows = g.rows; layoutBoard(); }

    // The server reports the viewer's own last-used risk; mirror it into the UI
    // only when we are NOT mid-interaction differences — but the selector is the
    // source of truth for the *next* drop, so we just make sure multipliers map
    // to the currently selected risk.
    if (g.multipliersByRisk) V.multipliersByRisk = g.multipliersByRisk;
    if (V.multipliersByRisk && V.multipliersByRisk[V.risk]) {
      V.multipliers = V.multipliersByRisk[V.risk].slice();
    } else if (g.multipliers) {
      V.multipliers = g.multipliers.slice();
    }
    renderSlots();

    // balance + button state
    const me = V.ctx.getMyPlayer();
    const bal = me ? me.balance : 0;
    V.els.balance.textContent = money(bal);
    if (!V.animating) V.els.dropBtn.disabled = false;

    renderFeed(g.recentWins || []);

    // New drop? animate the ball along the server's path.
    const ld = g.lastDrop;
    if (ld && ld.at && ld.at !== V.animatedAt) {
      V.animatedAt = ld.at;
      // make sure the board reflects the risk that drop used, so the ball lands
      // visually consistent with the multiplier shown for that slot.
      animateDrop(ld);
    } else if (!V.animating) {
      drawBoard();
    }
  }

  // ---- multiplier color scaling ----
  function slotClass(mult) {
    // Scale by magnitude relative to this risk's range. Edges (high) = hot.
    const m = Number(mult) || 0;
    if (m >= 10) return "is-hot";
    if (m >= 3) return "is-warm";
    if (m >= 1) return "is-mid";
    return "is-cool";
  }

  function renderSlots() {
    const host = V.els.slots;
    if (!host) return;
    clear(host);
    V.multipliers.forEach((m, i) => {
      const label = (m % 1 === 0 ? m : m.toFixed(m < 1 ? 1 : 1)) + "x";
      host.appendChild(el("div", {
        class: "pk-slot " + slotClass(m),
        dataset: { slot: String(i) },
        title: m + "x multiplier",
      }, label));
    });
  }

  function flashSlot(slot) {
    const host = V.els.slots;
    if (!host) return;
    const node = host.querySelector('[data-slot="' + slot + '"]');
    if (!node) return;
    node.classList.add("is-win");
    setTimeout(() => { if (node) node.classList.remove("is-win"); }, 1400);
  }

  function renderFeed(wins) {
    const host = V.els.feed;
    if (!host) return;
    clear(host);
    if (!wins.length) {
      host.appendChild(el("div", { class: "pk-feed__empty" }, "No drops yet — be the first."));
      return;
    }
    wins.forEach((w) => {
      const hot = (Number(w.multiplier) || 0) >= 1;
      host.appendChild(el("div", { class: "pk-feed__item" }, [
        el("span", { class: "pk-feed__name" }, w.name || "Player"),
        el("span", { class: "pk-feed__mult " + (hot ? "is-hot" : "is-cool") }, (w.multiplier) + "x"),
        el("span", { class: "pk-feed__payout" }, money(w.payout || 0)),
      ]));
    });
  }

  function showLast(ld) {
    const host = V.els.last;
    if (!host) return;
    const win = (ld.payout || 0) >= (ld.bet || 0);
    clear(host);
    const payoutEl = el("strong", {
      class: "pk-last__payout " + (win ? "is-win" : "is-lose"),
      id: "pk-last-payout",
    }, money(0));
    host.appendChild(el("div", { class: "pk-last__row" }, [
      el("span", { class: "pk-last__mult" }, ld.multiplier + "x"),
      payoutEl,
    ]));
    host.appendChild(el("div", { class: "pk-last__caption" },
      "Bet " + money(ld.bet) + " · slot " + ld.slot + " · " + ld.risk));
    host.classList.remove("bump");
    void host.offsetWidth;
    host.classList.add("bump");
    countUp(payoutEl, ld.payout || 0);
  }

  function countUp(node, target) {
    if (prefersReducedMotion() || target <= 0) { node.textContent = money(target); return; }
    const dur = 700, t0 = performance.now();
    function step(now) {
      const p = clamp01((now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      node.textContent = money(Math.round(target * e));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // =====================================================================
  // Canvas board: triangular peg field + slot dividers
  // =====================================================================
  function setupCanvas() {
    const wrap = V.canvas.parentElement;
    const cssW = Math.max(280, wrap.clientWidth - 0); // padding handled by wrap
    // Aspect: keep board a touch taller than wide for a roomy drop.
    const cssH = Math.round(cssW * 0.82);
    V.dpr = Math.min(window.devicePixelRatio || 1, 2);
    V.cssW = cssW;
    V.cssH = cssH;
    V.canvas.style.height = cssH + "px";
    V.canvas.width = Math.round(cssW * V.dpr);
    V.canvas.height = Math.round(cssH * V.dpr);
    V.c2d = V.canvas.getContext("2d");
  }

  function layoutBoard() {
    const rows = V.rows;
    const W = V.cssW, H = V.cssH;
    const padX = Math.max(18, W * 0.07);
    const topPad = Math.max(22, H * 0.08);
    const botPad = Math.max(20, H * 0.07);
    V.topY = topPad;
    V.bottomY = H - botPad;

    // Horizontal spacing so the widest row (rows pegs in row index rows-1, i.e.
    // bottom peg row has `rows` pegs spanning rows+? ) fits. Peg row r (0-based)
    // has r+1 pegs. The last peg row is r = rows-1 with `rows` pegs. The slots
    // beneath number rows+1. We base gap on fitting the bottom slot row.
    const usableW = W - padX * 2;
    const gapX = usableW / rows;          // spacing between adjacent pegs / slots
    V.pegGapX = gapX;
    const usableH = V.bottomY - V.topY;
    V.pegGapY = usableH / rows;           // one row of vertical travel before slots
    V.ballRadius = Math.max(4, gapX * 0.16);

    const cx = W / 2;
    V.pegRows = [];
    V.pegs = [];
    for (let r = 0; r < rows; r++) {
      const count = r + 1;
      const y = V.topY + r * V.pegGapY;
      const rowArr = [];
      const rowWidth = r * gapX; // distance between first & last peg in row
      const startX = cx - rowWidth / 2;
      for (let i = 0; i < count; i++) {
        const x = startX + i * gapX;
        const p = { x, y };
        rowArr.push(p);
        V.pegs.push(p);
      }
      V.pegRows.push(rowArr);
    }

    // Slot x-centers: rows+1 slots, centered under the bottom peg row.
    V.slotCenters = [];
    const slotRowWidth = rows * gapX;
    const slotStart = cx - slotRowWidth / 2;
    for (let k = 0; k <= rows; k++) {
      V.slotCenters.push(slotStart + k * gapX);
    }
  }

  function drawBoard(ball) {
    if (!V || !V.c2d) return;
    const ctx = V.c2d;
    ctx.save();
    ctx.scale(V.dpr, V.dpr);
    ctx.clearRect(0, 0, V.cssW, V.cssH);

    // pegs
    const pegR = Math.max(2.5, V.pegGapX * 0.10);
    for (const p of V.pegs) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, pegR, 0, Math.PI * 2);
      const grad = ctx.createRadialGradient(p.x - pegR * 0.4, p.y - pegR * 0.4, pegR * 0.2, p.x, p.y, pegR);
      grad.addColorStop(0, "rgba(255,255,255,.95)");
      grad.addColorStop(1, "rgba(231,200,115,.85)");
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // slot dividers (subtle ticks down to the multiplier row)
    ctx.strokeStyle = "rgba(245,243,236,.18)";
    ctx.lineWidth = 1;
    const cx = V.cssW / 2;
    const slotRowWidth = V.rows * V.pegGapX;
    const slotStart = cx - slotRowWidth / 2;
    for (let k = 0; k <= V.rows; k++) {
      const x = slotStart + k * V.pegGapX;
      ctx.beginPath();
      ctx.moveTo(x, V.bottomY - V.pegGapY * 0.4);
      ctx.lineTo(x, V.cssH);
      ctx.stroke();
    }

    // ball
    if (ball) {
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, V.ballRadius, 0, Math.PI * 2);
      const bg = ctx.createRadialGradient(ball.x - V.ballRadius * 0.4, ball.y - V.ballRadius * 0.4, 0.5, ball.x, ball.y, V.ballRadius);
      bg.addColorStop(0, "#ffe9df");
      bg.addColorStop(1, "#d97757");
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  // =====================================================================
  // Drop animation — follows the SERVER path exactly into lastDrop.slot.
  // =====================================================================
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Build the list of (x,y) waypoints the ball passes: start above the apex peg,
  // through each peg it deflects off, ending at the slot center.
  function buildWaypoints(path) {
    const rows = V.rows;
    const pts = [];
    const apex = V.pegRows[0][0];
    // start: above the first peg
    pts.push({ x: apex.x, y: V.topY - V.pegGapY * 0.9 });

    // Track the ball's "column index" within each peg row. Row r has r+1 pegs
    // at indices 0..r. The ball hits a peg in row r at index `col`; L keeps col,
    // R increments col for the next row. We position the contact point at the
    // peg it strikes.
    let col = 0;
    for (let r = 0; r < rows; r++) {
      const peg = V.pegRows[r][col];
      // contact slightly above the peg center
      pts.push({ x: peg.x, y: peg.y - V.ballRadius });
      const dir = path[r] === "R" ? 1 : 0;
      if (dir === 1) col += 1; // move right -> next row's peg index increases
      // (L keeps the same index)
    }
    // final slot center. slot == number of R's == final col.
    const slotX = V.slotCenters[col];
    pts.push({ x: slotX, y: V.bottomY + V.pegGapY * 0.25 });
    pts.push({ x: slotX, y: V.cssH - V.ballRadius - 2 });
    return { pts, finalCol: col };
  }

  function animateDrop(ld) {
    if (!V) return;
    const path = Array.isArray(ld.path) ? ld.path : [];
    const { pts, finalCol } = buildWaypoints(path);
    const landSlot = (typeof ld.slot === "number") ? ld.slot : finalCol;

    const finish = () => {
      V.animating = false;
      V.ball = { x: V.slotCenters[landSlot], y: V.cssH - V.ballRadius - 2 };
      drawBoard(V.ball);
      flashSlot(landSlot);
      showLast(ld);
      if (!V.animating) V.els.dropBtn.disabled = false;
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    V.animating = true;
    V.els.dropBtn.disabled = true;

    // Per-segment timing: gravity-ish (ease into each peg, small settle), total
    // duration scaled to ~1.6–2.4s depending on rows.
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push({ a: pts[i], b: pts[i + 1] });
    }
    const total = Math.min(2400, Math.max(1500, 130 * V.rows));
    const segDur = total / segs.length;
    let segIndex = 0;
    let segStart = performance.now();

    function frame(now) {
      if (!V) return; // unmounted
      let t = (now - segStart) / segDur;
      if (t >= 1) {
        segIndex++;
        if (segIndex >= segs.length) { finish(); return; }
        segStart = now;
        t = 0;
      }
      const seg = segs[segIndex];
      const p = clamp01(t);
      // horizontal: smooth ease so deflections look like a bounce
      const ex = easeInOut(p);
      const x = seg.a.x + (seg.b.x - seg.a.x) * ex;
      // vertical: accelerate (gravity) within each downward segment
      const ey = p * p;
      let y = seg.a.y + (seg.b.y - seg.a.y) * ey;
      // small bounce arc near a peg contact (lift mid-segment slightly)
      if (segIndex < segs.length - 1) {
        const lift = Math.sin(p * Math.PI) * V.pegGapY * 0.10;
        y -= lift;
      }
      V.ball = { x, y };
      drawBoard(V.ball);
      V.raf = requestAnimationFrame(frame);
    }
    V.raf = requestAnimationFrame(frame);
  }
})();
