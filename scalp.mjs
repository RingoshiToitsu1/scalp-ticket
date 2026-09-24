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
import { decide } from './lib/decide.mjs';

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

// The rule lives in lib/decide.mjs — the backtest imports the same function.

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
