# Game Engine Contract

Every game engine is a CommonJS module exporting a class. The room creates one
engine instance per active game. Engines are server-authoritative: they own all
game logic and call back into the `Room` for chip movement.

## Constructor
```js
new Engine(room, ctx)
```
- `room` — the `Room` instance. Use `room.debit(pid, amt)`, `room.credit(pid, amt)`,
  `room.setBalance(pid, amt)`, `room.getPlayer(pid)`, `room.players` (Map of
  persistentId -> Player), `room.playerList()`.
- `ctx` — `{ broadcast(), rng, log }`.
  - `broadcast()` — call after any state change; the server re-emits room state to
    everyone (each viewer gets `getPublicState(theirId)`).
  - `rng` — `backend/lib/rng` (`randInt`, `random`, `shuffle`, `pick`).
  - `log(...args)` — namespaced logger.

## Required members
- `engine.gameId` — string id, must match the registry key (`roulette`, `blackjack`,
  `slots`, `plinko`, `poker`).
- `engine.getPublicState(viewerId)` — returns a JSON-serializable object describing the
  game for that viewer. NEVER leak hidden info (e.g. other players' hole cards, the
  dealer's hole card before reveal, the shuffled deck order).
- `engine.handleAction(viewerId, action)` — `action` is `{ type, ...payload }` from a
  client. VALIDATE everything (the player exists, owns the seat/turn, amounts are
  positive integers within balance, the action is legal in the current phase). Return
  `{ ok: true }` on success or `{ ok: false, error: "message" }` on rejection. Call
  `ctx.broadcast()` yourself when state changed. Do NOT trust client-supplied money,
  results, or other players' identities.

## Optional members
- `engine.onPlayerJoin(viewerId)` — seat/init a newly joined player.
- `engine.onPlayerLeave(viewerId)` — fold/clear a leaving player; keep the game playable.
- `engine.dispose()` — clear timers on room teardown.

## Money rules
- Deduct stakes with `room.debit` at bet time; it returns `false` if insufficient —
  reject the action then. Credit winnings with `room.credit`. Never let balance go
  negative. All amounts are integer chips.

## Validation helpers
Use `backend/lib/validate.js`: `isPosInt`, `clampInt`, `isOneOf`, `asString`.
