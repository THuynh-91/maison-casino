/* European Roulette table UI. Logic lives in roulette-core.js (global RouletteCore). */
(function () {
  "use strict";

  const Core = window.RouletteCore;
  const { WHEEL_ORDER, colorOf } = Core;
  const {
    splitNumbers,
    streetNumbers,
    cornerNumbers,
    lineNumbers,
  } = Core;

  // ---------------- State ----------------
  const STORAGE_KEY = "roulette.balance";
  let balance = loadBalance();
  let chipValue = 5;
  let bets = [];          // active bets: {type, numbers?, amount, key}
  let lastBets = [];      // for "rebet"
  let spinning = false;
  const history = [];

  function loadBalance() {
    const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 1000;
  }
  function saveBalance() {
    localStorage.setItem(STORAGE_KEY, String(balance));
  }

  // ---------------- DOM refs ----------------
  const balanceEl = document.getElementById("balance");
  const stakedEl = document.getElementById("staked");
  const lastwinEl = document.getElementById("lastwin");
  const messageEl = document.getElementById("message");
  const betGridEl = document.getElementById("bet-grid");
  const outsideEl = document.getElementById("outside");
  const chipsEl = document.getElementById("chips");
  const historyEl = document.getElementById("history");
  const resultBanner = document.getElementById("result-banner");
  const resultNumber = document.getElementById("result-number");
  const spinButton = document.getElementById("spin-button");
  const undoButton = document.getElementById("undo-button");
  const clearButton = document.getElementById("clear-button");
  const rebetButton = document.getElementById("rebet-button");

  // map of bet-key -> cell element, so we can highlight winners and rerender chips
  const cellByKey = new Map();
  // number (0..36) -> { el, gridCol, gridRow } captured while building the grid.
  // Used to place adjacency hotspots from real grid geometry rather than math.
  const numberCells = new Map();
  // all adjacency hotspot descriptors, kept so we can reposition on resize.
  const hotspots = [];

  // ---------------- Bet definitions ----------------
  // Column numbers (top row 3,6,..36 ; mid 2,5,..; bottom 1,4,..) matched to standard layout.
  function columnNumbers(col) {
    // col 1 -> 1,4,7...; col 2 -> 2,5,8...; col 3 -> 3,6,9...
    const out = [];
    for (let i = 0; i < 12; i++) out.push(col + i * 3);
    return out;
  }
  function dozenNumbers(d) {
    const start = (d - 1) * 12 + 1;
    return Array.from({ length: 12 }, (_, i) => start + i);
  }

  // ---------------- Build betting layout ----------------
  function buildChips() {
    const values = [1, 5, 25, 100, 500];
    values.forEach((v) => {
      const b = document.createElement("button");
      b.className = "chip" + (v === chipValue ? " selected" : "");
      b.dataset.val = v;
      b.textContent = v;
      b.addEventListener("click", () => {
        chipValue = v;
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
        b.classList.add("selected");
      });
      chipsEl.appendChild(b);
    });
  }

  function makeCell(label, opts) {
    const el = document.createElement("div");
    el.className = "cell" + (opts.cls ? " " + opts.cls : "");
    el.textContent = label;
    el.dataset.key = opts.key;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", "Bet " + label);
    el.addEventListener("click", () => placeBet(opts.bet, opts.key, el));
    // keyboard: Enter/Space places a chip
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        placeBet(opts.bet, opts.key, el);
      }
    });
    // right-click removes one chip from this cell (QoL)
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeChipFrom(opts.key);
    });
    cellByKey.set(opts.key, el);
    return el;
  }

  function buildGrid() {
    // Zero
    const zero = makeCell("0", {
      cls: "green zero",
      key: "straight:0",
      bet: { type: "straight", numbers: [0] },
    });
    zero.style.gridRow = "1 / span 3";
    zero.style.gridColumn = "1";
    betGridEl.appendChild(zero);
    numberCells.set(0, { el: zero, gridCol: 1, gridRow: 1 });

    // Numbers 1-36. Visual: 3 rows x 12 cols. Top row = 3,6,9... bottom = 1,4,7...
    // Grid rows are placed top(3n) -> row1, mid(3n-1) -> row2, bottom(3n-2) -> row3.
    for (let n = 1; n <= 36; n++) {
      const colIndex = Math.ceil(n / 3);        // 1..12  (table column position)
      const rowFromBottom = ((n - 1) % 3);       // 0=bottom,1=mid,2=top
      const gridRow = 3 - rowFromBottom;         // 1..3 (1=top)
      const cell = makeCell(String(n), {
        cls: colorOf(n),
        key: "straight:" + n,
        bet: { type: "straight", numbers: [n] },
      });
      cell.style.gridColumn = String(colIndex + 1); // +1 because col 1 is zero
      cell.style.gridRow = String(gridRow);
      betGridEl.appendChild(cell);
      numberCells.set(n, { el: cell, gridCol: colIndex + 1, gridRow });
    }

    // Column bets (2:1) at far right, one per row.
    // Right column maps to table column 3 (top row, numbers 3,6,...36), etc.
    for (let gridRow = 1; gridRow <= 3; gridRow++) {
      const tableCol = 3 - (gridRow - 1); // row1(top)->col3, row2->col2, row3->col1
      const nums = columnNumbers(tableCol);
      const cell = makeCell("2:1", {
        cls: "col-bet",
        key: "column:" + tableCol,
        bet: { type: "column", numbers: nums },
      });
      cell.style.gridColumn = "14";
      cell.style.gridRow = String(gridRow);
      betGridEl.appendChild(cell);
    }
  }

  // ---------------- Adjacency bet hotspots ----------------
  // We overlay thin/small transparent zones on the gridlines between number
  // cells. Each zone is a real, focusable bet element registered in cellByKey
  // so it gets win-highlighting and chip rendering exactly like a cell.
  //
  // Geometry is read from the live grid (cell.offsetLeft/Top/Width/Height,
  // relative to the position:relative .bet-grid). The *covered numbers* come
  // straight from RouletteCore's geometry helpers so they can never drift from
  // the resolver's own definitions.
  //
  // Key scheme (chosen to be deterministic and tied to the numbers, so
  // highlightWinners — which matches winning bets by key — lights the right
  // zone):
  //   split:a-b   a<b           e.g. "split:1-2", "split:1-4", "split:0-1"
  //   street:c    c=colPos 1-12 e.g. "street:1"  -> [1,2,3]
  //   corner:tl   tl=block min  e.g. "corner:1"  -> [1,2,4,5]
  //   line:c      c=start 1-11  e.g. "line:1"    -> [1,2,3,4,5,6]
  //   basket                    -> [0,1,2,3] (first four)

  // grid-position lookups for a number cell (filled by buildGrid)
  function posOf(n) { return numberCells.get(n); }

  function makeHotspot(spec) {
    // spec: { key, label, bet, place(el) -> sets geometry; recompute fn }
    const el = document.createElement("div");
    el.className = "hotspot";
    el.dataset.key = spec.key;
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", spec.label);
    el.title = spec.label;
    el.addEventListener("click", () => placeBet(spec.bet, spec.key, el));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        placeBet(spec.bet, spec.key, el);
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      removeChipFrom(spec.key);
    });
    cellByKey.set(spec.key, el);
    betGridEl.appendChild(el);
    const hs = { el, spec };
    hotspots.push(hs);
    return hs;
  }

  // Rectangle (relative to .bet-grid) for a number's cell.
  function rectOf(n) {
    const info = numberCells.get(n);
    if (!info) return null;
    const el = info.el;
    return {
      left: el.offsetLeft,
      top: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
      right: el.offsetLeft + el.offsetWidth,
      bottom: el.offsetTop + el.offsetHeight,
      cx: el.offsetLeft + el.offsetWidth / 2,
      cy: el.offsetTop + el.offsetHeight / 2,
    };
  }

  // Hit-area sizing. Coarse pointers get fatter zones for easier tapping.
  function hotspotThickness() {
    return window.matchMedia("(hover: none), (pointer: coarse)").matches ? 22 : 16;
  }

  // Position every hotspot from current cell geometry. Re-run on resize.
  function positionHotspots() {
    const t = hotspotThickness();
    const corner = Math.max(t, 20); // corner/line clickable square side
    hotspots.forEach(({ el, spec }) => spec.place(el, t, corner));
  }

  function buildHotspots() {
    // ---- SPLITS ----------------------------------------------------------
    // Enumerate neighbour pairs from grid geometry. Two number cells are
    // neighbours when they touch on the grid: same gridRow & adjacent gridCol
    // (vertical border) OR same gridCol & adjacent gridRow (horizontal border).
    for (let n = 1; n <= 36; n++) {
      const a = posOf(n);
      for (let m = n + 1; m <= 36; m++) {
        const b = posOf(m);
        const sameRow = a.gridRow === b.gridRow;
        const sameCol = a.gridCol === b.gridCol;
        const adjCol = Math.abs(a.gridCol - b.gridCol) === 1;
        const adjRow = Math.abs(a.gridRow - b.gridRow) === 1;
        const verticalBorder = sameRow && adjCol;   // side-by-side cells, e.g. 1&4
        const horizontalBorder = sameCol && adjRow; // stacked cells,      e.g. 1&2
        if (!verticalBorder && !horizontalBorder) continue;
        const nums = splitNumbers(n, m); // cross-check with core; null if not legal
        if (!nums) continue;
        const lo = nums[0], hi = nums[1];
        const key = "split:" + lo + "-" + hi;
        makeHotspot({
          key,
          label: "Split " + lo + " and " + hi,
          bet: { type: "split", numbers: nums },
          place: (el, t) => {
            const ra = rectOf(lo), rb = rectOf(hi);
            if (verticalBorder) {
              // boundary x = midpoint between the two cells' touching edges
              const x = (Math.min(ra.right, rb.right) + Math.max(ra.left, rb.left)) / 2;
              const top = Math.min(ra.top, rb.top);
              const h = Math.max(ra.bottom, rb.bottom) - top;
              el.style.left = (x - t / 2) + "px";
              el.style.top = top + "px";
              el.style.width = t + "px";
              el.style.height = h + "px";
            } else {
              // horizontal border: boundary y between stacked cells
              const y = (Math.min(ra.bottom, rb.bottom) + Math.max(ra.top, rb.top)) / 2;
              const left = Math.min(ra.left, rb.left);
              const w = Math.max(ra.right, rb.right) - left;
              el.style.left = left + "px";
              el.style.top = (y - t / 2) + "px";
              el.style.width = w + "px";
              el.style.height = t + "px";
            }
          },
        });
      }
    }

    // ---- ZERO SPLITS (0&1, 0&2, 0&3) ------------------------------------
    [1, 2, 3].forEach((hi) => {
      const nums = splitNumbers(0, hi);
      if (!nums) return;
      const key = "split:0-" + hi;
      makeHotspot({
        key,
        label: "Split 0 and " + hi,
        bet: { type: "split", numbers: nums },
        place: (el, t) => {
          const rz = rectOf(0), rn = rectOf(hi);
          // vertical border between zero (left) and the number cell (right)
          const x = (rz.right + rn.left) / 2;
          el.style.left = (x - t / 2) + "px";
          el.style.top = rn.top + "px";
          el.style.width = t + "px";
          el.style.height = rn.height + "px";
        },
      });
    });

    // ---- STREETS (outer bottom edge of each column-of-3) -----------------
    for (let c = 1; c <= 12; c++) {
      const nums = streetNumbers(c); // [3c-2, 3c-1, 3c]
      const bottomNum = nums[0];     // bottom row member (gridRow 3)
      const key = "street:" + c;
      makeHotspot({
        key,
        label: "Street " + nums.join(", "),
        bet: { type: "street", numbers: nums },
        place: (el, t) => {
          const r = rectOf(bottomNum);
          el.style.left = r.left + "px";
          el.style.top = (r.bottom - t / 2) + "px";
          el.style.width = r.width + "px";
          el.style.height = t + "px";
        },
      });
    }

    // ---- CORNERS (point where four cells meet) ---------------------------
    // The four-cell block's smallest number is the bottom-left. Place a small
    // square centered on the top-right corner of that bottom-left cell, which
    // is exactly where all four cells touch.
    for (let tl = 1; tl <= 36; tl++) {
      const nums = cornerNumbers(tl);
      if (!nums) continue; // not a valid 2x2 anchor
      const key = "corner:" + tl;
      makeHotspot({
        key,
        label: "Corner " + nums.join(", "),
        bet: { type: "corner", numbers: nums },
        place: (el, t, corner) => {
          const r = rectOf(tl); // bottom-left cell of the block
          // shared point: cell's right edge, cell's top edge
          const px = r.right;
          const py = r.top;
          el.style.left = (px - corner / 2) + "px";
          el.style.top = (py - corner / 2) + "px";
          el.style.width = corner + "px";
          el.style.height = corner + "px";
        },
      });
    }

    // ---- LINES / six-line (outer bottom edge between two streets) --------
    for (let c = 1; c <= 11; c++) {
      const nums = lineNumbers(c); // [3c-2 .. 3c+3]
      const leftBottom = streetNumbers(c)[0];      // bottom cell of left street
      const rightBottom = streetNumbers(c + 1)[0]; // bottom cell of right street
      const key = "line:" + c;
      makeHotspot({
        key,
        label: "Six line " + nums[0] + " to " + nums[5],
        bet: { type: "line", numbers: nums },
        place: (el, t) => {
          const rl = rectOf(leftBottom), rr = rectOf(rightBottom);
          // x at the shared vertical boundary between the two streets, y on the
          // outer bottom edge of the bottom row.
          const x = (rl.right + rr.left) / 2;
          const top = Math.max(rl.bottom, rr.bottom) - t / 2;
          el.style.left = (x - t / 2) + "px";
          el.style.top = top + "px";
          el.style.width = t + "px";
          el.style.height = t + "px";
        },
      });
    }

    // ---- BASKET / first four (0,1,2,3) -----------------------------------
    // Where zero's right edge meets the bottom street boundary of column 1.
    {
      const key = "basket";
      makeHotspot({
        key,
        label: "First four 0, 1, 2, 3",
        bet: { type: "corner", numbers: [0, 1, 2, 3] },
        place: (el, t, corner) => {
          const rz = rectOf(0), r1 = rectOf(1);
          const px = (rz.right + r1.left) / 2; // boundary between zero and col 1
          const py = r1.bottom;                // outer bottom edge
          el.style.left = (px - corner / 2) + "px";
          el.style.top = (py - corner / 2) + "px";
          el.style.width = corner + "px";
          el.style.height = corner + "px";
        },
      });
    }

    positionHotspots();
    // Reposition when the layout reflows (responsive breakpoints, rotation).
    window.addEventListener("resize", positionHotspots);
  }

  function buildOutside() {
    // Dozens
    [
      ["1st 12", 1],
      ["2nd 12", 2],
      ["3rd 12", 3],
    ].forEach(([label, d]) => {
      outsideEl.appendChild(
        makeCell(label, {
          cls: "dozen",
          key: "dozen:" + d,
          bet: { type: "dozen", numbers: dozenNumbers(d) },
        })
      );
    });

    // Even-money row: 1-18, EVEN, RED, BLACK, ODD, 19-36
    const evens = [
      ["1-18", "low", ""],
      ["EVEN", "even", ""],
      ["RED", "red", "swatch-red"],
      ["BLACK", "black", "swatch-black"],
      ["ODD", "odd", ""],
      ["19-36", "high", ""],
    ];
    evens.forEach(([label, type, cls]) => {
      outsideEl.appendChild(
        makeCell(label, { cls, key: type, bet: { type } })
      );
    });
  }

  // ---------------- Bet placement ----------------
  function placeBet(betDef, key, el) {
    if (spinning) return;
    if (balance < chipValue) {
      flash("Not enough balance for a $" + chipValue + " chip. Pick a smaller chip.", "lose");
      return;
    }
    clearWinHighlights();
    balance -= chipValue;
    const existing = bets.find((b) => b.key === key);
    if (existing) {
      existing.amount += chipValue;
    } else {
      bets.push(Object.assign({}, betDef, { amount: chipValue, key }));
    }
    renderChipOn(el, key);
    updateBank();
  }

  // remove one chip's worth from a specific cell (right-click)
  function removeChipFrom(key) {
    if (spinning) return;
    const bet = bets.find((b) => b.key === key);
    if (!bet) return;
    const dec = Math.min(chipValue, bet.amount);
    bet.amount -= dec;
    balance += dec;
    if (bet.amount <= 0) bets = bets.filter((b) => b !== bet);
    rerenderAllChips();
    updateBank();
  }

  function clearWinHighlights() {
    document
      .querySelectorAll(".cell.winning, .hotspot.winning")
      .forEach((c) => c.classList.remove("winning"));
  }

  function renderChipOn(el, key) {
    const bet = bets.find((b) => b.key === key);
    let chip = el.querySelector(".bet-chip");
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "bet-chip";
      el.appendChild(chip);
    }
    chip.textContent = bet ? bet.amount : "";
    if (!bet && chip) chip.remove();
    // hotspots get a subtle "occupied" tint while they carry a chip
    if (el.classList.contains("hotspot")) {
      el.classList.toggle("has-chip", !!bet);
    }
  }

  function clearChipEls() {
    document.querySelectorAll(".bet-chip").forEach((c) => c.remove());
    document.querySelectorAll(".hotspot.has-chip").forEach((h) => h.classList.remove("has-chip"));
  }

  function totalStaked() {
    return bets.reduce((s, b) => s + b.amount, 0);
  }

  function updateBank(flashKind) {
    balanceEl.textContent = "$" + balance;
    const staked = totalStaked();
    stakedEl.textContent = "$" + staked;
    stakedEl.classList.toggle("active", staked > 0);
    balanceEl.classList.toggle("low", balance < 100);
    if (flashKind) {
      balanceEl.classList.remove("flash-win", "flash-lose");
      // force reflow so the animation restarts each spin
      void balanceEl.offsetWidth;
      balanceEl.classList.add(flashKind === "win" ? "flash-win" : "flash-lose");
    }
    saveBalance();
    updateControls();
  }

  // enable/disable controls based on current state
  function updateControls() {
    const hasBets = bets.length > 0;
    spinButton.disabled = spinning || !hasBets;
    spinButton.title = hasBets ? "Spin the wheel" : "Place a bet to spin";
    undoButton.disabled = spinning || !hasBets;
    clearButton.disabled = spinning || !hasBets;
    rebetButton.disabled =
      spinning ||
      lastBets.length === 0 ||
      balance < lastBets.reduce((s, b) => s + b.amount, 0);
  }

  // ---------------- Controls ----------------
  clearButton.addEventListener("click", () => {
    if (spinning || bets.length === 0) return;
    balance += totalStaked();
    bets = [];
    clearChipEls();
    clearWinHighlights();
    updateBank();
    flash("Bets cleared.");
  });

  undoButton.addEventListener("click", () => {
    if (spinning || bets.length === 0) return;
    const last = bets[bets.length - 1];
    // remove one chip's worth (capped to the bet amount) from the most recently touched bet
    const dec = Math.min(chipValue, last.amount);
    last.amount -= dec;
    balance += dec;
    if (last.amount <= 0) bets.pop();
    rerenderAllChips();
    updateBank();
  });

  rebetButton.addEventListener("click", () => {
    if (spinning || lastBets.length === 0) return;
    const cost = lastBets.reduce((s, b) => s + b.amount, 0);
    if (balance < cost) {
      flash("Not enough balance to rebet.", "lose");
      return;
    }
    clearWinHighlights();
    balance -= cost;
    bets = lastBets.map((b) => Object.assign({}, b));
    rerenderAllChips();
    updateBank();
    flash("Rebet placed.");
  });

  function rerenderAllChips() {
    clearChipEls();
    bets.forEach((b) => {
      const el = cellByKey.get(b.key);
      if (el) renderChipOn(el, b.key);
    });
  }

  // ---------------- Spin ----------------
  function doSpin() {
    if (spinning) return;
    if (bets.length === 0) {
      flash("Place a bet first.", "lose");
      return;
    }
    clearWinHighlights();
    const staked = totalStaked();
    const result = Core.spinResult();
    lastBets = bets.map((b) => Object.assign({}, b));
    flash("No more bets — round in play. ($" + staked + " on the table)");
    spinTo(result, () => resolve(result, staked));
  }
  spinButton.addEventListener("click", doSpin);

  // keyboard: Space spins (unless focus is on another control)
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && !spinning && document.activeElement === document.body) {
      e.preventDefault();
      doSpin();
    }
  });

  function resolve(result, staked) {
    const outcome = Core.resolveBets(bets, result);
    balance += outcome.totalReturned;
    lastwinEl.textContent = "$" + outcome.totalReturned;

    highlightWinners(outcome, result);
    pushHistory(result);
    showBanner(result);

    const won = outcome.netProfit > 0;
    if (won) {
      flash("Number " + result + " (" + colorOf(result) + "). You won $" + outcome.netProfit + " net!", "win");
    } else if (outcome.netProfit === 0) {
      flash("Number " + result + " (" + colorOf(result) + "). You broke even.", null);
    } else {
      flash("Number " + result + " (" + colorOf(result) + "). You lost $" + Math.abs(outcome.netProfit) + ".", "lose");
    }

    bets = [];
    clearChipEls();
    let busted = false;
    if (balance <= 0) {
      balance = 1000;
      busted = true;
    }
    updateBank(won ? "win" : "lose");
    if (busted) flash("Busted! Topping you back up to $1000.", "lose");
  }

  // ring the winning straight number and every winning outside/inside bet cell
  function highlightWinners(outcome, result) {
    const numKey = "straight:" + result;
    const numCell = cellByKey.get(numKey);
    if (numCell) numCell.classList.add("winning");
    outcome.details.forEach((d) => {
      if (d.won) {
        const cell = cellByKey.get(d.bet.key);
        if (cell) cell.classList.add("winning");
      }
    });
  }

  function flash(msg, kind) {
    messageEl.textContent = msg;
    messageEl.className = "message" + (kind ? " " + kind : "");
  }

  function pushHistory(result) {
    history.unshift(result);
    if (history.length > 14) history.pop();
    historyEl.innerHTML = "";
    history.forEach((n) => {
      const d = document.createElement("div");
      d.className = "h " + colorOf(n);
      d.textContent = n;
      historyEl.appendChild(d);
    });
  }

  function showBanner(result) {
    resultBanner.className = "result-banner " + colorOf(result);
    resultNumber.textContent = result;
    // restart the pop animation each spin
    resultBanner.style.animation = "none";
    void resultBanner.offsetWidth;
    resultBanner.style.animation = "";
  }

  // ---------------- Wheel rendering & animation ----------------
  const canvas = document.getElementById("roulette-wheel");
  const ctx = canvas.getContext("2d");
  const R = canvas.width / 2;
  const N = WHEEL_ORDER.length; // 37
  const seg = (2 * Math.PI) / N;
  let wheelAngle = 0; // rotation of the wheel (radians)
  // Ball state, expressed in SCREEN space.
  let ballAngle = -Math.PI / 2; // ball angular position on its orbit (screen angle)
  let ballRadius = R - 18;      // current orbit radius (distance from center)

  // Geometry constants for the ball's orbit / drop.
  const RIM_RADIUS = R - 10;        // outer track the ball starts on
  const POCKET_RADIUS = R - 26;     // radius at which the ball rests inside a pocket
  const BALL_SIZE = 6.5;

  function pocketColor(n) {
    return colorOf(n) === "red" ? "#c1121f" : colorOf(n) === "black" ? "#1a1a1a" : "#0a6b3b";
  }

  // Screen-space angle of the CENTER of pocket index `idx` given current wheelAngle.
  function pocketScreenAngle(idx) {
    return idx * seg - Math.PI / 2 + wheelAngle;
  }

  function drawWheel() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(R, R);

    // outer ball track (the lip the ball rolls on)
    ctx.beginPath();
    ctx.arc(0, 0, R - 2, 0, 2 * Math.PI);
    ctx.fillStyle = "#241708";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, R - 8, 0, 2 * Math.PI);
    ctx.fillStyle = "#3a2a12";
    ctx.fill();

    ctx.rotate(wheelAngle);
    for (let i = 0; i < N; i++) {
      const n = WHEEL_ORDER[i];
      const start = i * seg - Math.PI / 2 - seg / 2;
      const end = start + seg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R - 14, start, end);
      ctx.closePath();
      ctx.fillStyle = pocketColor(n);
      ctx.fill();
      ctx.strokeStyle = "rgba(231,200,115,.6)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // fret (divider) between pockets, drawn as a small raised tick
      ctx.save();
      ctx.rotate(start);
      ctx.fillStyle = "rgba(231,200,115,.85)";
      ctx.fillRect(R - 16, -1, 14, 2);
      ctx.restore();

      // number label
      ctx.save();
      ctx.rotate(start + seg / 2);
      ctx.translate(R - 28, 0);
      ctx.rotate(Math.PI / 2);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px Arial";
      ctx.textAlign = "center";
      ctx.fillText(String(n), 0, 0);
      ctx.restore();
    }

    // hub
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.45, 0, 2 * Math.PI);
    ctx.fillStyle = "#0a6b3b";
    ctx.fill();
    ctx.strokeStyle = "#e7c873";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.22, 0, 2 * Math.PI);
    ctx.fillStyle = "#111";
    ctx.fill();
    ctx.strokeStyle = "#e7c873";
    ctx.stroke();
    ctx.restore();

    // ball (drawn in screen space; angle & radius are animated)
    const bx = R + ballRadius * Math.cos(ballAngle);
    const by = R + ballRadius * Math.sin(ballAngle);
    // subtle drop shadow toward center for depth
    ctx.beginPath();
    ctx.arc(bx, by, BALL_SIZE, 0, 2 * Math.PI);
    const grad = ctx.createRadialGradient(
      bx - 2, by - 2, 0.5,
      bx, by, BALL_SIZE
    );
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(1, "#c9c9c9");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function clamp01(t) {
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  // Animate a physical-looking spin that ends with the ball resting in the
  // pocket of `result`, with that pocket under the top pointer.
  function spinTo(result, done) {
    spinning = true;
    updateControls();
    resultBanner.classList.add("hidden");

    const idx = WHEEL_ORDER.indexOf(result);

    // --- Wheel motion: spins clockwise (positive), decelerating (ease-out). ---
    const wheelStart = wheelAngle;
    // Final wheelAngle must place pocket idx at the top pointer (-PI/2):
    //   pocketScreenAngle(idx) === -PI/2  =>  idx*seg - PI/2 + wheelAngle === -PI/2 (mod 2PI)
    //   => wheelAngle === -idx*seg (mod 2PI)
    const wheelRevs = 5; // full turns before settling
    const desiredFinalMod = (((-idx * seg) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let curMod = ((wheelStart % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let delta = desiredFinalMod - curMod;
    if (delta < 0) delta += 2 * Math.PI; // always move forward (clockwise)
    const wheelEnd = wheelStart + wheelRevs * 2 * Math.PI + delta;

    const duration = 6000;          // ~6s spin
    const spiralStart = 0.55;       // when the ball begins spiraling inward
    const dropStart = 0.82;         // when the ball is captured by the pocket
    const startRadius = RIM_RADIUS;
    ballRadius = startRadius;

    // --- Ball motion: orbits OPPOSITE direction (counter-clockwise), faster,
    //     then spirals inward and is CAPTURED by pocket idx at `dropStart`.
    //
    // The handoff at `dropStart` must be seamless: the free orbit has to arrive
    // exactly at the pocket's screen position at that instant, so the ball never
    // teleports. We compute where pocket idx will be on screen at p=dropStart
    // (the wheel has completed easeOutCubic(dropStart) of its travel by then),
    // then solve for a ball end-angle that lands there going counter-clockwise
    // with several full revolutions. After capture the ball simply tracks the
    // live pocket angle (which equals that same value at the boundary). ---
    const ballStart = ballAngle;
    const wheelAtDrop = wheelStart + (wheelEnd - wheelStart) * easeOutCubic(dropStart);
    const pocketAngleAtDrop = idx * seg - Math.PI / 2 + wheelAtDrop; // pocketScreenAngle at drop
    const ballRevs = 9; // counter-clockwise revolutions (negative direction)
    // Total signed travel from ballStart to the capture angle, forced negative
    // (counter-clockwise) and padded with whole revolutions.
    let ballRaw = (pocketAngleAtDrop - ballStart) % (2 * Math.PI);
    // bring into (-2PI, 0] so the short way is counter-clockwise
    ballRaw = ((ballRaw % (2 * Math.PI)) - 2 * Math.PI) % (2 * Math.PI);
    const ballCaptureAngle = ballStart - ballRevs * 2 * Math.PI + ballRaw;
    // Fraction of the ease curve consumed by the time we reach the capture point.
    const eAtDrop = easeOutCubic(dropStart);

    const t0 = performance.now();

    function frame(now) {
      const p = clamp01((now - t0) / duration);
      const e = easeOutCubic(p);

      // Wheel: smooth ease-out the whole way.
      wheelAngle = wheelStart + (wheelEnd - wheelStart) * e;

      if (p < dropStart) {
        // Phase 1+2: ball orbits freely (counter-clockwise) and spirals inward.
        // Drive the angle by the same ease curve but RE-SCALED so it reaches the
        // capture angle exactly at p=dropStart (e == eAtDrop), guaranteeing a
        // continuous handoff into the capture phase below.
        const eFrac = e / eAtDrop; // 0..1 across phase 1+2
        ballAngle = ballStart + (ballCaptureAngle - ballStart) * eFrac;
        let rT = clamp01((p - spiralStart) / (dropStart - spiralStart));
        rT = easeOutCubic(rT);
        ballRadius = startRadius + (POCKET_RADIUS + 5 - startRadius) * rT;
      } else {
        // Phase 3: ball is captured by pocket idx — it now rides WITH the wheel.
        // Its angle is the live pocket screen angle (which equals ballCaptureAngle,
        // mod 2PI, at the boundary), plus a damped bounce that grows then dies,
        // and a small inward settle of the last few px.
        const dT = clamp01((p - dropStart) / (1 - dropStart));
        const de = easeOutCubic(dT);
        const pocketAng = pocketScreenAngle(idx);
        // rattle: a bounce that eases in from zero, then decays — feels like the
        // ball knocking against the fret before settling. Zero at dT=0 and dT=1.
        const rattle = Math.sin(dT * Math.PI) * (1 - dT) * 0.05 * Math.cos(dT * Math.PI * 6);
        ballAngle = pocketAng + rattle;
        ballRadius = (POCKET_RADIUS + 5) + (POCKET_RADIUS - (POCKET_RADIUS + 5)) * de;
      }

      drawWheel();

      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        // Snap exactly so the result pocket sits under the pointer with the ball in it.
        wheelAngle = wheelStart + (wheelEnd - wheelStart); // == wheelEnd
        ballAngle = pocketScreenAngle(idx); // == -PI/2 (top)
        ballRadius = POCKET_RADIUS;
        drawWheel();
        spinning = false;
        resultBanner.classList.remove("hidden");
        // Debug hook (used by tests/tools): which pocket is currently under the
        // top pointer, and where the ball sits. Harmless in production.
        window.__rouletteDebug = {
          wheelAngle,
          ballAngle,
          ballRadius,
          pocketUnderPointer: pocketUnderPointer(),
          ballPocket: ballPocketIndex(),
          result,
        };
        done();
        updateControls();
      }
    }
    requestAnimationFrame(frame);
  }

  // Index of the pocket whose center is nearest the top pointer (-PI/2).
  function pocketUnderPointer() {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      let d = Math.abs(angDiff(pocketScreenAngle(i), -Math.PI / 2));
      if (d < bestD) { bestD = d; best = i; }
    }
    return WHEEL_ORDER[best];
  }
  // Index of the pocket the ball currently sits over (by angle).
  function ballPocketIndex() {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      let d = Math.abs(angDiff(pocketScreenAngle(i), ballAngle));
      if (d < bestD) { bestD = d; best = i; }
    }
    return WHEEL_ORDER[best];
  }
  function angDiff(a, b) {
    let d = (a - b) % (2 * Math.PI);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // ---------------- Init ----------------
  buildChips();
  buildGrid();
  buildHotspots();
  buildOutside();
  drawWheel();
  updateBank();
  flash("Pick a chip, place your bets, then SPIN. Single-zero European wheel.");
  // Re-measure once the grid has fully laid out (fonts, flexible columns).
  requestAnimationFrame(positionHotspots);
  window.addEventListener("load", positionHotspots);
})();
