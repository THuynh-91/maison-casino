/* European Roulette table UI. Logic lives in roulette-core.js (global RouletteCore). */
(function () {
  "use strict";

  const Core = window.RouletteCore;
  const { WHEEL_ORDER, colorOf } = Core;

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
    document.querySelectorAll(".cell.winning").forEach((c) => c.classList.remove("winning"));
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
  }

  function clearChipEls() {
    document.querySelectorAll(".bet-chip").forEach((c) => c.remove());
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
  let wheelAngle = 0; // rotation of the wheel
  let ballAngle = -Math.PI / 2; // ball position (screen angle)

  function pocketColor(n) {
    return colorOf(n) === "red" ? "#c1121f" : colorOf(n) === "black" ? "#1a1a1a" : "#0a6b3b";
  }

  function drawWheel() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(R, R);

    // outer rim
    ctx.beginPath();
    ctx.arc(0, 0, R - 2, 0, 2 * Math.PI);
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

    // ball (drawn in screen space, not rotated with wheel)
    const br = R - 22;
    const bx = R + br * Math.cos(ballAngle);
    const by = R + br * Math.sin(ballAngle);
    ctx.beginPath();
    ctx.arc(bx, by, 7, 0, 2 * Math.PI);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Animate so the ball ends in the pocket of `result`.
  function spinTo(result, done) {
    spinning = true;
    updateControls();
    resultBanner.classList.add("hidden");

    const idx = WHEEL_ORDER.indexOf(result);
    // Final screen angle where the winning pocket should sit (top, -PI/2).
    // wheelAngle rotates pockets; pocket idx center on screen = idx*seg - PI/2 + wheelAngle.
    // We want the ball at -PI/2 to align with pocket idx => wheelAngle_final places pocket idx at top.
    const wheelStart = wheelAngle;
    const wheelSpins = 6 * 2 * Math.PI;
    // target wheelAngle so pocket idx ends at top (-PI/2):
    const targetPocketAngle = -idx * seg; // brings pocket idx to the top reference
    const wheelEnd = wheelStart + wheelSpins + ((targetPocketAngle - wheelStart) % (2 * Math.PI));

    const ballStart = ballAngle;
    const ballSpins = -10 * 2 * Math.PI; // ball spins opposite direction
    const ballEnd = -Math.PI / 2; // settle at top
    const ballTarget = ballStart + ballSpins + (((ballEnd - ballStart) % (2 * Math.PI)) - 2 * Math.PI);

    const duration = 4200;
    const t0 = performance.now();

    function frame(now) {
      const p = Math.min((now - t0) / duration, 1);
      const e = easeOut(p);
      wheelAngle = wheelStart + (wheelEnd - wheelStart) * e;
      ballAngle = ballStart + (ballTarget - ballStart) * e;
      drawWheel();
      if (p < 1) {
        requestAnimationFrame(frame);
      } else {
        // snap exactly so the result pocket is under the ball at top
        wheelAngle = targetPocketAngle;
        ballAngle = -Math.PI / 2;
        drawWheel();
        spinning = false;
        resultBanner.classList.remove("hidden");
        done();
        updateControls();
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------- Init ----------------
  buildChips();
  buildGrid();
  buildOutside();
  drawWheel();
  updateBank();
  flash("Pick a chip, place your bets, then SPIN. Single-zero European wheel.");
})();
