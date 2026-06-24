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
  };
});
