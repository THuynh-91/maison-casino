"use strict";
/* STUB — slots engine. Replaced by a dedicated worker. */
class SlotsEngine {
  constructor(room, ctx) { this.gameId = "slots"; this.room = room; this.ctx = ctx; }
  getPublicState() { return { gameId: "slots", phase: "coming-soon" }; }
  handleAction() { return { ok: false, error: "slots not implemented yet" }; }
}
module.exports = SlotsEngine;
module.exports.Engine = SlotsEngine;
