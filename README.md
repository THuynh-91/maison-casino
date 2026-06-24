# European Roulette Table

A self-contained, interactive single-zero (European, 0-36) roulette table that runs
entirely in the browser — no build step, no server, no dependencies.

![type: web app](https://img.shields.io/badge/stack-HTML%2FCSS%2FJS-blue)

## How to play / open it

Just open `index.html` in any modern browser:

```bash
# from the repo folder
start index.html        # Windows
# or simply double-click index.html in the file explorer
```

(No web server is required — the page and its scripts are local files.)

### Gameplay
1. Pick a **chip** value (1 / 5 / 25 / 100 / 500).
2. **Click cells** on the betting layout to place chips:
   - Numbers `0-36` (straight-up bets), with correct red/black coloring.
   - Columns (`2:1`), dozens (`1st/2nd/3rd 12`).
   - Even-money bets: `RED`, `BLACK`, `ODD`, `EVEN`, `1-18`, `19-36`.
3. Press **SPIN**. The wheel animates (real European pocket order) and the ball settles
   on the result.
4. Winnings are paid automatically and your **Balance** updates.
5. **Undo** removes the last chip, **Clear Bets** returns all staked chips, **Rebet**
   repeats your previous round's bets.

Balance starts at **$1000** and persists in `localStorage`. If you bust, you're topped
back up to $1000.

> The UI exposes the inside bets that are clickable as single cells (straight-up) plus
> all outside bets. The payout **engine** (`roulette-core.js`) fully supports split,
> street, corner, and six-line bets too — these are validated by the tests.

## Payout table (X-to-1)

| Bet | Covers | Payout |
|-----|--------|--------|
| Straight-up | 1 number | 35:1 |
| Split | 2 numbers | 17:1 |
| Street | 3 numbers | 11:1 |
| Corner | 4 numbers | 8:1 |
| Line (six-line) | 6 numbers | 5:1 |
| Column | 12 numbers | 2:1 |
| Dozen | 12 numbers | 2:1 |
| Red / Black | 18 numbers | 1:1 |
| Odd / Even | 18 numbers | 1:1 |
| 1-18 / 19-36 | 18 numbers | 1:1 |

A win returns `stake + stake * payout`. **Zero (0)** loses all outside/even-money bets
(standard European rule; no _la partage_ implemented).

## Wheel

European single-zero wheel only (0-36). The animated wheel uses the real European pocket
order: `0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26`. American double-zero is
**not** implemented.

## Files

- `index.html` – page markup
- `styles.css` – table / wheel / chip styling
- `script.js` – UI: layout generation, chip placement, wheel render + animation, payouts
- `roulette-core.js` – pure, testable game logic (wheel data, colors, bet resolution, payouts)
- `tests/roulette.test.mjs` – payout & bet-resolution tests

## Tests

The math (payouts, color sets, zero handling, multi-bet resolution) is covered by the
Node built-in test runner — no install needed:

```bash
node --test
```

All tests should pass (17 tests).
