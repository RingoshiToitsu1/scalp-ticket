#!/usr/bin/env node
// Scalp Ticket — backtest. Would this rule have made money?
//
//   node backtest.mjs btc --days 3 --budget 1000
//   node backtest.mjs btc --days 3 --budget 1000 --maker 0.0 --taker 0.05   # a futures fee tier
//
// Walks Coinbase's own 1-minute candles, runs the SAME decide() the live `scalp` command
// runs (imported, not copied), and fills orders against the candles that followed.
//
// Where the simulation has to guess, it guesses against you:
//   · a candle that touches both the stop and the target is counted as a stop;
//   · the entry is a limit, so it only fills if price actually trades through it;
//   · the stop exits at market and pays the taker fee plus slippage;
//   · nothing compounds intrabar — one position at a time, no pyramiding, no re-entry.
// Fees default to Coinbase Advanced's entry tier (0.60 maker / 1.20 taker) because that is
// what a $1,000 account actually pays, and on a scalp the fee is usually the whole story.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { decide } from './lib/decide.mjs';

const API = 'https://api.exchange.coinbase.com';
const args = process.argv.slice(2), flags = {}, pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : 'true';
  } else pos.push(args[i]);
}
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

const PRODUCT = (pos[0] || 'btc').toUpperCase().includes('-') ? (pos[0] || 'btc').toUpperCase() : `${(pos[0] || 'btc').toUpperCase()}-USD`;
const DAYS    = num(flags.days, 3);
const BUDGET  = num(flags.budget, 1000);
const RISKPCT = num(flags['risk-pct'], 1);      // % of the account risked per trade
const LEV     = num(flags.leverage, 1);         // 1 = spot, no borrowing
const MAKER   = num(flags.maker, 0.60) / 100;   // limit fills
const TAKER   = num(flags.taker, 1.20) / 100;   // stop exits
const SLIP_BP = num(flags.slip, 1) / 10000;     // slippage on the stop, in basis points
const EXPIRY  = num(flags.expiry, 15);          // cancel an unfilled entry after N minutes
const CACHE   = `/tmp/claude-1000/scalp-cache`;

// ---- data ------------------------------------------------------------------
async function fetchWindow(startISO, endISO) {
  const url = `${API}/products/${PRODUCT}/candles?granularity=60&start=${startISO}&end=${endISO}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'scalp-ticket-backtest' } });
  if (!r.ok) throw new Error(`candles → HTTP ${r.status}`);
  return await r.json();
}
async function history(days) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const file = `${CACHE}/${PRODUCT}-${days}d.json`;
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() / 1000 - cached.at < 900) return cached.candles;   // 15 min is fresh enough
  }
  const out = new Map();
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  for (let t = start; t < end; t += 300 * 60) {
    const a = new Date(t * 1000).toISOString();
    const b = new Date(Math.min(t + 300 * 60, end) * 1000).toISOString();
    const rows = await fetchWindow(a, b);
    for (const c of rows) out.set(c[0], c);
    process.stderr.write(`\rfetching ${PRODUCT} … ${out.size} candles`);
    await new Promise(r => setTimeout(r, 180));   // be polite to a public endpoint
  }
  process.stderr.write('\r[K');
  const candles = [...out.values()].sort((x, y) => x[0] - y[0])
    .map(c => ({ t: c[0], l: c[1], h: c[2], o: c[3], c: c[4] }));
  writeFileSync(file, JSON.stringify({ at: Date.now() / 1000, candles }));
  return candles;
}

// ---- simulation ------------------------------------------------------------
function run(candles, tick) {
  let equity = BUDGET;
  const trades = [];
  let peak = BUDGET, maxDD = 0;
  let i = 120;

  while (i < candles.length - 1) {
    const d = decide(candles.slice(i - 120, i), tick);
    if (d.bias === 'no-trade') { i++; continue; }

    const short = d.bias === 'short';
    // Size: risk budget divided by the stop distance, capped by what the account can hold.
    const riskUSD = equity * RISKPCT / 100;
    const stopDist = Math.abs(d.entry - d.stop);
    if (!(stopDist > 0)) { i++; continue; }
    const qtyByRisk = riskUSD / stopDist;
    const qtyByCash = (equity * LEV) / d.entry;
    const qty = Math.min(qtyByRisk, qtyByCash);
    if (!(qty > 0)) { i++; continue; }

    // Walk forward: fill, then resolve.
    let filled = false, fillAt = 0, j = i;
    for (; j < candles.length && j < i + EXPIRY; j++) {
      const c = candles[j];
      if (short ? c.h >= d.entry : c.l <= d.entry) { filled = true; fillAt = d.entry; break; }
    }
    if (!filled) { i += 1; continue; }

    // Resolution starts on the candle AFTER the fill. Inside the fill candle we know price
    // reached the entry but not where it went first, and counting that candle's own range
    // against the position stops every trade the instant it opens — an artifact, not a loss.
    let exit = null, reason = '', ambiguous = false, k = j + 1;
    for (; k < candles.length; k++) {
      const c = candles[k];
      const hitStop = short ? c.h >= d.stop : c.l <= d.stop;
      const hitTP   = short ? c.l <= d.tp1  : c.h >= d.tp1;
      if (hitStop && hitTP) ambiguous = true;
      // Both in one candle: take the stop. We cannot see the order of ticks, so the
      // tie-break goes against the position rather than flattering the result.
      if (hitStop) { exit = d.stop * (1 + (short ? SLIP_BP : -SLIP_BP)); reason = 'stop'; break; }
      if (hitTP)   { exit = d.tp1; reason = 'target'; break; }
    }
    if (exit == null) { break; }   // ran out of data with the trade still open

    const gross = (short ? (fillAt - exit) : (exit - fillAt)) * qty;
    const feeIn  = fillAt * qty * MAKER;                          // limit entry
    const feeOut = exit * qty * (reason === 'stop' ? TAKER : MAKER);
    const net = gross - feeIn - feeOut;
    equity += net;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
    trades.push({ t: candles[j].t, bias: d.bias, entry: fillAt, exit, qty, reason, ambiguous,
                  gross, fees: feeIn + feeOut, net, equity,
                  R: gross / (stopDist * qty), held: k - j });
    i = k + 1;   // no new position until this one is closed
  }
  return { trades, equity, maxDD };
}

// ---- report ----------------------------------------------------------------
const C = { r: '[0m', dim: '[2m', b: '[1m',
            g: '[38;5;42m', red: '[38;5;203m', am: '[38;5;214m' };
const money = v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const candles = await history(DAYS);
if (candles.length < 200) { console.error(`only ${candles.length} candles — not enough history`); process.exit(1); }
const product = await (await fetch(`${API}/products/${PRODUCT}`)).json();
const tick = parseFloat(product.quote_increment) || 0.01;

const { trades, equity, maxDD } = run(candles, tick);
const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
const grossSum = trades.reduce((a, t) => a + t.gross, 0);
const feeSum = trades.reduce((a, t) => a + t.fees, 0);
const netSum = equity - BUDGET;
const from = new Date(candles[0].t * 1000), to = new Date(candles[candles.length - 1].t * 1000);

console.log('');
console.log(`${C.b}${PRODUCT} 1-minute · ${candles.length} candles · ${from.toISOString().slice(0, 16)} → ${to.toISOString().slice(0, 16)}Z${C.r}`);
console.log(`${C.dim}budget ${money(BUDGET)} · risking ${RISKPCT}% a trade · leverage ${LEV}x · fees ${(MAKER * 100).toFixed(2)}/${(TAKER * 100).toFixed(2)}% · one position at a time${C.r}`);
console.log('');
if (!trades.length) { console.log('  no trades were taken in this window.\n'); process.exit(0); }

const tone = netSum >= 0 ? C.g : C.red;
const hits = trades.filter(t => t.reason === 'target');
const totalR = trades.reduce((a, t) => a + t.R, 0);
console.log(`  ${C.b}Trades${C.r}      ${trades.length}   ${C.dim}(${hits.length} reached the target / ${trades.length - hits.length} stopped · ${(hits.length / trades.length * 100).toFixed(0)}% · median hold ${trades.map(t => t.held).sort((a, b) => a - b)[Math.floor(trades.length / 2)]} min)${C.r}`);
console.log(`  ${C.b}Edge${C.r}        ${totalR >= 0 ? C.g : C.red}${(totalR / trades.length).toFixed(3)}R${C.r} a trade   ${C.dim}${totalR.toFixed(1)}R total, before any cost — this is the rule on its own${C.r}`);
console.log(`  ${C.b}Gross${C.r}       ${grossSum >= 0 ? C.g : C.red}${money(grossSum)}${C.r}   ${C.dim}that edge in dollars at this size${C.r}`);
console.log(`  ${C.b}Fees${C.r}        ${C.red}-${money(feeSum)}${C.r}   ${C.dim}${(feeSum / Math.max(1, trades.length)).toFixed(2)} a trade${C.r}`);
console.log(`  ${C.b}Net${C.r}         ${tone}${money(netSum)}${C.r}   ${C.dim}${((netSum / BUDGET) * 100).toFixed(2)}% of the account over ${DAYS} day${DAYS === 1 ? '' : 's'}${C.r}`);
const avgNotional = trades.reduce((a, t) => a + t.entry * t.qty, 0) / trades.length;
const avgRiskUSD = trades.reduce((a, t) => a + Math.abs(t.gross / (t.R || 1)), 0) / trades.length;
console.log(`  ${C.dim}Average position ${money(avgNotional)} · actual risk ${money(avgRiskUSD)} a trade — with ${money(BUDGET)} of spot the cash cap binds long before the ${RISKPCT}% risk rule does.${C.r}`);
const amb = trades.filter(t => t.ambiguous).length;
console.log(`  ${C.b}Ending${C.r}      ${tone}${money(equity)}${C.r}   ${C.dim}worst drawdown ${money(maxDD)}${C.r}`);
if (amb) console.log(`  ${C.dim}${amb} of ${trades.length} exits came from a candle that touched both the stop and the target — those were all counted as stops.${C.r}`);
console.log('');

// What the same trades would have done without the fee drag — the honest counterfactual,
// because it says whether the RULE is wrong or only the venue.
const feeFree = BUDGET + grossSum;
console.log(`  ${C.dim}Same trades, zero fees: ${feeFree >= BUDGET ? C.g : C.red}${money(feeFree - BUDGET)}${C.r}${C.dim} — fees were ${(feeSum / Math.abs(grossSum || 1) * 100).toFixed(0)}% of gross P&L.${C.r}`);
if (flags.trades) {
  console.log('');
  for (const t of trades) {
    const d = new Date(t.t * 1000).toISOString().slice(11, 16);
    console.log(`  ${C.dim}${d}${C.r} ${t.bias === 'long' ? C.g + 'LONG ' : C.red + 'SHORT'}${C.r} ${t.entry.toFixed(2)} → ${t.exit.toFixed(2)} ${C.dim}${t.reason.padEnd(6)}${C.r} ${t.net >= 0 ? C.g : C.red}${money(t.net).padStart(10)}${C.r} ${C.dim}${t.R.toFixed(2)}R${C.r}`);
  }
}
console.log('');
