/*
 * games/slots.js — multiplayer 5x3 slot machine view.
 *
 * Registers itself as window.CasinoGames.slots = { mount, update, unmount },
 * the exact same shape roulette.js uses, so app.js's game router can mount it
 * by assigning window.CasinoGames[gameId].
 *
 * What it does:
 *   - Renders a 5-reel x 3-row machine. Each cell shows a tasteful glyph for one
 *     of the six symbols (cherry, lemon, bell, star, seven, wild).
 *   - A chip/bet selector (clamped to maxBet and the player's LIVE balance from
 *     the room player list) and a big SPIN button. Money is SERVER-AUTHORITATIVE:
 *     SPIN emits game:action {type:"spin", bet}; balance is read from the room
 *     players list, never tracked locally.
 *   - On spin we animate each reel scrolling (a quick blurred cycle of symbols)
 *     then settle column-by-column onto the SERVER's chosen result
 *     (state.lastSpin.grid). ~1s total, reduced-motion safe (snaps instantly).
 *   - After settling we HIGHLIGHT the winning paylines from lastSpin.lines —
 *     draw each line's path over the grid (color-keyed per line index) and glow
 *     the contributing cells — and count the win amount up.
 *   - Shows a collapsible PAYTABLE (from state.paytable) and a shared
 *     "Table wins" feed (state.recentWins) of other players' wins by name.
 *
 * Each player spins their OWN machine (lastSpin is per-viewer); recentWins is a
 * shared, low-information feed.
 *
 * Action emitted: game:action { type:"spin", bet }.
 */
(function () {
  "use strict";

  const { el, clear, toast, money } = window.UI;

  // ---- Symbol presentation (ids match backend/games/slots-engine.js SYMBOLS) ----
  // Warm, legible glyphs — not neon. Each tied to a theme-aligned tint.
  const SYMBOL_META = {
    cherry: { glyph: "🍒", label: "Cherry", tint: "var(--c-red)" },
    lemon: { glyph: "🍋", label: "Lemon", tint: "var(--c-amber)" },
    bell: { glyph: "🔔", label: "Bell", tint: "var(--gold)" },
    star: { glyph: "★", label: "Star", tint: "var(--c-blue)" },
    seven: { glyph: "7", label: "Seven", tint: "var(--accent)" },
    wild: { glyph: "✦", label: "Wild", tint: "var(--c-green)" },
  };
  const SYMBOL_ORDER = ["cherry", "lemon", "bell", "star", "seven", "wild"];

  // Per-payline highlight colors, keyed by line index (tasteful, distinct).
  const LINE_COLORS = [
    "var(--accent)",   // 0 top row — coral
    "var(--c-blue)",   // 1 middle row
    "var(--c-green)",  // 2 bottom row
    "var(--gold)",     // 3 V-diagonal
    "var(--c-amber)",  // 4 ^-diagonal
  ];

  const CHIP_VALUES = [5, 25, 100, 500, 1000];

  let V = null;

  function freshView() {
    return {
      ctx: null,
      root: null,
      reels: 5,
      rows: 3,
      bet: CHIP_VALUES[0],
      maxBet: 100000,
      paytable: null,
      paylines: null,
      cells: [],          // cells[col][row] -> { wrap, glyph } DOM
      spinning: false,
      animatedSpinAt: null,
      timers: [],
      raf: null,
      countRaf: null,
      els: {},
    };
  }

  // ---- public API ------------------------------------------------------
  const Slots = {
    mount(container, ctx) {
      V = freshView();
      V.ctx = ctx;
      V.root = container;
      buildDOM(container);
      this.update(ctx.getState());
    },

    update(roomState) {
      if (!V || !roomState || roomState.gameId !== "slots") return;
      const g = roomState.game;
      if (!g) return;
      renderState(g);
    },

    unmount() {
      if (!V) return;
      V.timers.forEach((t) => clearTimeout(t));
      if (V.raf) cancelAnimationFrame(V.raf);
      if (V.countRaf) cancelAnimationFrame(V.countRaf);
      V = null;
    },
  };
  window.CasinoGames = window.CasinoGames || {};
  window.CasinoGames.slots = Slots;

  // =====================================================================
  // DOM scaffold
  // =====================================================================
  function buildDOM(container) {
    // ---- Machine: cabinet with 5x3 grid + SVG payline overlay ----
    const grid = el("div", { class: "sl-grid", id: "sl-grid" });
    const overlay = svgEl("svg", { class: "sl-lines", id: "sl-lines", preserveAspectRatio: "none" });

    const window_ = el("div", { class: "sl-window" }, [grid, overlay]);

    const winBanner = el("div", { class: "sl-win hidden", id: "sl-win" }, [
      el("span", { class: "sl-win__label" }, "WIN"),
      el("strong", { class: "sl-win__amt", id: "sl-win-amt" }, money(0)),
    ]);

    const cabinet = el("div", { class: "sl-cabinet" }, [
      el("div", { class: "sl-cabinet__top" }, [
        el("span", { class: "sl-brand display" }, "Maison"),
        el("span", { class: "sl-brand-sub pill accent" }, "5 reels · 5 lines"),
      ]),
      window_,
      winBanner,
    ]);

    // ---- Controls: chip selector + SPIN ----
    const chipTray = el("div", { class: "sl-chips", id: "sl-chips" });

    const controls = el("div", { class: "sl-controls" }, [
      el("div", { class: "sl-bet-row" }, [
        el("span", { class: "sl-bet-label" }, "Bet"),
        chipTray,
      ]),
      el("div", { class: "sl-action-row" }, [
        el("div", { class: "sl-bet-summary" }, [
          el("span", { class: "sl-bet-summary__label" }, "Total bet"),
          el("strong", { id: "sl-bet-val" }, money(V.bet)),
          el("span", { class: "sl-bet-summary__hint caption", id: "sl-bet-hint" }, "covers all 5 lines"),
        ]),
        el("button", { class: "btn btn-primary sl-spin", id: "sl-spin", onclick: spin }, "SPIN"),
      ]),
    ]);

    const machineSide = el("section", { class: "sl-machine-side" }, [cabinet, controls]);

    // ---- Sidebar: paytable (collapsible) + shared Table wins feed ----
    const paytablePanel = el("details", { class: "sl-paytable", id: "sl-paytable" }, [
      el("summary", { class: "sl-paytable__summary" }, "Paytable"),
      el("div", { class: "sl-paytable__body", id: "sl-paytable-body" }),
    ]);

    const winsFeed = el("div", { class: "sl-feed card" }, [
      el("h4", { class: "panel__title" }, "Table wins"),
      el("p", { class: "caption sl-feed__note" }, "Big wins from everyone at this table — each player spins their own machine."),
      el("ul", { class: "sl-feed__list", id: "sl-feed-list" }),
    ]);

    const sidebar = el("aside", { class: "sl-sidebar" }, [paytablePanel, winsFeed]);

    clear(container).appendChild(el("div", { class: "sl-root rise-in" }, [machineSide, sidebar]));

    V.els = {
      grid,
      overlay,
      win: container.querySelector("#sl-win"),
      winAmt: container.querySelector("#sl-win-amt"),
      chips: chipTray,
      spinBtn: container.querySelector("#sl-spin"),
      betVal: container.querySelector("#sl-bet-val"),
      betHint: container.querySelector("#sl-bet-hint"),
      paytableBody: container.querySelector("#sl-paytable-body"),
      feedList: container.querySelector("#sl-feed-list"),
    };
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // Build the reel/cell grid once we know dimensions.
  function buildGrid(reels, rows) {
    clear(V.els.grid);
    V.cells = [];
    V.els.grid.style.gridTemplateColumns = "repeat(" + reels + ", 1fr)";
    for (let c = 0; c < reels; c++) {
      const col = [];
      const reel = el("div", { class: "sl-reel", dataset: { col: String(c) } });
      for (let r = 0; r < rows; r++) {
        const glyph = el("div", { class: "sl-sym" });
        const cell = el("div", { class: "sl-cell", dataset: { col: String(c), row: String(r) } }, glyph);
        reel.appendChild(cell);
        col.push({ cell, glyph });
      }
      V.els.grid.appendChild(reel);
      V.cells.push(col);
    }
    V.reels = reels;
    V.rows = rows;
  }

  function setCellSymbol(col, row, symId) {
    const c = V.cells[col] && V.cells[col][row];
    if (!c) return;
    const meta = SYMBOL_META[symId] || { glyph: "?", tint: "var(--text)" };
    c.glyph.textContent = meta.glyph;
    c.glyph.style.color = meta.tint;
    c.cell.dataset.sym = symId;
    c.cell.classList.toggle("sl-cell--seven", symId === "seven");
  }

  // =====================================================================
  // Chips / bet selector
  // =====================================================================
  function buildChips() {
    clear(V.els.chips);
    CHIP_VALUES.forEach((v) => {
      const chip = el("button", {
        class: "sl-chip" + (v === V.bet ? " selected" : ""),
        dataset: { val: String(v) },
        title: "Bet $" + v,
        onclick: () => selectBet(v),
      }, money(v));
      V.els.chips.appendChild(chip);
    });
    syncChipState();
  }

  function selectBet(v) {
    V.bet = v;
    V.els.betVal.textContent = money(v);
    syncChipState();
  }

  function syncChipState() {
    const me = V.ctx.getMyPlayer();
    const bal = me ? me.balance : Infinity;
    V.els.chips.querySelectorAll(".sl-chip").forEach((c) => {
      const val = Number(c.dataset.val);
      const tooBig = val > V.maxBet || val > bal;
      c.classList.toggle("selected", val === V.bet);
      c.disabled = tooBig && !V.spinning ? false : c.disabled; // keep enabled; just mark
      c.classList.toggle("is-unaffordable", val > bal);
    });
    V.els.betVal.textContent = money(V.bet);
  }

  // =====================================================================
  // Actions
  // =====================================================================
  function spin() {
    if (!V || V.spinning) return;
    const me = V.ctx.getMyPlayer();
    if (me && me.balance < V.bet) { toast("Not enough balance for a " + money(V.bet) + " spin.", "error"); return; }
    if (V.bet > V.maxBet) { toast("Bet exceeds the table max of " + money(V.maxBet) + ".", "error"); return; }
    // Lock controls immediately; the spin animation begins when the server's
    // result arrives via update() (lastSpin.at changes).
    V.spinning = true;
    V.els.spinBtn.disabled = true;
    V.els.spinBtn.classList.add("is-spinning");
    clearHighlights();
    V.els.win.classList.add("hidden");
    startReelBlur();
    V.ctx.socket.gameAction({ type: "spin", bet: V.bet }).then((res) => {
      if (!res.ok) {
        // No result will arrive — stop the spin and restore controls.
        stopAllReels();
        V.spinning = false;
        V.els.spinBtn.classList.remove("is-spinning");
        refreshControls();
        toast(res.error || "Could not spin.", "error");
      }
    });
  }

  // =====================================================================
  // Render from authoritative state
  // =====================================================================
  function renderState(g) {
    // dimensions + static panels (build once)
    if (!V.cells.length || V.reels !== g.reels || V.rows !== g.rows) {
      buildGrid(g.reels || 5, g.rows || 3);
      // default a neutral grid so the machine looks alive before first spin
      for (let c = 0; c < V.reels; c++) {
        for (let r = 0; r < V.rows; r++) setCellSymbol(c, r, SYMBOL_ORDER[(c + r) % SYMBOL_ORDER.length]);
      }
    }
    if (typeof g.maxBet === "number") V.maxBet = g.maxBet;
    V.paytable = g.paytable || V.paytable;
    V.paylines = g.paylines || V.paylines;

    if (!V.els.chips.children.length) buildChips();
    syncChipState();
    renderPaytable(g.paytable);
    renderFeed(g.recentWins || []);
    refreshControls();

    // New spin result from the server -> animate reels settling onto it.
    if (g.lastSpin && g.lastSpin.at && g.lastSpin.at !== V.animatedSpinAt) {
      V.animatedSpinAt = g.lastSpin.at;
      runSpinAnimation(g.lastSpin);
    } else if (!V.spinning && g.lastSpin) {
      // Re-render of an already-shown spin (e.g. other player's state push):
      // make sure the grid + highlights reflect our last spin.
      paintGrid(g.lastSpin.grid);
    }
  }

  function refreshControls() {
    if (!V) return;
    const me = V.ctx.getMyPlayer();
    const bal = me ? me.balance : 0;
    V.els.spinBtn.disabled = V.spinning || (me && bal < V.bet);
  }

  function renderPaytable(paytable) {
    if (!paytable) return;
    const body = V.els.paytableBody;
    clear(body);
    // header
    body.appendChild(el("div", { class: "sl-pt-row sl-pt-head" }, [
      el("span", { class: "sl-pt-sym" }, "Symbol"),
      el("span", {}, "3"),
      el("span", {}, "4"),
      el("span", {}, "5"),
    ]));
    // Highest-paying first for a natural reading order.
    const order = SYMBOL_ORDER.slice().reverse();
    order.forEach((id) => {
      const row = paytable[id];
      if (!row) return;
      const meta = SYMBOL_META[id] || { glyph: "?", label: id, tint: "var(--text)" };
      body.appendChild(el("div", { class: "sl-pt-row" }, [
        el("span", { class: "sl-pt-sym" }, [
          el("span", { class: "sl-pt-glyph", style: { color: meta.tint } }, meta.glyph),
          el("span", {}, meta.label),
        ]),
        el("span", {}, "×" + (row[3] != null ? row[3] : "—")),
        el("span", {}, "×" + (row[4] != null ? row[4] : "—")),
        el("span", {}, "×" + (row[5] != null ? row[5] : "—")),
      ]));
    });
    body.appendChild(el("p", { class: "caption sl-pt-note" },
      "Multipliers apply to the per-line stake (your bet split across all 5 lines). Wild ✦ substitutes for any symbol."));
  }

  function renderFeed(wins) {
    const list = V.els.feedList;
    clear(list);
    if (!wins.length) {
      list.appendChild(el("li", { class: "sl-feed__empty caption" }, "No wins yet — be the first to hit a line."));
      return;
    }
    wins.forEach((w) => {
      list.appendChild(el("li", { class: "sl-feed__item" }, [
        el("span", { class: "sl-feed__name" }, w.name),
        el("span", { class: "sl-feed__amt" }, money(w.amount)),
      ]));
    });
  }

  // =====================================================================
  // Spin animation
  // =====================================================================
  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function startReelBlur() {
    for (let c = 0; c < V.reels; c++) {
      const reel = V.els.grid.children[c];
      if (reel) reel.classList.add("sl-reel--spinning");
    }
    // Cycle glyphs rapidly to read as motion. One shared interval drives all
    // still-spinning reels; columns are removed from the set as they settle.
    V._spinningCols = new Set();
    for (let c = 0; c < V.reels; c++) V._spinningCols.add(c);
    let tick = 0;
    const cycle = () => {
      if (!V || !V._spinningCols || !V._spinningCols.size) return;
      tick++;
      V._spinningCols.forEach((c) => {
        for (let r = 0; r < V.rows; r++) {
          const sym = SYMBOL_ORDER[(tick + c * 2 + r) % SYMBOL_ORDER.length];
          setCellSymbol(c, r, sym);
        }
      });
      V._blurTimer = setTimeout(cycle, 70);
      V.timers.push(V._blurTimer);
    };
    cycle();
  }

  function stopAllReels() {
    if (V._spinningCols) V._spinningCols.clear();
    if (V._blurTimer) clearTimeout(V._blurTimer);
    for (let c = 0; c < V.reels; c++) {
      const reel = V.els.grid.children[c];
      if (reel) reel.classList.remove("sl-reel--spinning");
    }
  }

  function paintGrid(grid) {
    if (!grid) return;
    for (let c = 0; c < V.reels && c < grid.length; c++) {
      for (let r = 0; r < V.rows && r < grid[c].length; r++) {
        setCellSymbol(c, r, grid[c][r]);
      }
    }
  }

  function runSpinAnimation(lastSpin) {
    if (!V) return;
    const grid = lastSpin.grid;
    V.spinning = true;
    V.els.spinBtn.disabled = true;
    V.els.spinBtn.classList.add("is-spinning");
    V.els.win.classList.add("hidden");
    clearHighlights();

    const settle = () => {
      stopAllReels();
      paintGrid(grid);
      V.spinning = false;
      V.els.spinBtn.classList.remove("is-spinning");
      refreshControls();
      highlightLines(lastSpin.lines || []);
      showWin(lastSpin);
    };

    if (prefersReducedMotion()) {
      // Snap instantly to the server result.
      if (V._spinningCols) V._spinningCols.clear();
      if (V._blurTimer) clearTimeout(V._blurTimer);
      settle();
      return;
    }

    // Ensure reels are visibly cycling (spin() may already have started them;
    // if the result came from elsewhere, start now).
    if (!V._spinningCols || !V._spinningCols.size) startReelBlur();

    // Settle column-by-column, left to right. ~1s total.
    const perCol = 150; // ms between columns settling
    const base = 260;   // initial blur before the first column locks
    for (let c = 0; c < V.reels; c++) {
      const t = setTimeout(() => {
        if (!V || !V._spinningCols) return;
        V._spinningCols.delete(c);
        const reel = V.els.grid.children[c];
        if (reel) {
          reel.classList.remove("sl-reel--spinning");
          reel.classList.add("sl-reel--settle");
          const done = setTimeout(() => reel.classList.remove("sl-reel--settle"), 320);
          V.timers.push(done);
        }
        for (let r = 0; r < V.rows; r++) setCellSymbol(c, r, grid[c][r]);
        if (c === V.reels - 1) settle();
      }, base + c * perCol);
      V.timers.push(t);
    }
  }

  // =====================================================================
  // Payline highlight (SVG path over the grid + cell glow)
  // =====================================================================
  function clearHighlights() {
    if (!V) return;
    clear(V.els.overlay);
    if (V.cells) {
      V.cells.forEach((col) => col.forEach((c) => {
        c.cell.classList.remove("sl-cell--win");
        c.cell.style.removeProperty("--win-color");
      }));
    }
  }

  function highlightLines(lines) {
    if (!V || !lines || !lines.length || !V.paylines) return;
    const gridRect = V.els.grid.getBoundingClientRect();
    if (!gridRect.width) return;
    // Use the grid's own pixel box as the SVG coordinate space.
    V.els.overlay.setAttribute("viewBox", "0 0 " + gridRect.width + " " + gridRect.height);
    V.els.overlay.style.width = gridRect.width + "px";
    V.els.overlay.style.height = gridRect.height + "px";

    lines.forEach((line, i) => {
      const coords = V.paylines[line.lineIndex];
      if (!coords) return;
      const color = LINE_COLORS[line.lineIndex % LINE_COLORS.length];
      // glow contributing cells (the first `count` reels of the line)
      const pts = [];
      coords.forEach(([c, r], idx) => {
        const cellObj = V.cells[c] && V.cells[c][r];
        if (!cellObj) return;
        const cr = cellObj.cell.getBoundingClientRect();
        const cx = cr.left - gridRect.left + cr.width / 2;
        const cy = cr.top - gridRect.top + cr.height / 2;
        pts.push([cx, cy]);
        if (idx < line.count) {
          cellObj.cell.classList.add("sl-cell--win");
          cellObj.cell.style.setProperty("--win-color", color);
        }
      });
      if (pts.length < 2) return;
      const d = "M " + pts.map((p) => p[0] + " " + p[1]).join(" L ");
      const path = svgEl("path", {
        d,
        class: "sl-lines__path",
        fill: "none",
        stroke: color,
        "stroke-width": "5",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      });
      // animate stroke draw (reduced-motion users get it instantly via CSS)
      path.style.setProperty("--line-delay", (i * 90) + "ms");
      V.els.overlay.appendChild(path);
    });
  }

  // =====================================================================
  // Win banner + count-up
  // =====================================================================
  function showWin(lastSpin) {
    if (!V) return;
    const win = lastSpin.win || 0;
    if (win <= 0) {
      V.els.win.classList.add("hidden");
      return;
    }
    V.els.win.classList.remove("hidden");
    V.els.win.classList.remove("sl-win--pop");
    void V.els.win.offsetWidth;
    V.els.win.classList.add("sl-win--pop");

    if (prefersReducedMotion()) {
      V.els.winAmt.textContent = money(win);
      return;
    }
    // Count up tastefully.
    if (V.countRaf) cancelAnimationFrame(V.countRaf);
    const dur = 650, t0 = performance.now();
    const step = (now) => {
      if (!V) return;
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      V.els.winAmt.textContent = money(Math.round(win * eased));
      if (p < 1) V.countRaf = requestAnimationFrame(step);
      else V.els.winAmt.textContent = money(win);
    };
    V.countRaf = requestAnimationFrame(step);
  }
})();
