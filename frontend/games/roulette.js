/*
 * games/roulette.js — multiplayer European roulette view.
 *
 * Registers itself as window.CasinoGames.roulette = { mount, update, unmount }.
 *
 * What it does:
 *   - Builds the European bet layout (0-36 grid + column/dozen/even-money cells)
 *     and thin adjacency HOTSPOTS for splits/streets/corners/lines/basket,
 *     positioned from live grid geometry (ported from the legacy single-player
 *     script.js).
 *   - Renders a canvas wheel + ball and a physically-plausible spinTo()
 *     animation (also ported), but driven by the SERVER's chosen result so all
 *     players watch the same number land.
 *   - All money/bets are SERVER-AUTHORITATIVE. Clicking/dropping a chip emits
 *     game:action {type:"placeBet", key, amount}; right-click emits removeBet;
 *     Clear -> clearBets; SPIN -> spin. The view re-renders from room:state:
 *     it draws MY chips (state.game.myBets) and the TABLE total per key
 *     (tableByKey/tableTotal) so you see everyone's action. Balance is read from
 *     the room player list — never tracked locally.
 *
 * Bet KEY scheme matches backend/games/roulette-engine.js:
 *   straight:N, split:a-b (a<b), street:c (1..12), corner:tl, corner:0 (basket),
 *   line:c (1..11), column:1|2|3, dozen:1|2|3, red, black, odd, even, low, high.
 */
(function () {
  "use strict";

  const { el, clear, toast, money } = window.UI;

  // ---- Wheel constants copied from roulette-core.js (single source: backend) ----
  const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];
  const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  function colorOf(n) { return n === 0 ? "green" : (RED_NUMBERS.has(n) ? "red" : "black"); }

  // ---- Geometry helpers (ported from roulette-core.js) ----
  function isOnBoard(n) { return Number.isInteger(n) && n >= 1 && n <= 36; }
  function columnPos(n) { return Math.ceil(n / 3); }
  function rowIndex(n) { return (n - 1) % 3; }
  function splitNumbers(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return null;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo === 0) return (hi === 1 || hi === 2 || hi === 3) ? [0, hi] : null;
    if (!isOnBoard(lo) || !isOnBoard(hi)) return null;
    if (columnPos(lo) === columnPos(hi) && hi - lo === 1) return [lo, hi];
    if (rowIndex(lo) === rowIndex(hi) && hi - lo === 3) return [lo, hi];
    return null;
  }
  function streetNumbers(row) {
    if (!Number.isInteger(row) || row < 1 || row > 12) return null;
    const base = (row - 1) * 3;
    return [base + 1, base + 2, base + 3];
  }
  function cornerNumbers(tl) {
    if (!isOnBoard(tl)) return null;
    if (rowIndex(tl) === 2) return null;
    if (columnPos(tl) >= 12) return null;
    return [tl, tl + 1, tl + 3, tl + 4].sort((x, y) => x - y);
  }
  function lineNumbers(row) {
    if (!Number.isInteger(row) || row < 1 || row > 11) return null;
    return streetNumbers(row).concat(streetNumbers(row + 1));
  }
  function columnNumbers(col) { const out = []; for (let i = 0; i < 12; i++) out.push(col + i * 3); return out; }

  const CHIP_VALUES = [1, 5, 25, 100, 500];

  // ---- View instance state (rebuilt each mount) ----
  let V = null;

  function freshView() {
    return {
      ctx: null,           // game ctx from app router
      root: null,          // container
      chipValue: 5,
      // DOM maps
      cellByKey: new Map(),
      numberCells: new Map(),
      hotspots: [],
      // wheel
      canvas: null, c2d: null, R: 0, seg: 0,
      wheelAngle: 0, ballAngle: -Math.PI / 2, ballRadius: 0,
      spinning: false,
      animatedSpinAt: null, // lastSpin.at value we've already animated
      // refs
      els: {},
      resizeHandler: null,
    };
  }

  // ---- public API ------------------------------------------------------
  const Roulette = {
    mount(container, ctx) {
      V = freshView();
      V.ctx = ctx;
      V.root = container;
      buildDOM(container);
      buildChips();
      buildGrid();
      buildHotspots();
      buildOutside();
      setupWheel();
      drawWheel();
      // position hotspots after layout settles
      requestAnimationFrame(positionHotspots);
      V.resizeHandler = () => positionHotspots();
      window.addEventListener("resize", V.resizeHandler);
      // initial paint from current state
      this.update(ctx.getState());
    },

    update(roomState) {
      if (!V || !roomState || roomState.gameId !== "roulette") return;
      const g = roomState.game;
      if (!g) return;
      renderState(g);
    },

    unmount() {
      if (!V) return;
      if (V.resizeHandler) window.removeEventListener("resize", V.resizeHandler);
      if (V._raf) cancelAnimationFrame(V._raf);
      V = null;
    },
  };
  window.CasinoGames = window.CasinoGames || {};
  window.CasinoGames.roulette = Roulette;

  // =====================================================================
  // DOM scaffold
  // =====================================================================
  function buildDOM(container) {
    const wheelSide = el("section", { class: "rl-wheel-side" }, [
      el("div", { class: "rl-wheel-wrap" }, [
        el("div", { class: "rl-pointer", "aria-hidden": "true" }),
        el("canvas", { id: "rl-wheel", class: "rl-wheel", width: "380", height: "380" }),
        el("div", { id: "rl-result", class: "rl-result hidden" }, el("span", { id: "rl-result-num" }, "0")),
      ]),
      el("div", { class: "rl-phase pill", id: "rl-phase" }, "Place your bets"),
      el("div", { class: "rl-history", id: "rl-history" }),
      el("div", { class: "rl-spin-summary", id: "rl-summary" }),
    ]);

    const chips = el("div", { class: "rl-chips", id: "rl-chips" }, el("span", { class: "rl-chips-label" }, "Drag a chip onto the table, or tap to select then tap a bet"));

    const felt = el("div", { class: "rl-felt" }, [
      el("div", { class: "rl-bet-grid", id: "rl-bet-grid" }),
      el("div", { class: "rl-outside", id: "rl-outside" }),
    ]);

    const controls = el("div", { class: "rl-controls" }, [
      el("div", { class: "rl-totals" }, [
        el("span", { class: "rl-total" }, [el("span", { class: "rl-total__label" }, "My bets"), el("strong", { id: "rl-mytotal" }, "$0")]),
        el("span", { class: "rl-total" }, [el("span", { class: "rl-total__label" }, "On table"), el("strong", { id: "rl-tabletotal" }, "$0")]),
      ]),
      el("div", { class: "rl-buttons" }, [
        el("button", { class: "btn btn-secondary", id: "rl-clear", onclick: clearBets }, "Clear"),
        el("button", { class: "btn btn-primary rl-spin", id: "rl-spin", onclick: spin }, "SPIN"),
      ]),
    ]);

    const tableSide = el("section", { class: "rl-table-side" }, [chips, felt, controls]);

    clear(container).appendChild(el("div", { class: "rl-root rise-in" }, [wheelSide, tableSide]));

    V.els = {
      phase: container.querySelector("#rl-phase"),
      history: container.querySelector("#rl-history"),
      summary: container.querySelector("#rl-summary"),
      result: container.querySelector("#rl-result"),
      resultNum: container.querySelector("#rl-result-num"),
      myTotal: container.querySelector("#rl-mytotal"),
      tableTotal: container.querySelector("#rl-tabletotal"),
      spinBtn: container.querySelector("#rl-spin"),
      clearBtn: container.querySelector("#rl-clear"),
      grid: container.querySelector("#rl-bet-grid"),
      outside: container.querySelector("#rl-outside"),
      chips: container.querySelector("#rl-chips"),
    };
  }

  // =====================================================================
  // Chips tray + drag and drop
  // =====================================================================
  function buildChips() {
    CHIP_VALUES.forEach((v) => {
      const chip = el("button", {
        class: "rl-chip chip-" + v + (v === V.chipValue ? " selected" : ""),
        draggable: "true",
        title: "$" + v + " chip — click to select or drag onto a bet",
        dataset: { val: String(v) },
        onclick: () => selectChip(v),
      }, String(v));

      // ---- HTML5 drag-and-drop (mouse) ----
      chip.addEventListener("dragstart", (e) => {
        selectChip(v);
        V._dragVal = v;
        document.body.classList.add("rl-dragging");
        chip.classList.add("rl-chip--dragging");
        try {
          e.dataTransfer.setData("text/plain", String(v));
          e.dataTransfer.effectAllowed = "copy";
        } catch (_) {}
      });
      chip.addEventListener("dragend", () => {
        V._dragVal = null;
        document.body.classList.remove("rl-dragging");
        chip.classList.remove("rl-chip--dragging");
        clearDropHighlights();
      });

      // ---- Pointer-events fallback (touch / pen) ----
      chip.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse") return; // mouse uses native DnD above
        startPointerDrag(e, v, chip);
      });

      V.els.chips.appendChild(chip);
    });
  }

  function selectChip(v) {
    V.chipValue = v;
    V.els.chips.querySelectorAll(".rl-chip").forEach((c) => c.classList.toggle("selected", Number(c.dataset.val) === v));
  }

  // Pointer-drag clone follows the finger; drops on the element under release.
  function startPointerDrag(e, val, sourceChip) {
    e.preventDefault();
    const ghost = sourceChip.cloneNode(true);
    ghost.classList.add("rl-chip--ghost");
    ghost.style.position = "fixed";
    ghost.style.pointerEvents = "none";
    ghost.style.zIndex = "9999";
    document.body.appendChild(ghost);
    document.body.classList.add("rl-dragging");
    const move = (ev) => {
      ghost.style.left = (ev.clientX - 24) + "px";
      ghost.style.top = (ev.clientY - 24) + "px";
      const target = dropTargetAt(ev.clientX, ev.clientY);
      highlightOnly(target);
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost.remove();
      document.body.classList.remove("rl-dragging");
      clearDropHighlights();
      const target = dropTargetAt(ev.clientX, ev.clientY);
      if (target) placeBet(target.dataset.key, val);
    };
    move(e);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dropTargetAt(x, y) {
    const node = document.elementFromPoint(x, y);
    if (!node) return null;
    return node.closest("[data-key]");
  }

  function clearDropHighlights() {
    if (!V || !V.root) return;
    V.root.querySelectorAll(".rl-drop-ok").forEach((n) => n.classList.remove("rl-drop-ok"));
  }
  function highlightOnly(target) {
    clearDropHighlights();
    if (target) target.classList.add("rl-drop-ok");
  }

  // Wire a bet element as a native drop target.
  function makeDropTarget(node) {
    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "copy"; } catch (_) {}
      node.classList.add("rl-drop-ok");
    });
    node.addEventListener("dragleave", () => node.classList.remove("rl-drop-ok"));
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      node.classList.remove("rl-drop-ok");
      let val = V._dragVal;
      try { const d = Number(e.dataTransfer.getData("text/plain")); if (d) val = d; } catch (_) {}
      if (val) placeBet(node.dataset.key, val);
    });
  }

  // =====================================================================
  // Bet layout
  // =====================================================================
  function makeCell(label, opts) {
    const node = el("div", {
      class: "rl-cell" + (opts.cls ? " " + opts.cls : ""),
      role: "button",
      tabindex: "0",
      "aria-label": "Bet " + label,
      dataset: { key: opts.key },
      onclick: () => placeBet(opts.key, V.chipValue),
      oncontextmenu: (e) => { e.preventDefault(); removeBet(opts.key); },
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); placeBet(opts.key, V.chipValue); } },
    }, label);
    makeDropTarget(node);
    V.cellByKey.set(opts.key, node);
    return node;
  }

  function buildGrid() {
    const grid = V.els.grid;
    // Zero
    const zero = makeCell("0", { cls: "green zero", key: "straight:0" });
    zero.style.gridRow = "1 / span 3";
    zero.style.gridColumn = "1";
    grid.appendChild(zero);
    V.numberCells.set(0, { el: zero, gridCol: 1, gridRow: 1 });

    for (let n = 1; n <= 36; n++) {
      const colIndex = Math.ceil(n / 3);
      const rowFromBottom = (n - 1) % 3;
      const gridRow = 3 - rowFromBottom;
      const cell = makeCell(String(n), { cls: colorOf(n), key: "straight:" + n });
      cell.style.gridColumn = String(colIndex + 1);
      cell.style.gridRow = String(gridRow);
      grid.appendChild(cell);
      V.numberCells.set(n, { el: cell, gridCol: colIndex + 1, gridRow });
    }

    for (let gridRow = 1; gridRow <= 3; gridRow++) {
      const tableCol = 3 - (gridRow - 1);
      const cell = makeCell("2:1", { cls: "col-bet", key: "column:" + tableCol });
      cell.style.gridColumn = "14";
      cell.style.gridRow = String(gridRow);
      grid.appendChild(cell);
    }
  }

  function posOf(n) { return V.numberCells.get(n); }
  function rectOf(n) {
    const info = V.numberCells.get(n);
    if (!info) return null;
    const e = info.el;
    return {
      left: e.offsetLeft, top: e.offsetTop, width: e.offsetWidth, height: e.offsetHeight,
      right: e.offsetLeft + e.offsetWidth, bottom: e.offsetTop + e.offsetHeight,
    };
  }
  function hotspotThickness() {
    return window.matchMedia("(hover: none), (pointer: coarse)").matches ? 22 : 16;
  }

  function makeHotspot(spec) {
    const node = el("div", {
      class: "rl-hotspot",
      role: "button",
      tabindex: "0",
      "aria-label": spec.label,
      title: spec.label,
      dataset: { key: spec.key },
      onclick: () => placeBet(spec.key, V.chipValue),
      oncontextmenu: (e) => { e.preventDefault(); removeBet(spec.key); },
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); placeBet(spec.key, V.chipValue); } },
    });
    makeDropTarget(node);
    V.cellByKey.set(spec.key, node);
    V.els.grid.appendChild(node);
    V.hotspots.push({ el: node, spec });
  }

  function positionHotspots() {
    if (!V) return;
    const t = hotspotThickness();
    const corner = Math.max(t, 20);
    V.hotspots.forEach(({ el, spec }) => spec.place(el, t, corner));
  }

  function buildHotspots() {
    // splits
    for (let n = 1; n <= 36; n++) {
      const a = posOf(n);
      for (let m = n + 1; m <= 36; m++) {
        const b = posOf(m);
        const sameRow = a.gridRow === b.gridRow;
        const sameCol = a.gridCol === b.gridCol;
        const adjCol = Math.abs(a.gridCol - b.gridCol) === 1;
        const adjRow = Math.abs(a.gridRow - b.gridRow) === 1;
        const verticalBorder = sameRow && adjCol;
        const horizontalBorder = sameCol && adjRow;
        if (!verticalBorder && !horizontalBorder) continue;
        const nums = splitNumbers(n, m);
        if (!nums) continue;
        const lo = nums[0], hi = nums[1];
        makeHotspot({
          key: "split:" + lo + "-" + hi,
          label: "Split " + lo + " & " + hi,
          place: (e, t) => {
            const ra = rectOf(lo), rb = rectOf(hi);
            if (verticalBorder) {
              const x = (Math.min(ra.right, rb.right) + Math.max(ra.left, rb.left)) / 2;
              const top = Math.min(ra.top, rb.top);
              const h = Math.max(ra.bottom, rb.bottom) - top;
              e.style.left = (x - t / 2) + "px"; e.style.top = top + "px"; e.style.width = t + "px"; e.style.height = h + "px";
            } else {
              const y = (Math.min(ra.bottom, rb.bottom) + Math.max(ra.top, rb.top)) / 2;
              const left = Math.min(ra.left, rb.left);
              const w = Math.max(ra.right, rb.right) - left;
              e.style.left = left + "px"; e.style.top = (y - t / 2) + "px"; e.style.width = w + "px"; e.style.height = t + "px";
            }
          },
        });
      }
    }
    // zero splits
    [1, 2, 3].forEach((hi) => {
      const nums = splitNumbers(0, hi);
      if (!nums) return;
      makeHotspot({
        key: "split:0-" + hi,
        label: "Split 0 & " + hi,
        place: (e, t) => {
          const rz = rectOf(0), rn = rectOf(hi);
          const x = (rz.right + rn.left) / 2;
          e.style.left = (x - t / 2) + "px"; e.style.top = rn.top + "px"; e.style.width = t + "px"; e.style.height = rn.height + "px";
        },
      });
    });
    // streets
    for (let c = 1; c <= 12; c++) {
      const nums = streetNumbers(c);
      const bottomNum = nums[0];
      makeHotspot({
        key: "street:" + c,
        label: "Street " + nums.join(", "),
        place: (e, t) => {
          const r = rectOf(bottomNum);
          e.style.left = r.left + "px"; e.style.top = (r.bottom - t / 2) + "px"; e.style.width = r.width + "px"; e.style.height = t + "px";
        },
      });
    }
    // corners
    for (let tl = 1; tl <= 36; tl++) {
      const nums = cornerNumbers(tl);
      if (!nums) continue;
      makeHotspot({
        key: "corner:" + tl,
        label: "Corner " + nums.join(", "),
        place: (e, t, corner) => {
          const r = rectOf(tl);
          e.style.left = (r.right - corner / 2) + "px"; e.style.top = (r.top - corner / 2) + "px"; e.style.width = corner + "px"; e.style.height = corner + "px";
        },
      });
    }
    // lines
    for (let c = 1; c <= 11; c++) {
      const nums = lineNumbers(c);
      const leftBottom = streetNumbers(c)[0];
      const rightBottom = streetNumbers(c + 1)[0];
      makeHotspot({
        key: "line:" + c,
        label: "Six line " + nums[0] + "–" + nums[5],
        place: (e, t) => {
          const rl = rectOf(leftBottom), rr = rectOf(rightBottom);
          const x = (rl.right + rr.left) / 2;
          const top = Math.max(rl.bottom, rr.bottom) - t / 2;
          e.style.left = (x - t / 2) + "px"; e.style.top = top + "px"; e.style.width = t + "px"; e.style.height = t + "px";
        },
      });
    }
    // basket 0,1,2,3 -> key corner:0 (matches engine resolveKey)
    makeHotspot({
      key: "corner:0",
      label: "First four 0, 1, 2, 3",
      place: (e, t, corner) => {
        const rz = rectOf(0), r1 = rectOf(1);
        const px = (rz.right + r1.left) / 2;
        const py = r1.bottom;
        e.style.left = (px - corner / 2) + "px"; e.style.top = (py - corner / 2) + "px"; e.style.width = corner + "px"; e.style.height = corner + "px";
      },
    });
  }

  function buildOutside() {
    const out = V.els.outside;
    [["1st 12", 1], ["2nd 12", 2], ["3rd 12", 3]].forEach(([label, d]) => {
      out.appendChild(makeCell(label, { cls: "dozen", key: "dozen:" + d }));
    });
    [
      ["1-18", "low", ""], ["EVEN", "even", ""], ["RED", "red", "swatch-red"],
      ["BLACK", "black", "swatch-black"], ["ODD", "odd", ""], ["19-36", "high", ""],
    ].forEach(([label, type, cls]) => {
      out.appendChild(makeCell(label, { cls, key: type }));
    });
  }

  // =====================================================================
  // Server-wired actions
  // =====================================================================
  function curState() { return V.ctx.getState(); }
  function gameState() { const s = curState(); return s && s.game; }

  function placeBet(key, amount) {
    const g = gameState();
    if (g && g.phase !== "betting") { toast("No more bets — round in play.", "error"); return; }
    const me = V.ctx.getMyPlayer();
    if (me && me.balance < amount) { toast("Not enough balance for a $" + amount + " chip.", "error"); return; }
    V.ctx.socket.gameAction({ type: "placeBet", key, amount }).then((res) => {
      if (!res.ok) toast(res.error || "Bet rejected.", "error");
    });
  }
  function removeBet(key) {
    const g = gameState();
    if (g && g.phase !== "betting") return;
    // remove one chip's worth (current selected chip), capped server-side
    V.ctx.socket.gameAction({ type: "removeBet", key, amount: V.chipValue }).then((res) => {
      if (!res.ok && res.error !== "No such bet") toast(res.error || "Could not remove bet.", "error");
    });
  }
  function clearBets() {
    V.ctx.socket.gameAction({ type: "clearBets" }).then((res) => {
      if (!res.ok) toast(res.error || "Could not clear bets.", "error");
    });
  }
  function spin() {
    V.ctx.socket.gameAction({ type: "spin" }).then((res) => {
      if (!res.ok) toast(res.error || "Could not spin.", "error");
    });
  }

  // =====================================================================
  // Render from authoritative state
  // =====================================================================
  function renderState(g) {
    // phase label + control enabling
    const betting = g.phase === "betting";
    V.els.phase.textContent = betting ? "Place your bets" : "No more bets — spinning…";
    V.els.phase.classList.toggle("is-spinning", !betting);
    V.els.spinBtn.disabled = !betting || V.spinning || g.tableTotal <= 0;
    V.els.clearBtn.disabled = !betting || V.spinning;

    // totals
    const myTotal = (g.myBets || []).reduce((s, b) => s + b.amount, 0);
    V.els.myTotal.textContent = money(myTotal);
    V.els.tableTotal.textContent = money(g.tableTotal || 0);

    // chips on the board: my chips (solid) + table coverage (count)
    renderChips(g);
    renderHistory(g.history || []);

    // spin animation: when a new lastSpin arrives we haven't animated yet, run it.
    if (g.lastSpin && g.lastSpin.at && g.lastSpin.at !== V.animatedSpinAt) {
      V.animatedSpinAt = g.lastSpin.at;
      if (typeof g.lastResult === "number") {
        runSpin(g.lastResult, () => showSummary(g.lastSpin));
      }
    } else if (betting) {
      // betting phase resumed; clear the round result banner
      V.els.result.classList.add("hidden");
    }
  }

  function renderChips(g) {
    // clear old
    V.root.querySelectorAll(".rl-bet-chip").forEach((c) => c.remove());
    V.cellByKey.forEach((node) => node.classList.remove("has-chip", "rl-cell--covered"));

    const mine = new Map();
    (g.myBets || []).forEach((b) => mine.set(b.key, b.amount));
    const table = g.tableByKey || {};

    // render a chip for every key with table action; show MY amount prominently,
    // and a small "+others" marker when the table total exceeds mine.
    Object.keys(table).forEach((key) => {
      const node = V.cellByKey.get(key);
      if (!node) return;
      const myAmt = mine.get(key) || 0;
      const tableAmt = table[key] || 0;
      const chip = el("div", { class: "rl-bet-chip" + (myAmt > 0 ? " is-mine" : " is-other") }, String(myAmt > 0 ? myAmt : tableAmt));
      if (myAmt > 0 && tableAmt > myAmt) {
        chip.appendChild(el("span", { class: "rl-bet-chip__others", title: "Total on this bet: $" + tableAmt }, "+"));
      }
      node.appendChild(chip);
      node.classList.add("has-chip");
      if (myAmt === 0) node.classList.add("rl-cell--covered");
    });
  }

  function renderHistory(history) {
    clear(V.els.history);
    history.slice(0, 14).forEach((n) => {
      V.els.history.appendChild(el("div", { class: "rl-h " + colorOf(n) }, String(n)));
    });
  }

  function showSummary(lastSpin) {
    if (!V) return;
    const me = V.ctx.persistentId;
    const mine = lastSpin.perPlayer && lastSpin.perPlayer[me];
    clear(V.els.summary);
    const head = el("div", { class: "rl-summary__result " + lastSpin.color }, [
      el("span", {}, String(lastSpin.result)),
      el("span", { class: "rl-summary__color" }, lastSpin.color),
    ]);
    V.els.summary.appendChild(head);
    if (mine) {
      const net = mine.net;
      const kind = net > 0 ? "win" : (net < 0 ? "lose" : "even");
      V.els.summary.appendChild(el("div", { class: "rl-summary__net rl-" + kind },
        net > 0 ? "You won " + money(net) + " net" : (net < 0 ? "You lost " + money(-net) : "You broke even")));
    } else {
      V.els.summary.appendChild(el("div", { class: "rl-summary__net" }, "No bets last round"));
    }
  }

  // =====================================================================
  // Wheel canvas + spin animation (ported from legacy script.js)
  // =====================================================================
  function setupWheel() {
    V.canvas = V.root.querySelector("#rl-wheel");
    V.c2d = V.canvas.getContext("2d");
    V.R = V.canvas.width / 2;
    V.seg = (2 * Math.PI) / WHEEL_ORDER.length;
    V.ballRadius = V.R - 18;
  }

  function pocketColor(n) {
    const col = colorOf(n);
    return col === "red" ? "#c1121f" : col === "black" ? "#1a1a1a" : "#0a6b3b";
  }
  function pocketScreenAngle(idx) { return idx * V.seg - Math.PI / 2 + V.wheelAngle; }

  function drawWheel() {
    const ctx = V.c2d, R = V.R, N = WHEEL_ORDER.length, seg = V.seg;
    ctx.clearRect(0, 0, V.canvas.width, V.canvas.height);
    ctx.save();
    ctx.translate(R, R);
    ctx.beginPath(); ctx.arc(0, 0, R - 2, 0, 2 * Math.PI); ctx.fillStyle = "#241708"; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, R - 8, 0, 2 * Math.PI); ctx.fillStyle = "#3a2a12"; ctx.fill();
    ctx.rotate(V.wheelAngle);
    for (let i = 0; i < N; i++) {
      const n = WHEEL_ORDER[i];
      const start = i * seg - Math.PI / 2 - seg / 2;
      const end = start + seg;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R - 14, start, end); ctx.closePath();
      ctx.fillStyle = pocketColor(n); ctx.fill();
      ctx.strokeStyle = "rgba(231,200,115,.6)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.save(); ctx.rotate(start); ctx.fillStyle = "rgba(231,200,115,.85)"; ctx.fillRect(R - 16, -1, 14, 2); ctx.restore();
      ctx.save(); ctx.rotate(start + seg / 2); ctx.translate(R - 26, 0); ctx.rotate(Math.PI / 2);
      ctx.fillStyle = "#fff"; ctx.font = "bold 11px Inter, Arial"; ctx.textAlign = "center";
      ctx.fillText(String(n), 0, 0); ctx.restore();
    }
    ctx.beginPath(); ctx.arc(0, 0, R * 0.45, 0, 2 * Math.PI); ctx.fillStyle = "#0a6b3b"; ctx.fill();
    ctx.strokeStyle = "#e7c873"; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, R * 0.22, 0, 2 * Math.PI); ctx.fillStyle = "#111"; ctx.fill();
    ctx.strokeStyle = "#e7c873"; ctx.stroke();
    ctx.restore();

    const bx = R + V.ballRadius * Math.cos(V.ballAngle);
    const by = R + V.ballRadius * Math.sin(V.ballAngle);
    ctx.beginPath(); ctx.arc(bx, by, 6, 0, 2 * Math.PI);
    const grad = ctx.createRadialGradient(bx - 2, by - 2, 0.5, bx, by, 6);
    grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#c9c9c9");
    ctx.fillStyle = grad; ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.5)"; ctx.lineWidth = 1; ctx.stroke();
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  // Reduced-motion: skip the long animation, just land on the result.
  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function runSpin(result, done) {
    if (!V) return;
    V.spinning = true;
    V.els.spinBtn.disabled = true;
    V.els.clearBtn.disabled = true;
    V.els.result.classList.add("hidden");

    const idx = WHEEL_ORDER.indexOf(result);
    if (idx < 0) { V.spinning = false; if (done) done(); return; }

    if (prefersReducedMotion()) {
      V.wheelAngle = ((-idx * V.seg) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      V.ballAngle = pocketScreenAngle(idx);
      V.ballRadius = V.R - 26;
      drawWheel();
      finishSpin(result, done);
      return;
    }

    const R = V.R, seg = V.seg;
    const RIM_RADIUS = R - 10, POCKET_RADIUS = R - 26;
    const wheelStart = V.wheelAngle;
    const wheelRevs = 5;
    const desiredFinalMod = (((-idx * seg) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let curMod = ((wheelStart % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let delta = desiredFinalMod - curMod;
    if (delta < 0) delta += 2 * Math.PI;
    const wheelEnd = wheelStart + wheelRevs * 2 * Math.PI + delta;

    const duration = 6000, spiralStart = 0.55, dropStart = 0.82;
    const startRadius = RIM_RADIUS;
    V.ballRadius = startRadius;
    const ballStart = V.ballAngle;
    const wheelAtDrop = wheelStart + (wheelEnd - wheelStart) * easeOutCubic(dropStart);
    const pocketAngleAtDrop = idx * seg - Math.PI / 2 + wheelAtDrop;
    const ballRevs = 9;
    let ballRaw = (pocketAngleAtDrop - ballStart) % (2 * Math.PI);
    ballRaw = ((ballRaw % (2 * Math.PI)) - 2 * Math.PI) % (2 * Math.PI);
    const ballCaptureAngle = ballStart - ballRevs * 2 * Math.PI + ballRaw;
    const eAtDrop = easeOutCubic(dropStart);
    const t0 = performance.now();

    function frame(now) {
      if (!V) return; // unmounted mid-spin
      const p = clamp01((now - t0) / duration);
      const e = easeOutCubic(p);
      V.wheelAngle = wheelStart + (wheelEnd - wheelStart) * e;
      if (p < dropStart) {
        const eFrac = e / eAtDrop;
        V.ballAngle = ballStart + (ballCaptureAngle - ballStart) * eFrac;
        let rT = clamp01((p - spiralStart) / (dropStart - spiralStart));
        rT = easeOutCubic(rT);
        V.ballRadius = startRadius + (POCKET_RADIUS + 5 - startRadius) * rT;
      } else {
        const dT = clamp01((p - dropStart) / (1 - dropStart));
        const de = easeOutCubic(dT);
        const pocketAng = pocketScreenAngle(idx);
        const rattle = Math.sin(dT * Math.PI) * (1 - dT) * 0.05 * Math.cos(dT * Math.PI * 6);
        V.ballAngle = pocketAng + rattle;
        V.ballRadius = (POCKET_RADIUS + 5) + (POCKET_RADIUS - (POCKET_RADIUS + 5)) * de;
      }
      drawWheel();
      if (p < 1) {
        V._raf = requestAnimationFrame(frame);
      } else {
        V.wheelAngle = wheelEnd;
        V.ballAngle = pocketScreenAngle(idx);
        V.ballRadius = POCKET_RADIUS;
        drawWheel();
        finishSpin(result, done);
      }
    }
    V._raf = requestAnimationFrame(frame);
  }

  function finishSpin(result, done) {
    if (!V) return;
    V.spinning = false;
    V.els.result.className = "rl-result " + colorOf(result);
    V.els.resultNum.textContent = String(result);
    // debug hook for QA
    window.__rouletteDebug = { result, ballAngle: V.ballAngle, wheelAngle: V.wheelAngle };
    if (done) done();
    // re-enable controls per the current authoritative state
    const g = gameState();
    if (g) {
      const betting = g.phase === "betting";
      V.els.spinBtn.disabled = !betting || g.tableTotal <= 0;
      V.els.clearBtn.disabled = !betting;
    }
  }
})();
