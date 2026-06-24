"use strict";
/*
 * Game registry. Maps gameId -> { title, minPlayers, maxPlayers, load() }.
 * load() requires the engine module lazily so one unfinished game never blocks
 * the whole server from booting.
 */

const GAMES = {
  roulette: {
    title: "Roulette",
    blurb: "Single-zero European wheel. Place chips, spin together.",
    load: () => require("./roulette-engine"),
  },
  blackjack: {
    title: "Blackjack",
    blurb: "Multi-seat vs the dealer. Hit, stand, double, split.",
    load: () => require("./blackjack-engine"),
  },
  slots: {
    title: "Slots",
    blurb: "Spin the reels. Match symbols across paylines.",
    load: () => require("./slots-engine"),
  },
  plinko: {
    title: "Plinko",
    blurb: "Drop a ball through the pegs into a multiplier slot.",
    load: () => require("./plinko-engine"),
  },
  poker: {
    title: "Texas Hold'em",
    blurb: "No-limit Hold'em with blinds, betting rounds, and a pot.",
    load: () => require("./poker-engine"),
  },
};

function listGames() {
  return Object.entries(GAMES).map(([id, g]) => ({
    id,
    title: g.title,
    blurb: g.blurb,
    available: isAvailable(id),
  }));
}

function isAvailable(id) {
  const g = GAMES[id];
  if (!g) return false;
  try {
    const mod = g.load();
    return typeof mod === "function" || (mod && typeof mod.Engine === "function");
  } catch (e) {
    return false;
  }
}

// Returns the engine CLASS for a gameId, or null if unavailable.
function getEngineClass(id) {
  const g = GAMES[id];
  if (!g) return null;
  try {
    const mod = g.load();
    if (typeof mod === "function") return mod;
    if (mod && typeof mod.Engine === "function") return mod.Engine;
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { GAMES, listGames, isAvailable, getEngineClass };
