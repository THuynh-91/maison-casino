"use strict";
/* STUB — blackjack engine. Replaced by a dedicated worker. */
class BlackjackEngine {
  constructor(room, ctx) { this.gameId = "blackjack"; this.room = room; this.ctx = ctx; }
  getPublicState() { return { gameId: "blackjack", phase: "coming-soon" }; }
  handleAction() { return { ok: false, error: "blackjack not implemented yet" }; }
}
module.exports = BlackjackEngine;
module.exports.Engine = BlackjackEngine;
