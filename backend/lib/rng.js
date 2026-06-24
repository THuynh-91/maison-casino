"use strict";
/* Cryptographically-backed RNG helpers shared by all game engines. */
const crypto = require("crypto");

// Uniform integer in [0, max) with rejection sampling (no modulo bias).
function randInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new Error("randInt: max must be a positive integer");
  if (max === 1) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  let x;
  do {
    x = crypto.randomBytes(4).readUInt32BE(0);
  } while (x >= limit);
  return x % max;
}

// Uniform float in [0,1).
function random() {
  return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000;
}

// Fisher-Yates shuffle (in place) using the unbiased randInt.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function pick(arr) {
  return arr[randInt(arr.length)];
}

module.exports = { randInt, random, shuffle, pick };
