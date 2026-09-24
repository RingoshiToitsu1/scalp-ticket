---
name: scalp-read
description: Read a 1-minute chart screenshot and return a scalp trade ticket — bias, exact entry, stop, targets, R:R. Use when the user drops a chart screenshot, says "read this chart", "scalp read", or asks for entry/stop/target levels off a chart image.
---

# Scalp read — screenshot in, levels out, fast

**Speed is the product.** A 1-minute setup is stale in two minutes. The only acceptable
output is the levels; everything else is what made you slow. Work like a desk trader
calling a level across the room, not an analyst writing it up.

The user has dropped chart screenshots. Image 1 is the primary chart (1-minute unless
stated); any others are higher-timeframe context on the same instrument.

**Never invent a price the axis does not support.** If the axis is illegible, say so in one
line and stop — that costs nothing; a confident wrong level costs money.

## The read — think it, don't write it

Do all of this silently, then emit only the ticket:

1. **Axis** — ticker, last price, the gridline increment, the visible high and low.
2. **Structure** — HH/HL, LH/LL or range; the most recent break and the price it broke at;
   equal highs/lows as resting liquidity; where a fast one-sided leg left thin structure.
3. **Volatility** — average candle range over the visible candles. Every stop distance is
   structure plus a buffer sized from that number, never a round guess.
4. **The trade** — only where risk is defined and the next opposing liquidity is ≥1.5× that
   risk away. Otherwise `--bias no-trade` with one line on what you are waiting for.
   Entry sits at a *location* (a level), not wherever price happens to be printing.
5. **Arithmetic** — for a long, stop < entry < TP1; for a short, stop > entry > TP1.

## Emit — one Bash call, nothing before it

No preamble, no "let me analyse", no restating the chart. The first thing you do after
looking at the image is run this:

```bash
node ~/.claude/skills/scalp-read/verify.mjs --bias short --entry 83992 --stop 84030 \
  --tp 83915,83800 --last 83969.83 --tick 0.01 --sym "BTCUSD 1m" \
  --why "retest of broken 84,000, LH downtrend" --invalid "1m close above 84,050"
```

It recomputes risk, reward, R:R and size from the levels and prints the ticket, so no
number reaching the user is one you did in your head. Add `--risk 200` (or they can set
`SCALP_RISK_USD`) and it sizes the position. `--conv 58` adds a conviction number.

Flags: `--bias long|short|no-trade` `--entry` `--stop` `--tp a,b,c` `--last` `--tick`
`--atr` `--sym` `--why` `--trigger` `--invalid` `--conv` `--risk` `--type limit|stop|market`.

**The script's output is the answer.** After it, add at most one short line, and only if it
carries something the ticket cannot — the location of the entry versus the last print, or
what changes the trade. Usually add nothing.

If the checker flags a contradiction (stop on the wrong side, R:R that disagrees with the
levels), that is a real error in your read: fix the levels and re-run, never explain it away.

## Full write-up — only when asked

When the user asks for the reasoning, a post-mortem, or "the full read", write the JSON
below to the scratchpad and run `node ~/.claude/skills/scalp-read/verify.mjs read.json --full`.
Never do this on a live chart.

```json
{"readable": true, "unreadable": [],
 "chart": {"instrument": "BTCUSD", "timeframe": "1-minute", "last_price": 83969.83,
           "tick": 0.01, "avg_candle_range": 25, "candles_seen": 150, "session_note": ""},
 "bias": "short", "setup": "", "conviction": 58,
 "entry": {"type": "limit", "price": 83992, "trigger": ""},
 "stop": {"price": 84030, "why": ""},
 "targets": [{"label": "TP1", "price": 83915, "why": ""}],
 "model_rr": 2.03, "invalidation": "",
 "structure": [], "momentum": [],
 "key_levels": [{"price": 84000, "kind": "round", "note": ""}],
 "risks": [], "raise_conviction": []}
```

`kind` is one of support, resistance, liquidity, range-high, range-low, vwap, round.

## Rules

- One ticket per run. No alternative scenarios, no if-this-then-that trees.
- No sizing unless the user gave a risk figure — the script handles it.
- The browser version lives at `~/scalp-ticket` (ringoshitoitsu1.github.io/scalp-ticket);
  `verify.mjs` mirrors `verify()` in its `index.html`. Change the maths in one, change both.
