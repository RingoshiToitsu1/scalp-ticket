---
name: scalp-read
description: Read a 1-minute chart screenshot and return a scalp trade ticket — bias, exact entry, stop, targets, R:R. Use when the user drops a chart screenshot, says "read this chart", "scalp read", or asks for entry/stop/target levels off a chart image.
---

# Scalp read — screenshot in, levels out, fast

**Speed is the product.** A 1-minute setup is stale in two minutes. The output is four
things — long or short, entry, stop, targets — and nothing else. No preamble, no reasoning,
no commentary after. Work like a desk trader calling a level across the room.

The user has dropped chart screenshots. Image 1 is the primary chart (1-minute unless
stated); any others are higher-timeframe context on the same instrument.

**Never invent a price the axis does not support.** If the axis is illegible, say so in one
line and stop — that costs nothing; a confident wrong level costs money.

## The read — one pass, no alternatives

Deliberation is the latency. Take the FIRST answer this procedure gives and run the
command. Do not price a second candidate, do not compare a long against a short, do not
try three stop placements and pick the best — that weighing is what costs ten seconds.

1. **Direction** — the last break of structure. Lower highs and lower lows: short only.
   Higher highs and higher lows: long only. Neither: `--bias no-trade`, done.
2. **Entry** — the nearest untested level *against* the current push, in that direction: the
   broken shelf or round number price is retracing into. Not where price is printing now.
3. **Stop** — beyond the swing that defines the level, plus half an average candle.
4. **TP1** — the nearest opposing liquidity (last swing low for a short, swing high for a
   long). **TP2** — the prior extreme.
5. **Check** — rr = |TP1 − entry| / |entry − stop|. Under 1.5, it is `--bias no-trade`.
   Do not go hunting for a better version of the trade; the chart did not offer one.

## Emit — one Bash call, nothing before it, nothing after it

The first thing you do after looking at the image is run this. No "let me analyse", no
restating the chart, no summary underneath.

```bash
node ~/.claude/skills/scalp-read/verify.mjs --bias short --entry 83992 --stop 84030 --tp 83915,83800 --tick 0.01
```

Prints:

```
SHORT
Entry 83,992.00   Stop 84,030.00   TP1 83,915.00   TP2 83,800.00
```

It recomputes risk, reward and R:R from the levels, so a stop on the wrong side or an R:R
under 1.5 prints as a ⚠ line — the only thing that ever appears beyond the four. Add
`--risk 200` (or `SCALP_RISK_USD`) and it adds a size line.

Flags: `--bias long|short|no-trade` `--entry` `--stop` `--tp a,b,c` `--tick` `--risk`
`--sym` `--last` `--atr` `--why` `--trigger` `--invalid` `--conv` `--type limit|stop|market`.
The last six are only rendered by `--terse` and `--full`; passing them on the live path
costs time for nothing.

`--terse` adds R:R, the setup line and the invalidation. `--full` is the whole write-up.
Use neither unless the user asks.

**The script's output is the entire answer. Write nothing after it** — not a summary, not a
repeat of the levels, not "here's the read". The user already sees the command's output;
anything you type after it is pure latency. If the checker flags a contradiction, that is a
real error in your read: fix the levels and re-run.

## Full write-up — only when asked

When the user asks for the reasoning, a post-mortem, or "the full read", write the JSON
below to the scratchpad and run `node ~/.claude/skills/scalp-read/verify.mjs read.json --full`.
Never do this on a live chart — it is the slow path by design.

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
