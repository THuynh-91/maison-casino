"use strict";
/*
 * Pure 7-card poker hand evaluator. No engine/room dependencies — just card
 * strings ("As", "Td", "9c") in, comparable scores out.
 *
 * A "score" is { rank, tiebreak, name } where:
 *   rank      — category 0..8 (0 high card .. 8 straight flush), bigger wins.
 *   tiebreak  — array of numbers (rank values 2..14) compared lexicographically
 *               within the same category; bigger wins. The array is laid out so
 *               the most significant comparison comes first (e.g. for a full
 *               house it's [tripsRank, pairRank]; for two pair [hiPair, loPair,
 *               kicker]; for high card / flush the five card ranks descending).
 *   name      — human-readable category name.
 *
 * compareHands(a, b) returns -1/0/1 (a worse / equal / a better). It accepts
 * either raw card arrays or pre-computed score objects.
 *
 * Wheel straights: A-2-3-4-5 is the lowest straight; the Ace plays LOW and the
 * straight's high card is the 5, so a wheel loses to 2-3-4-5-6. We represent the
 * wheel's tiebreak high as 5 (Ace counts as 1) so ordering falls out naturally.
 */

const { rankOf, suitOf, rankValue } = require("./cards");

// Category ranks.
const HIGH_CARD = 0;
const ONE_PAIR = 1;
const TWO_PAIR = 2;
const THREE_KIND = 3;
const STRAIGHT = 4;
const FLUSH = 5;
const FULL_HOUSE = 6;
const FOUR_KIND = 7;
const STRAIGHT_FLUSH = 8;

const CATEGORY_NAMES = {
  [HIGH_CARD]: "High Card",
  [ONE_PAIR]: "One Pair",
  [TWO_PAIR]: "Two Pair",
  [THREE_KIND]: "Three of a Kind",
  [STRAIGHT]: "Straight",
  [FLUSH]: "Flush",
  [FULL_HOUSE]: "Full House",
  [FOUR_KIND]: "Four of a Kind",
  [STRAIGHT_FLUSH]: "Straight Flush",
};

// Given a sorted-descending array of UNIQUE rank values, find the highest
// straight contained in it (5 consecutive). Handles the wheel (A treated as 1).
// Returns the straight's high-card value (e.g. 5 for the wheel, 14 for broadway)
// or null if none.
function findStraightHigh(uniqDescVals) {
  // Work on a set for O(1) membership; add the low-Ace (1) if an Ace is present.
  const present = new Set(uniqDescVals);
  if (present.has(14)) present.add(1);
  // Check from the highest possible top (Ace high = 14) down to 5 (wheel top).
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let v = high; v > high - 5; v--) {
      if (!present.has(v)) {
        ok = false;
        break;
      }
    }
    if (ok) return high;
  }
  return null;
}

// Evaluate exactly the best 5-card hand out of `cards` (length up to 7).
// Returns a score object.
function evaluate7(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    throw new Error("evaluate7: need at least 5 cards");
  }

  // Rank value -> count, and suit -> list of rank values.
  const counts = new Map(); // rankVal -> count
  const bySuit = { s: [], h: [], d: [], c: [] };
  for (const card of cards) {
    const v = rankValue(card);
    counts.set(v, (counts.get(v) || 0) + 1);
    bySuit[suitOf(card)].push(v);
  }

  // ---- Flush / straight-flush detection ----
  let flushSuit = null;
  for (const s of ["s", "h", "d", "c"]) {
    if (bySuit[s].length >= 5) {
      flushSuit = s;
      break; // only one suit can have >=5 in a 7-card hand
    }
  }

  if (flushSuit) {
    // Straight flush? Look for a straight WITHIN the flush suit's cards.
    const flushVals = bySuit[flushSuit].slice().sort((a, b) => b - a);
    const uniqFlush = [...new Set(flushVals)];
    const sfHigh = findStraightHigh(uniqFlush);
    if (sfHigh !== null) {
      return { rank: STRAIGHT_FLUSH, tiebreak: [sfHigh], name: CATEGORY_NAMES[STRAIGHT_FLUSH] };
    }
  }

  // ---- Group ranks by count for pairs/trips/quads ----
  // groups: array of [rankVal, count] sorted by count desc, then rankVal desc.
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });

  const counts4 = groups.filter((g) => g[1] === 4).map((g) => g[0]);
  const counts3 = groups.filter((g) => g[1] === 3).map((g) => g[0]);
  const counts2 = groups.filter((g) => g[1] === 2).map((g) => g[0]);
  const counts1 = groups.filter((g) => g[1] === 1).map((g) => g[0]);

  // All distinct rank values sorted descending (for kickers / straights).
  const allDesc = [...counts.keys()].sort((a, b) => b - a);

  // ---- Four of a kind ----
  if (counts4.length) {
    const quad = counts4[0];
    // Best kicker = highest remaining single card across all other cards.
    const kicker = allDesc.find((v) => v !== quad);
    return {
      rank: FOUR_KIND,
      tiebreak: [quad, kicker],
      name: CATEGORY_NAMES[FOUR_KIND],
    };
  }

  // ---- Full house (trips + a pair; or two sets of trips) ----
  if (counts3.length >= 1 && (counts3.length >= 2 || counts2.length >= 1)) {
    const trips = counts3[0];
    // Best pair = the next-best trip used as a pair, or the best actual pair.
    let pair;
    if (counts3.length >= 2) pair = counts3[1];
    if (counts2.length >= 1) {
      if (pair === undefined || counts2[0] > pair) pair = counts2[0];
    }
    return {
      rank: FULL_HOUSE,
      tiebreak: [trips, pair],
      name: CATEGORY_NAMES[FULL_HOUSE],
    };
  }

  // ---- Flush (no straight flush) ----
  if (flushSuit) {
    const flushVals = bySuit[flushSuit].slice().sort((a, b) => b - a);
    return {
      rank: FLUSH,
      tiebreak: flushVals.slice(0, 5),
      name: CATEGORY_NAMES[FLUSH],
    };
  }

  // ---- Straight ----
  const straightHigh = findStraightHigh(allDesc);
  if (straightHigh !== null) {
    return { rank: STRAIGHT, tiebreak: [straightHigh], name: CATEGORY_NAMES[STRAIGHT] };
  }

  // ---- Three of a kind ----
  if (counts3.length >= 1) {
    const trips = counts3[0];
    const kickers = allDesc.filter((v) => v !== trips).slice(0, 2);
    return {
      rank: THREE_KIND,
      tiebreak: [trips, ...kickers],
      name: CATEGORY_NAMES[THREE_KIND],
    };
  }

  // ---- Two pair ----
  if (counts2.length >= 2) {
    const hi = counts2[0];
    const lo = counts2[1];
    const kicker = allDesc.find((v) => v !== hi && v !== lo);
    return {
      rank: TWO_PAIR,
      tiebreak: [hi, lo, kicker],
      name: CATEGORY_NAMES[TWO_PAIR],
    };
  }

  // ---- One pair ----
  if (counts2.length === 1) {
    const pair = counts2[0];
    const kickers = allDesc.filter((v) => v !== pair).slice(0, 3);
    return {
      rank: ONE_PAIR,
      tiebreak: [pair, ...kickers],
      name: CATEGORY_NAMES[ONE_PAIR],
    };
  }

  // ---- High card ----
  return {
    rank: HIGH_CARD,
    tiebreak: allDesc.slice(0, 5),
    name: CATEGORY_NAMES[HIGH_CARD],
  };
}

// Lexicographic compare of two tiebreak arrays. Missing trailing entries count
// as lower. Returns -1/0/1.
function compareTiebreak(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] === undefined ? -1 : a[i];
    const bv = b[i] === undefined ? -1 : b[i];
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

// Compare two hands. Each argument may be a card array or a score object.
// Returns -1 (a worse), 0 (tie), 1 (a better).
function compareScores(sa, sb) {
  if (sa.rank < sb.rank) return -1;
  if (sa.rank > sb.rank) return 1;
  return compareTiebreak(sa.tiebreak, sb.tiebreak);
}

function toScore(x) {
  if (x && typeof x === "object" && !Array.isArray(x) && typeof x.rank === "number") {
    return x; // already a score
  }
  return evaluate7(x);
}

function compareHands(a, b) {
  return compareScores(toScore(a), toScore(b));
}

// Return the best 5 cards (as a card-string array) for a given hand. Useful for
// display. Enumerates 5-card subsets and keeps the best per evaluate7.
function bestFive(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    throw new Error("bestFive: need at least 5 cards");
  }
  if (cards.length === 5) return cards.slice();
  let best = null;
  let bestCombo = null;
  const n = cards.length;
  // Choose 5 of n via nested loops (n<=7 so this is tiny).
  const idx = [0, 1, 2, 3, 4];
  const combos = [];
  // Standard combination generator for indices 0..n-1 choose 5.
  (function gen(start, chosen) {
    if (chosen.length === 5) {
      combos.push(chosen.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      chosen.push(i);
      gen(i + 1, chosen);
      chosen.pop();
    }
  })(0, []);
  void idx;
  for (const combo of combos) {
    const five = combo.map((i) => cards[i]);
    const score = evaluate7(five);
    if (best === null || compareScores(score, best) > 0) {
      best = score;
      bestCombo = five;
    }
  }
  return bestCombo;
}

module.exports = {
  evaluate7,
  compareHands,
  compareScores,
  bestFive,
  CATEGORY_NAMES,
  HIGH_CARD,
  ONE_PAIR,
  TWO_PAIR,
  THREE_KIND,
  STRAIGHT,
  FLUSH,
  FULL_HOUSE,
  FOUR_KIND,
  STRAIGHT_FLUSH,
};
