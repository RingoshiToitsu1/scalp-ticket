# Scalp Ticket

One static page. Drop a 1-minute chart screenshot, get a trade ticket: bias, entry,
stop, targets, and the structure read behind them.

- No build step, no server, no backend — `index.html` is the whole app.
- It calls the Anthropic Messages API (`claude-opus-5`) straight from the browser.
- Your API key is pasted into the page and kept in that browser's `localStorage`.
  It is never committed, never sent anywhere but `api.anthropic.com`.

The risk:reward, stop distance and position size shown on the ticket are recomputed
by the page from the levels themselves — where the model's own arithmetic disagrees
with its levels, the page says so and the levels win.

## From the tape — `scalp`, no screenshot, no model

`scalp.mjs` runs the same procedure on Coinbase's public 1-minute candles and prints in
about 200 ms, because nothing in it thinks:

```
scalp btc              # BTC-USD
scalp eth --risk 200   # size against $200 of risk
scalp sol --terse      # add R:R, the setup line
```

Structure comes from fractal pivots (a candle that is the extreme of the two either side),
volatility from a 20-period ATR, and the trade only exists when the last two swing highs
*and* the last two swing lows agree on a direction, a level sits within 4x ATR of price,
and the first target is at least 1.5R away. On ~4 hours of BTC it fired on a third of the
minutes and refused the rest — refusing chop is the feature.

Installed at `~/bin/scalp`.

## Does it work? — `backtest.mjs`

```
node backtest.mjs btc --days 3 --budget 1000
node backtest.mjs btc --days 3 --budget 1000 --maker 0.02 --taker 0.05 --trades
```

Walks Coinbase's own 1-minute history through the same `lib/decide.mjs` the live command
uses, fills limit orders against the candles that followed, and prices the result at a
real fee tier. Where it has to guess it guesses against you: a candle touching both stop
and target counts as a stop, the stop exits at market and pays taker plus slippage, and
resolution starts on the candle after the fill.

**Result as of 2026-09-24 — the rule loses before costs.** Over 3 days of BTC it took 286
trades, reached the target on 21% of them, and averaged **-0.30R a trade** (-85R total).
ETH was -0.21R. SOL was +0.11R, which is noise, not an edge. At Coinbase's entry fee tier
(0.60/1.20%) a \$1,000 spot account is wiped out by fees alone; even at futures-style fees
it is down 21% in three days. Do not trade this rule. It is a structure reader, not a
strategy — treat the numbers it prints as levels to think about, not signals to take.

## In Claude Code (no API key, no credit)

`claude-skill/` is the same read as a Claude Code skill, installed by symlink at
`~/.claude/skills/scalp-read`. Drop a screenshot into a session and run `/scalp-read`:
it runs on your Claude subscription instead of API credit.

`claude-skill/verify.mjs` does the arithmetic and prints the ticket, so the numbers
are computed rather than recalled. It mirrors `verify()` in `index.html` — change the
maths in one, change it in the other.

Not advice. One model's opinion of one screenshot.
