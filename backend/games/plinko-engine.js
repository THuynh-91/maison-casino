"use strict";
/* STUB — plinko engine. Replaced by a dedicated worker. */
class PlinkoEngine {
  constructor(room, ctx) { this.gameId = "plinko"; this.room = room; this.ctx = ctx; }
  getPublicState() { return { gameId: "plinko", phase: "coming-soon" }; }
  handleAction() { return { ok: false, error: "plinko not implemented yet" }; }
}
module.exports = PlinkoEngine;
module.exports.Engine = PlinkoEngine;
