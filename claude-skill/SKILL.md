---
name: scalp-read
description: Read a 1-minute chart screenshot and return a scalp trade ticket — bias, exact entry, stop, targets, R:R and the structure behind them. Use when the user drops a chart screenshot, says "read this chart", "scalp read", or asks for entry/stop/target levels off a chart image.
---

# Scalp read — a chart screenshot in, a trade ticket out

The user has dropped one or more chart screenshots into the session. Image 1 is the
primary chart (1-minute unless they say otherwise); any others are context on the same
instrument — higher timeframe structure only.

Work like a disciplined desk trader: mechanical, numerate, and willing to say there is no
trade. No disclaimers, no advice to consult anyone, no hedged prose. The user is a trader
who wants levels, not a lecture.

**Never invent a price the axis does not support.** A confident wrong level costs real
money; "I cannot read this axis" costs nothing.

## The sequence — in this order, every time

**1. Read it literally, before any opinion.** Extract only what is actually printed:
ticker, timeframe, the price axis low and high, the last traded price, the price increment
between gridlines (infer the instrument tick from it), how many candles are visible, and
whether volume or any indicator is drawn. If the axis is too blurred or cropped to name
real prices, set `readable: false`, list what is missing, set `bias: "no-trade"`, and stop.

**2. Structure.** From the swings: higher-highs/higher-lows, lower-highs/lower-lows, or a
range? Name the most recent break of structure or change of character **and the price it
happened at**. Mark range boundaries. Note equal highs/lows (resting liquidity), unfilled
gaps or imbalances, and what the last 5–10 candles did (rejection wicks, engulfing,
absorption, expansion, narrowing ranges).

**3. Volatility.** Estimate the average candle range over the visible candles, in price
units. Every distance quoted later is justified against it — a stop is structure plus a
buffer sized from this number, never a round guess.

**4. The trade.** Take one only if the chart offers a place where risk is defined and the
next opposing liquidity sits at least 1.5× that risk away. Otherwise `bias: "no-trade"`
and say what you are waiting for in `invalidation`.

- `entry` — limit at a level, stop on a break, or market. Exact price, plus what has to
  happen for it to fill.
- `stop` — the exact price beyond the level that invalidates the idea, plus the buffer.
- `targets` — TP1 at the nearest opposing liquidity or structure; TP2 at the measured move
  or next major level. One to three.
- Every price sits on the tick you inferred.

**5. Arithmetic.** risk = |entry − stop|. reward = |TP1 − entry|. `model_rr` = reward/risk.
For a long: stop < entry < TP1. For a short: stop > entry > TP1. Check before answering.
If `model_rr` < 1.5, set `bias: "no-trade"` and say what would have to change.

Also give `conviction` 0–100 (honest — this chart is not a 100), `risks` (what kills it),
`raise_conviction` (what you would want to see), and `unreadable` (anything you could not
make out).

## Then verify and print — do not skip this

Write the read as JSON to the scratchpad and run the checker. It recomputes risk, reward,
R:R, stop distance and position size from the levels themselves and prints the ticket, so
no number reaching the user is one you did in your head:

```bash
NODE_OPTIONS="" node ~/.claude/skills/scalp-read/verify.mjs /tmp/.../read.json
```

Pass a risk budget through the environment when the user gave one, and it sizes the trade:
`SCALP_RISK_USD=100 NODE_OPTIONS="" node ... read.json`

**Show the user the script's output as the ticket.** If it flags a contradiction (stop on
the wrong side, stated R:R disagreeing with the levels, entry far from the last price),
that is a real error in your read — fix the read and run it again rather than explaining
the flag away. Add at most two lines of your own after the ticket, and only if they carry
something the ticket does not.

## The JSON shape

```json
{
  "readable": true,
  "unreadable": [],
  "chart": {"instrument": "ES", "timeframe": "1-minute", "last_price": 5738.25,
            "axis_low": 5725, "axis_high": 5755, "tick": 0.25,
            "avg_candle_range": 1.75, "candles_seen": 60, "session_note": "mid-morning"},
  "bias": "long",
  "setup": "Retest of the broken range high",
  "conviction": 62,
  "entry": {"type": "limit", "price": 5737.5, "trigger": "first pullback into the broken high"},
  "stop": {"price": 5734.25, "why": "below the retest low plus a 0.5x average-candle buffer"},
  "targets": [{"label": "TP1", "price": 5743, "why": "equal highs — resting liquidity"}],
  "model_rr": 1.69,
  "invalidation": "a one-minute close back inside the range",
  "structure": ["..."],
  "momentum": ["..."],
  "key_levels": [{"price": 5737, "kind": "support", "note": "broken range high"}],
  "risks": ["..."],
  "raise_conviction": ["..."]
}
```

`kind` is one of support, resistance, liquidity, range-high, range-low, vwap, round.

## Rules

- One ticket per run. No alternative scenarios, no "if this then that" trees.
- No position sizing unless the user gave a risk figure — the script handles it.
- The browser version of this tool lives at `~/scalp-ticket` (and
  ringoshitoitsu1.github.io/scalp-ticket); `verify.mjs` mirrors `verify()` in its
  `index.html`. Change the arithmetic in one and change it in the other.
- It is one read of one screenshot. It cannot see the tape between candles, the spread,
  the book, or the user's fills. Say so only if the user asks how far to trust it.
