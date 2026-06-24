# Maison Roulette — Multiplayer Casino

A self-hosted, real-time multiplayer casino. Create or join a room by code, see other
players and their chip balances live, and play together: **Roulette, Blackjack, Slots,
Plinko**, and **Texas Hold'em Poker**. Node + Express + Socket.io backend, vanilla-JS
frontend in a warm, editorial design language with drag-and-drop chips.

```
backend/    Express + Socket.io server, room/money model, game engines
frontend/   Single-page web client (lobby + room + per-game views)
tests/      node --test suites for every game engine
legacy/     the original standalone single-player roulette (served at /legacy)
```

## Run it

```bash
npm install          # express + socket.io
npm start            # serves the casino on http://localhost:4900
# or pick a port:  PORT=4900 node backend/server.js
```

Open **http://localhost:4900** in your browser. To play with friends on your LAN, share
your machine's IP + port; everyone joins the same room with the room code.

`npm run dev` is an alias for `npm start` (no build step — the frontend is static files).

## How to play

1. On the lobby, enter a name and **Create Room** (or **Join** with a 5-char code).
2. Share the room **code** (copy button in the top nav) with friends.
3. Pick a table from the game picker. Everyone in the room shares the table.
4. Each player starts with **1000 chips**, persisted server-side per room (and your
   identity persists on your device via `localStorage`, so refreshing keeps your seat).

### Games
- **Roulette** — shared single-zero European wheel. Drag chips (or click) onto numbers,
  splits, streets, corners, lines, columns, dozens, and even-money areas. Anyone can
  SPIN; everyone sees the same result land and is paid automatically.
- **Blackjack** — up to 5 seats vs the dealer. Bet, deal, hit/stand/double/split.
  Blackjack pays 3:2, dealer stands on soft 17.
- **Slots** — 5×3 reels, 5 paylines, weighted RNG, wild substitution (~0.90 RTP).
- **Plinko** — drop a ball through a 12-row peg board into a multiplier slot; low/medium/
  high risk profiles. The server decides the path; the client animates exactly that path.
- **Poker** — multiplayer No-Limit Texas Hold'em with blinds, betting rounds, and a pot.

## Admin

Click **Admin**, log in with the admin password (default **`letmein`** — set the
`ADMIN_PASSWORD` env var to change it; this is a demo gate, not a real secret). Admins can
grant chips, set balances, kick players, top up everyone, and switch the room's table.

## Tests

```bash
node --test
```

Covers the pure game logic for every engine — roulette payouts & bet adjacency, blackjack
hand values / settle / 3:2, slots paylines & RTP fairness, plinko binomial distribution &
house edge, and poker hand evaluation & showdown.

## Architecture notes

- All money and game state is **server-authoritative**; clients never mutate balances and
  every socket payload is validated. Game engines implement a small contract
  (`backend/games/engine-contract.md`) and are registered in `backend/games/registry.js`,
  so new games drop in without touching the server.
- The frontend game views self-register on `window.CasinoGames[gameId]` with
  `{ mount, update, unmount }`, driven by pushed `room:state`.
