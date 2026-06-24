"use strict";
/* STUB — poker engine. Replaced by a dedicated worker. */
class PokerEngine {
  constructor(room, ctx) { this.gameId = "poker"; this.room = room; this.ctx = ctx; }
  getPublicState() { return { gameId: "poker", phase: "coming-soon" }; }
  handleAction() { return { ok: false, error: "poker not implemented yet" }; }
}
module.exports = PokerEngine;
module.exports.Engine = PokerEngine;
