#!/usr/bin/env node
// Grid search: is there ANY setting of this rule that clears costs?
//
//   node grid.mjs --days 30 --test 7
//
// Fits on the older part of the window, then re-runs the survivors on the held-out newer
// part. A grid of a thousand variants will always contain some that look good on the data
// they were chosen from — the held-out run is the only number that means anything, and the
// report prints how many variants were positive in training precisely so the selection
// effect is visible rather than hidden.
//
// Everything is measured in R, and costs are charged in R too (see lib/engine.mjs), so the
// verdict does not depend on account size.

import { candles, tickSize, productId } from './lib/data.mjs';
import { prepare, simulate, DEFAULTS } from './lib/engine.mjs';

const args = process.argv.slice(2), F = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) {
  F[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : 'true';
}
const DAYS = parseFloat(F.days ?? 30);
const TEST_DAYS = parseFloat(F.test ?? 7);
const PRODUCTS = (F.products ?? 'btc,eth,sol,doge').split(',');
const MIN_TRADES = parseFloat(F['min-trades'] ?? 40);
// The timeframe is the lever the 1-minute grid pointed at: cost in R is fee x price / stop,
// and a stop on a higher timeframe is several times wider for the same fee.
const GRAN = parseFloat(F.granularity ?? 60);
const BARS_PER_DAY = 86400 / GRAN;
// Fee tiers to price the same trades at. "spot" is Coinbase Advanced's entry tier, "perp" a
// typical perpetual-futures maker/taker, "zero" the counterfactual.
const TIERS = {
  spot: { maker: 0.0060, taker: 0.0120 },
  perp: { maker: 0.0002, taker: 0.0005 },
  zero: { maker: 0, taker: 0 }
};
const TIER = TIERS[F.tier ?? 'perp'];

const GRID = [];
for (const k of [2, 3, 5])
for (const trend of ['swings', 'ema', 'none'])
for (const entry of ['retest', 'market', 'break'])
for (const target of ['pivot', 'atr:1', 'atr:2', 'atr:3', 'rr:1.5', 'rr:3'])
for (const stopBuf of [0.25, 0.5, 1])
for (const timeStop of [0, 30])
  GRID.push({ k, trend, entry, target, stopBuf, timeStop, minRR: target === 'pivot' ? 1.5 : 0 });

const name = p => `k${p.k} ${p.trend} ${p.entry} tp=${p.target} sl=${p.stopBuf}atr${p.timeStop ? ' ts' + p.timeStop : ''}`;

// ---- load ------------------------------------------------------------------
const series = [];
for (const p of PRODUCTS) {
  const id = productId(p);
  const all = await candles(id, DAYS, { quiet: true, granularity: GRAN });
  const tick = await tickSize(id);
  const cut = all.length - Math.round(TEST_DAYS * BARS_PER_DAY);
  if (cut < 800) { console.error(`${id}: not enough history (${all.length})`); continue; }
  const train = all.slice(0, cut), test = all.slice(cut);
  const opts = { ks: [2, 3, 5], atrLens: [DEFAULTS.atrLen] };
  series.push({ id, tick, train, test, prepTrain: prepare(train, opts), prepTest: prepare(test, opts) });
  console.error(`${id}: ${train.length} train / ${test.length} test candles`);
}
if (!series.length) process.exit(1);

// ---- search ----------------------------------------------------------------
console.error(`searching ${GRID.length} variants x ${series.length} products …`);
const rows = [];
for (const params of GRID) {
  let trades = 0, sumNetR = 0, sumR = 0, sumCost = 0, hits = 0, worst = 0;
  for (const s of series) {
    const r = simulate(s.train, s.prepTrain, params, s.tick, TIER);
    trades += r.trades; sumNetR += r.totalNetR; sumR += r.totalR;
    sumCost += r.avgCostR * r.trades; hits += r.hitRate * r.trades;
    worst = Math.max(worst, r.maxDDR);
  }
  if (trades < MIN_TRADES) continue;
  rows.push({ params, trades, avgR: sumR / trades, avgNetR: sumNetR / trades,
              avgCostR: sumCost / trades, hitRate: hits / trades, maxDDR: worst });
}
rows.sort((a, b) => b.avgNetR - a.avgNetR);

const C = { r: '[0m', dim: '[2m', b: '[1m', g: '[38;5;42m', red: '[38;5;203m', am: '[38;5;214m' };
const sign = v => (v >= 0 ? C.g : C.red) + (v >= 0 ? '+' : '') + v.toFixed(3) + C.r;

const positive = rows.filter(r => r.avgNetR > 0).length;
console.log('');
console.log(`${C.b}Grid: ${rows.length} variants cleared ${MIN_TRADES} trades · fees ${(TIER.maker * 100).toFixed(2)}/${(TIER.taker * 100).toFixed(2)}%${C.r}`);
console.log(`${C.dim}${GRAN >= 3600 ? (GRAN/3600)+'h' : (GRAN/60)+'m'} bars · train ${DAYS - TEST_DAYS}d, test ${TEST_DAYS}d held out · ${series.map(s => s.id).join(' ')}${C.r}`);
console.log(`${C.dim}${positive} of ${rows.length} were net-positive in training — before any held-out check.${C.r}`);
console.log('');
console.log(`${C.dim}  ${'variant'.padEnd(38)} ${'trades'.padStart(6)} ${'netR'.padStart(8)} ${'grossR'.padStart(8)} ${'costR'.padStart(7)} ${'hit'.padStart(5)}${C.r}`);

const TOP = 12;
for (const r of rows.slice(0, TOP)) {
  console.log(`  ${name(r.params).padEnd(38)} ${String(r.trades).padStart(6)} ${sign(r.avgNetR).padStart(18)} ${sign(r.avgR).padStart(18)} ${C.dim}${r.avgCostR.toFixed(3).padStart(7)}${C.r} ${C.dim}${(r.hitRate * 100).toFixed(0).padStart(4)}%${C.r}`);
}

// ---- held out --------------------------------------------------------------
console.log('');
console.log(`${C.b}Held out — the same ${Math.min(TOP, rows.length)} variants on data they were not chosen from${C.r}`);
console.log(`${C.dim}  ${'variant'.padEnd(38)} ${'trades'.padStart(6)} ${'netR'.padStart(8)} ${'grossR'.padStart(8)}${C.r}`);
let survivors = 0;
for (const r of rows.slice(0, TOP)) {
  let trades = 0, sumNetR = 0, sumR = 0;
  for (const s of series) {
    const t = simulate(s.test, s.prepTest, r.params, s.tick, TIER);
    trades += t.trades; sumNetR += t.totalNetR; sumR += t.totalR;
  }
  const netR = trades ? sumNetR / trades : 0, grossR = trades ? sumR / trades : 0;
  if (netR > 0 && trades >= 20) survivors++;
  console.log(`  ${name(r.params).padEnd(38)} ${String(trades).padStart(6)} ${sign(netR).padStart(18)} ${sign(grossR).padStart(18)}`);
}
console.log('');
console.log(survivors
  ? `${C.am}${survivors} of the top ${Math.min(TOP, rows.length)} stayed positive out of sample. That is a lead, not a result — re-run it on another window before believing it.${C.r}`
  : `${C.red}None of the top ${Math.min(TOP, rows.length)} stayed positive out of sample.${C.r}`);
console.log('');
