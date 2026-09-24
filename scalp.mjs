#!/usr/bin/env node
// Scalp Ticket — levels straight from the tape, no screenshot and no model in the loop.
//
//   scalp btc                 BTC-USD, 1-minute
//   scalp eth --risk 200      size it against $200 of risk
//   scalp sol-usd --terse     add R:P, the setup line and the invalidation
//
// Runs the same procedure the /scalp-read skill follows by eye, on Coinbase's public
// 1-minute candles, and prints through the same renderer. The point is latency: this
// answers in about the time the HTTP round trip takes, because nothing here thinks.
//
// What it cannot do is judgement — a chart you drew on, a venue Coinbase does not list, an
// instrument that is not a crypto pair, or "does this look like a trap". That is what the
// screenshot path is for.

import { verify, renderBare, renderTerse, num as n } from './claude-skill/verify.mjs';

const API = 'https://api.exchange.coinbase.com';
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : 'true';
  } else positional.push(args[i]);
}

// "btc" -> "BTC-USD"; anything already hyphenated is passed through.
function productId(word) {
  const w = (word || 'btc').toUpperCase();
  return w.includes('-') ? w : `${w}-USD`;
}

async function getJSON(path, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(API + path, { signal: ctl.signal, headers: { 'User-Agent': 'scalp-ticket' } });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- structure -------------------------------------------------------------
// A pivot is a candle whose high (or low) is the extreme of the k candles either side of it.
// k = 2 on a one-minute chart: tight enough to catch a scalp swing, wide enough not to call
// every wick a structure point.
function pivots(candles, k = 2) {
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

function decide(candles, tick, livePrice) {
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

// ---- run -------------------------------------------------------------------
const id = productId(positional[0]);
try {
  const [raw, product, ticker] = await Promise.all([
    getJSON(`/products/${id}/candles?granularity=60`),
    getJSON(`/products/${id}`),
    getJSON(`/products/${id}/ticker`).catch(() => null)
  ]);
  if (!Array.isArray(raw) || !raw.length) throw new Error(`no candles came back for ${id}`);
  const tick = n(product.quote_increment) || 0.01;
  // Coinbase returns [time, low, high, open, close, volume], newest first.
  const candles = raw.map(c => ({ t: c[0], l: c[1], h: c[2], o: c[3], c: c[4] }))
    .sort((a, b) => a.t - b.t).slice(-120);

  const d = decide(candles, tick, n(ticker?.price));
  const ticket = {
    readable: true,
    chart: { instrument: `${id} 1m`, timeframe: '1-minute', last_price: d.price, tick, avg_candle_range: d.atr },
    bias: d.bias,
    setup: d.why,
    entry: { type: 'limit', price: d.entry, trigger: '' },
    stop: { price: d.stop, why: '' },
    targets: d.bias === 'no-trade' ? [] : [
      { label: 'TP1', price: d.tp1, why: '' },
      { label: 'TP2', price: d.tp2, why: '' }
    ],
    invalidation: ''
  };
  const riskUSD = n(flags.risk ?? process.env.SCALP_RISK_USD);
  console.log(flags.terse ? renderTerse(ticket, riskUSD) : renderBare(ticket, riskUSD));
  const age = Math.round((Date.now() - new Date(ticker?.time || 0).getTime()) / 1000);
  const fresh = ticker && age >= 0 && age < 600 ? `${age}s ago` : 'from the last candle close';
  console.log(`[2m${id} ${d.price} · ATR ${d.atr.toFixed(2)} · last trade ${fresh}[0m\n`);
} catch (e) {
  console.error(`scalp: ${e.message}`);
  process.exit(1);
}
