// The rule itself — shared by `scalp` (live) and `backtest.mjs` (history), so the numbers
// a backtest reports are produced by the same code that calls the live trade. Copying it
// would let the two drift, and a backtest of code you do not run is worth nothing.

// ---- structure -------------------------------------------------------------
// A pivot is a candle whose high (or low) is the extreme of the k candles either side of it.
// k = 2 on a one-minute chart: tight enough to catch a scalp swing, wide enough not to call
// every wick a structure point.
export function pivots(candles, k = 2) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].h });
    if (isLow) lows.push({ i, price: candles[i].l });
  }
  return { highs, lows };
}

function trueRanges(candles) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1].c;
    tr.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - p), Math.abs(candles[i].l - p)));
  }
  return tr;
}

// The round numbers a scalper actually watches, scaled to the instrument: 100s on a
// $84,000 coin, 10s on a $3,000 one, and so on down.
function roundStep(price) {
  const mag = Math.floor(Math.log10(Math.abs(price || 1)));
  return Math.pow(10, mag - 2);
}

export function decide(candles, tick, livePrice) {
  const last = candles[candles.length - 1];
  // The candles endpoint publishes closed buckets and can lag a minute or two, which on a
  // one-minute scalp is the whole trade. Structure comes from the candles; "where is price
  // right now" comes from the ticker.
  const price = Number.isFinite(livePrice) && livePrice > 0 ? livePrice : last.c;
  const tr = trueRanges(candles).slice(-20);
  const atr = tr.reduce((a, b) => a + b, 0) / (tr.length || 1);
  const { highs, lows } = pivots(candles);
  const out = { price, atr, ts: last.t, why: '', bias: 'no-trade' };

  if (highs.length < 2 || lows.length < 2) { out.why = 'not enough structure in the window'; return out; }
  const [h2, h1] = highs.slice(-2).map(p => p.price);   // h1 = most recent
  const [l2, l1] = lows.slice(-2).map(p => p.price);

  const down = h1 < h2 && l1 < l2;
  const up = h1 > h2 && l1 > l2;
  if (!down && !up) { out.why = 'no trend — last two swings do not agree'; return out; }
  out.bias = down ? 'short' : 'long';

  // Entry: the nearest untested level AGAINST the current push. For a short that is the
  // closest resistance above price — a swing high or a round number, whichever is nearer.
  const step = roundStep(price);
  const roundAbove = Math.ceil(price / step) * step;
  const roundBelow = Math.floor(price / step) * step;
  const swingAbove = highs.map(p => p.price).filter(p => p > price + tick).sort((a, b) => a - b)[0];
  const swingBelow = lows.map(p => p.price).filter(p => p < price - tick).sort((a, b) => b - a)[0];

  let entry, stopAnchor;
  if (down) {
    const cands = [roundAbove, swingAbove].filter(v => Number.isFinite(v) && v > price);
    if (!cands.length) { out.bias = 'no-trade'; out.why = 'no level above price to sell into'; return out; }
    entry = Math.min(...cands);
    // the swing that defines the level, for the stop
    stopAnchor = Math.max(entry, swingAbove ?? entry);
  } else {
    const cands = [roundBelow, swingBelow].filter(v => Number.isFinite(v) && v < price);
    if (!cands.length) { out.bias = 'no-trade'; out.why = 'no level below price to buy into'; return out; }
    entry = Math.max(...cands);
    stopAnchor = Math.min(entry, swingBelow ?? entry);
  }

  // Too far from price and it is not a scalp any more, it is a limit order left overnight.
  if (Math.abs(entry - price) > 4 * atr) {
    out.bias = 'no-trade';
    out.why = `nearest level is ${(Math.abs(entry - price) / atr).toFixed(1)}x ATR away`;
    return out;
  }

  const buf = 0.5 * atr;
  const stop = down ? stopAnchor + buf : stopAnchor - buf;
  // TP1: the nearest opposing liquidity. TP2: the extreme of the window.
  const lowsOnly = candles.map(c => c.l), highsOnly = candles.map(c => c.h);
  const tp1 = down ? (lows[lows.length - 1]?.price ?? Math.min(...lowsOnly))
                   : (highs[highs.length - 1]?.price ?? Math.max(...highsOnly));
  const tp2 = down ? Math.min(...lowsOnly) : Math.max(...highsOnly);

  const round = v => Math.round(v / tick) * tick;
  out.entry = round(entry); out.stop = round(stop);
  out.tp1 = round(tp1); out.tp2 = round(tp2);

  // Same gate the skill applies by eye.
  const risk = Math.abs(out.entry - out.stop), reward = Math.abs(out.tp1 - out.entry);
  out.rr = risk > 0 ? reward / risk : NaN;
  const wrongSide = down ? !(out.tp1 < out.entry && out.stop > out.entry)
                         : !(out.tp1 > out.entry && out.stop < out.entry);
  if (wrongSide) { out.bias = 'no-trade'; out.why = 'structure gives no room between the level and the target'; return out; }
  if (!(out.rr >= 1.5)) { out.bias = 'no-trade'; out.why = `only ${out.rr.toFixed(2)}R to the first target`; return out; }
  out.why = down ? 'sell the retest, lower highs and lower lows' : 'buy the pullback, higher highs and higher lows';
  return out;
}
