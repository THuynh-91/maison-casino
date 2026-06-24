/*
 * roulette-core.js
 * Pure, dependency-free roulette logic for a EUROPEAN single-zero wheel (0-36).
 * Works in the browser (global `RouletteCore`) and in Node (module.exports / ESM via wrapper).
 *
 * Bet types and payouts (paid X-to-1, i.e. winner keeps stake + X*stake):
 *   straight  35:1   single number
 *   split     17:1   two adjacent numbers
 *   street    11:1   three numbers in a horizontal row
 *   corner     8:1   four numbers meeting at a corner
 *   line       5:1   six numbers (two adjacent streets)
 *   column     2:1   one of the three vertical columns (12 numbers)
 *   dozen      2:1   1-12, 13-24, 25-36
 *   red/black  1:1   color
 *   odd/even   1:1   parity
 *   low/high   1:1   1-18 / 19-36
 *
 * Zero (0) loses ALL outside/even-money bets (European rule, no "la partage" here).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.RouletteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Real European wheel order, clockwise starting at 0.
  const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
    24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];

  const RED_NUMBERS = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
  ]);

  function colorOf(n) {
    if (n === 0) return "green";
    return RED_NUMBERS.has(n) ? "red" : "black";
  }

  function isRed(n) {
    return RED_NUMBERS.has(n);
  }

  function isBlack(n) {
    return n !== 0 && !RED_NUMBERS.has(n);
  }

  // Payout multiplier X for "X-to-1". Total returned to a winner = stake * (X + 1).
  const PAYOUTS = {
    straight: 35,
    split: 17,
    street: 11,
    corner: 8,
    line: 5,
    column: 2,
    dozen: 2,
    red: 1,
    black: 1,
    odd: 1,
    even: 1,
    low: 1,
    high: 1,
  };

  /**
   * Returns true if a given bet wins for the spun number.
   * A bet is: { type, numbers? , amount }
   *   - inside bets (straight/split/street/corner/line) carry `numbers` (array of ints)
   *   - column/dozen carry `numbers` too (the 12 covered numbers) OR an `index` 0..2
   *   - even-money bets (red/black/odd/even/low/high) need no numbers
   */
  function betWins(bet, result) {
    switch (bet.type) {
      case "straight":
      case "split":
      case "street":
      case "corner":
      case "line":
      case "column":
      case "dozen":
        return Array.isArray(bet.numbers) && bet.numbers.includes(result);
      case "red":
        return isRed(result);
      case "black":
        return isBlack(result);
      case "odd":
        return result !== 0 && result % 2 === 1;
      case "even":
        return result !== 0 && result % 2 === 0;
      case "low":
        return result >= 1 && result <= 18;
      case "high":
        return result >= 19 && result <= 36;
      default:
        return false;
    }
  }

  /**
   * Resolve a list of bets against a result.
   * Returns:
   *   { result, totalStaked, totalReturned, netProfit, details: [{bet, won, returned}] }
   * `totalReturned` is the gross cash returned to the player for winning bets
   * (stake + winnings). Losing bets return 0. netProfit = totalReturned - totalStaked.
   */
  function resolveBets(bets, result) {
    let totalStaked = 0;
    let totalReturned = 0;
    const details = bets.map((bet) => {
      totalStaked += bet.amount;
      const won = betWins(bet, result);
      let returned = 0;
      if (won) {
        const mult = PAYOUTS[bet.type];
        returned = bet.amount * (mult + 1); // stake back + winnings
        totalReturned += returned;
      }
      return { bet, won, returned };
    });
    return {
      result,
      totalStaked,
      totalReturned,
      netProfit: totalReturned - totalStaked,
      details,
    };
  }

  // ---- Board geometry helpers (3 rows x 12 columns, European single-zero) ----
  // Layout: column-position c = ceil(n/3) (1..12). Within a column the three
  // numbers are 3c-2 (bottom), 3c-1 (middle), 3c (top). The printed row index
  // (0=bottom,1=middle,2=top) is (n-1)%3 for 1..36.

  function isOnBoard(n) {
    return Number.isInteger(n) && n >= 1 && n <= 36;
  }

  // column-position 1..12 for a number 1..36
  function columnPos(n) {
    return Math.ceil(n / 3);
  }

  // row index 0..2 (0=bottom,1=middle,2=top) for a number 1..36
  function rowIndex(n) {
    return (n - 1) % 3;
  }

  /**
   * splitNumbers(a, b): returns sorted [a,b] if a and b form a legal split
   * (horizontal neighbours in the same row, vertical neighbours in the same
   * column, or a zero-split [0,1]/[0,2]/[0,3]); otherwise null.
   */
  function splitNumbers(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a === b) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Zero-splits: 0 with the bottom edge of the first column.
    if (lo === 0) {
      return hi === 1 || hi === 2 || hi === 3 ? [0, hi] : null;
    }
    if (!isOnBoard(lo) || !isOnBoard(hi)) return null;
    // Vertical neighbours: same column-position, differ by 1.
    if (columnPos(lo) === columnPos(hi) && hi - lo === 1) {
      return [lo, hi];
    }
    // Horizontal neighbours: same printed row, adjacent columns (differ by 3).
    if (rowIndex(lo) === rowIndex(hi) && hi - lo === 3) {
      return [lo, hi];
    }
    return null;
  }

  /**
   * streetNumbers(row): the three numbers of the vertical street at
   * column-position `row` (1..12). e.g. 1 -> [1,2,3], 12 -> [34,35,36].
   * Returns null for out-of-range input.
   */
  function streetNumbers(row) {
    if (!Number.isInteger(row) || row < 1 || row > 12) return null;
    const base = (row - 1) * 3;
    return [base + 1, base + 2, base + 3];
  }

  /**
   * cornerNumbers(topLeft): the four numbers of a standard 2x2 block whose
   * smallest member is `topLeft`. e.g. 1 -> [1,2,4,5], 2 -> [2,3,5,6].
   * `topLeft` must be in the bottom or middle row (so a 2x2 block exists above
   * it) and not in the last column (so a block exists to the right).
   * Returns null otherwise.
   */
  function cornerNumbers(topLeft) {
    if (!isOnBoard(topLeft)) return null;
    // Must have a number directly above it in the same column.
    if (rowIndex(topLeft) === 2) return null; // top row has nothing above
    // Must not be in the last column (12) so the next column exists.
    if (columnPos(topLeft) >= 12) return null;
    const a = topLeft; // bottom-left of block
    const b = topLeft + 1; // directly above
    const c = topLeft + 3; // bottom-right (next column)
    const d = topLeft + 4; // top-right
    return [a, b, c, d].sort((x, y) => x - y);
  }

  /**
   * lineNumbers(row): the six numbers spanning two adjacent streets starting at
   * column-position `row` (1..11). e.g. 1 -> [1..6], 11 -> [31..36].
   * Returns null for out-of-range input.
   */
  function lineNumbers(row) {
    if (!Number.isInteger(row) || row < 1 || row > 11) return null;
    const first = streetNumbers(row);
    const second = streetNumbers(row + 1);
    return first.concat(second);
  }

  // Cryptographically-unbiased-ish spin in [0,36]. Uses crypto when available.
  function spinResult() {
    const max = 37;
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.getRandomValues) {
      const limit = Math.floor(0xffffffff / max) * max;
      const buf = new Uint32Array(1);
      let x;
      do {
        globalThis.crypto.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % max;
    }
    return Math.floor(Math.random() * max);
  }

  return {
    WHEEL_ORDER,
    RED_NUMBERS,
    PAYOUTS,
    colorOf,
    isRed,
    isBlack,
    betWins,
    resolveBets,
    spinResult,
    splitNumbers,
    streetNumbers,
    cornerNumbers,
    lineNumbers,
  };
});
