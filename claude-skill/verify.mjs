#!/usr/bin/env node
// Scalp Ticket — arithmetic check and terminal ticket.
//
// Takes the chart read as JSON (a file path, or on stdin) and PRINTS the ticket. The point is
// that no number on screen is one the model did in its head: risk, reward, R:R, stop distance and
// position size are all recomputed here from the entry, stop and targets, and a stop on the wrong
// side of the entry — or a model_rr that disagrees with its own levels — is called out.
//
// FAST PATH (default on a live chart) — flags in, direction and three numbers out:
//   node verify.mjs --bias short --entry 83992 --stop 84030 --tp 83915,83800 \
//     --last 83969.83 --tick 0.01 --atr 25 --sym "BTCUSD 1m" --why "..." --invalid "..."
//
// FULL PATH — the whole read as JSON, for a post-mortem rather than a live signal:
//   NODE_OPTIONS="" node verify.mjs read.json --full
//   cat read.json | NODE_OPTIONS="" node verify.mjs --full
//
// Mirrors verify() in index.html. Keep the two in step.

import { readFileSync } from 'node:fs';

const C = {
  r: '[0m', dim: '[2m', b: '[1m',
  green: '[38;5;42m', red: '[38;5;203m', amber: '[38;5;214m',
  steel: '[38;5;75m', grey: '[38;5;245m'
};

function parseArgs(argv) {
  const a = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      a[k] = v;
    } else rest.push(t);
  }
  return { a, rest };
}

// Build the ticket from flags — the live path. Only what a trade needs: no narrative,
// because narrative is what makes a signal arrive after the move.
function fromFlags(a) {
  const tps = String(a.tp || '').split(',').map(x => x.trim()).filter(Boolean);
  const t = {
    readable: true,
    chart: { instrument: a.sym || '', timeframe: '', last_price: n(a.last), tick: n(a.tick), avg_candle_range: n(a.atr) },
    bias: (a.bias || 'no-trade').toLowerCase(),
    setup: a.why || '',
    conviction: n(a.conv),
    entry: { type: a.type || 'limit', price: n(a.entry), trigger: a.trigger || '' },
    stop: { price: n(a.stop), why: a.stopwhy || '' },
    targets: tps.map((p, i) => ({ label: 'TP' + (i + 1), price: n(p), why: '' })),
    model_rr: n(a.rr),
    invalidation: a.invalid || ''
  };
  return t;
}

// Bare: direction and the three numbers. The default, because that is the whole ask on a
// live chart. A contradiction still prints — shipping a wrong-sided stop silently is worse
// than one extra line.
export function renderBare(t, riskUSD) {
  const v = verify(t, riskUSD);
  const tick = n(t?.chart?.tick);
  const bias = ['long', 'short'].includes(t.bias) ? t.bias : 'no-trade';
  const tone = bias === 'long' ? C.green : bias === 'short' ? C.red : C.amber;
  const L = [''];
  if (bias === 'no-trade') {
    L.push(`${tone}${C.b}NO TRADE${C.r}${t.setup ? C.dim + ' · ' + t.setup + C.r : ''}`);
    L.push('');
    return L.join('\n');
  }
  L.push(`${tone}${C.b}${bias.toUpperCase()}${C.r}${t?.chart?.instrument ? C.dim + '  ' + t.chart.instrument + C.r : ''}`);
  const cells = [`${C.b}Entry${C.r} ${fmt(n(t.entry?.price), tick)}`,
                 `${C.red}Stop${C.r} ${fmt(n(t.stop?.price), tick)}`];
  for (const g of (t.targets || [])) cells.push(`${C.green}${g.label}${C.r} ${fmt(n(g.price), tick)}`);
  L.push(cells.join(C.dim + '   ' + C.r));
  if (Number.isFinite(v.units)) L.push(`${C.dim}size ${v.units >= 10 ? Math.floor(v.units) : v.units.toFixed(2)} for $${riskUSD}${C.r}`);
  for (const i of v.issues) L.push(`${C.red}⚠ ${i}${C.r}`);
  if (Number.isFinite(v.rr) && v.rr < 1.5) L.push(`${C.amber}⚠ ${v.rr.toFixed(2)}R — under 1.5${C.r}`);
  L.push('');
  return L.join('\n');
}

export function renderTerse(t, riskUSD) {
  const v = verify(t, riskUSD);
  const tick = n(t?.chart?.tick);
  const bias = ['long', 'short'].includes(t.bias) ? t.bias : 'no-trade';
  const tone = bias === 'long' ? C.green : bias === 'short' ? C.red : C.amber;
  const head = bias === 'no-trade' ? 'NO TRADE' : bias.toUpperCase();
  const who = t?.chart?.instrument || '';
  const L = [''];
  L.push(`${tone}${C.b}━━ ${head}${C.r}${tone} · ${who}${C.r} ${C.dim}${'━'.repeat(Math.max(4, 40 - head.length - who.length))}${C.r}`);
  if (bias !== 'no-trade') {
    const cells = [`${C.b}Entry${C.r} ${fmt(n(t.entry?.price), tick)}`,
                   `${C.red}Stop${C.r} ${fmt(n(t.stop?.price), tick)}`];
    for (const g of (t.targets || [])) cells.push(`${C.green}${g.label}${C.r} ${fmt(n(g.price), tick)}`);
    L.push('  ' + cells.join(C.dim + '   ' + C.r));
    const bits = [];
    if (Number.isFinite(v.rr)) bits.push(`${v.rr < 1.5 ? C.amber : C.steel}R:R ${v.rr.toFixed(2)}:1${C.r}`);
    if (Number.isFinite(v.risk)) bits.push(`risk ${fmt(v.risk, tick)}`);
    if (Number.isFinite(v.units)) bits.push(`size ${v.units >= 10 ? Math.floor(v.units) : v.units.toFixed(2)} for $${riskUSD}`);
    L.push('  ' + bits.join(C.dim + ' · ' + C.r));
  }
  const tail = [t.setup, t.entry?.trigger, t.invalidation ? 'invalid: ' + t.invalidation : ''].filter(Boolean);
  if (tail.length) L.push(`  ${C.dim}${tail.join(' · ')}${C.r}`);
  if (v.issues.length) for (const i of v.issues) L.push(`  ${C.red}⚠ ${i}${C.r}`);
  else if (bias !== 'no-trade') L.push(`  ${C.dim}✓ checks out${C.r}`);
  if (Number.isFinite(v.rr) && v.rr < 1.5) L.push(`  ${C.amber}⚠ under 1.5R${C.r}`);
  L.push('');
  return L.join('\n');
}

function readInput() {
  const arg = process.argv[2];
  if (arg && arg !== '-') return readFileSync(arg, 'utf8');
  return readFileSync(0, 'utf8');
}
function parseTolerant(text) {
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a > -1 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try { const v = JSON.parse(t.trim()); if (v && typeof v === 'object') return v; } catch {}
  }
  throw new Error('no JSON object found in the input');
}

export const num = v => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(x) ? x : NaN;
};
const n = num;
function decimalsFor(tick, price) {
  if (tick > 0) {
    const s = String(tick);
    if (s.includes('e-')) return Math.min(8, parseInt(s.split('e-')[1], 10));
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
  }
  const p = Math.abs(price || 0);
  if (p >= 10) return 2;
  if (p >= 1) return 3;
  if (p >= 0.01) return 5;
  return 6;
}
const fmt = (v, tick) => Number.isFinite(v)
  ? v.toLocaleString('en-US', { minimumFractionDigits: decimalsFor(tick, v), maximumFractionDigits: decimalsFor(tick, v) })
  : '—';

// The whole reason this file exists.
export function verify(t, riskUSD) {
  const out = { issues: [], rr: NaN, risk: NaN, reward: NaN, units: NaN, riskPct: NaN };
  const e = n(t?.entry?.price), s = n(t?.stop?.price);
  const tp = t?.targets?.length ? n(t.targets[0].price) : NaN;
  if (!Number.isFinite(e) || !Number.isFinite(s)) return out;
  out.risk = Math.abs(e - s);
  if (Number.isFinite(tp)) {
    out.reward = Math.abs(tp - e);
    out.rr = out.risk > 0 ? out.reward / out.risk : NaN;
  }
  const long = t.bias === 'long', short = t.bias === 'short';
  if (long && !(s < e)) out.issues.push('Long with the stop at or above the entry — wrong side.');
  if (short && !(s > e)) out.issues.push('Short with the stop at or below the entry — wrong side.');
  if (long && Number.isFinite(tp) && !(tp > e)) out.issues.push('Long with the first target below the entry.');
  if (short && Number.isFinite(tp) && !(tp < e)) out.issues.push('Short with the first target above the entry.');
  const mrr = n(t.model_rr);
  if (Number.isFinite(mrr) && Number.isFinite(out.rr) && Math.abs(mrr - out.rr) > 0.15) {
    out.issues.push(`Stated R:R ${mrr.toFixed(2)} does not match the levels (${out.rr.toFixed(2)}). The levels win.`);
  }
  const last = n(t?.chart?.last_price);
  if (Number.isFinite(last) && last > 0) {
    out.riskPct = out.risk / last * 100;
    if (Math.abs(e - last) / last > 0.05) {
      out.issues.push('Entry is more than 5% from the last price read off the axis — check the axis read.');
    }
  }
  if (Number.isFinite(riskUSD) && riskUSD > 0 && out.risk > 0) out.units = riskUSD / out.risk;
  return out;
}

function render(t) {
  const riskUSD = n(process.env.SCALP_RISK_USD ?? t?.risk_per_trade_usd);
  const v = verify(t, riskUSD);
  const tick = n(t?.chart?.tick);
  const bias = ['long', 'short'].includes(t.bias) ? t.bias : 'no-trade';
  const tone = bias === 'long' ? C.green : bias === 'short' ? C.red : C.amber;
  const L = [];
  const ch = t.chart || {};

  const head = bias === 'no-trade' ? 'NO TRADE' : bias.toUpperCase();
  const who = [ch.instrument, ch.timeframe].filter(Boolean).join(' ') || 'chart';
  L.push('');
  L.push(`${tone}${C.b}━━ ${head}${C.r}${tone} · ${who}${C.r} ${C.dim}${'━'.repeat(Math.max(4, 46 - head.length - who.length))}${C.r}`);
  const conv = Number.isFinite(n(t.conviction)) ? `${C.dim}conviction ${Math.round(n(t.conviction))}${C.r}` : '';
  L.push(`  ${t.setup || (bias === 'no-trade' ? 'Nothing worth the risk here' : '')}   ${conv}`);
  if (Number.isFinite(n(ch.last_price))) L.push(`  ${C.dim}last ${fmt(n(ch.last_price), tick)}${Number.isFinite(n(ch.avg_candle_range)) ? ` · avg candle ${fmt(n(ch.avg_candle_range), tick)}` : ''}${tick > 0 ? ` · tick ${tick}` : ''}${C.r}`);

  if (t.readable === false) {
    L.push('');
    L.push(`  ${C.red}Could not read the chart.${C.r} ${(t.unreadable || []).join(' ')}`);
  }

  if (bias !== 'no-trade') {
    L.push('');
    const pad = s => String(s).padEnd(9);
    L.push(`  ${C.b}Entry${C.r}  ${pad(fmt(n(t.entry?.price), tick))} ${C.dim}${[t.entry?.type, t.entry?.trigger].filter(Boolean).join(' · ')}${C.r}`);
    L.push(`  ${C.red}Stop${C.r}   ${pad(fmt(n(t.stop?.price), tick))} ${C.dim}${t.stop?.why || ''}${C.r}`);
    for (const g of (t.targets || []).slice(0, 3)) {
      L.push(`  ${C.green}${String(g.label || 'TP').padEnd(6)}${C.r} ${pad(fmt(n(g.price), tick))} ${C.dim}${g.why || ''}${C.r}`);
    }
    L.push('');
    const bits = [];
    if (Number.isFinite(v.rr)) bits.push(`${v.rr < 1.5 ? C.amber : C.steel}R:R ${v.rr.toFixed(2)}:1${C.r}`);
    if (Number.isFinite(v.risk)) bits.push(`risk ${fmt(v.risk, tick)}${Number.isFinite(v.riskPct) ? ` (${v.riskPct.toFixed(2)}%)` : ''}`);
    if (Number.isFinite(v.reward)) bits.push(`to TP1 ${fmt(v.reward, tick)}`);
    if (Number.isFinite(v.units)) bits.push(`size ${v.units >= 10 ? Math.floor(v.units) : v.units.toFixed(2)} units for $${riskUSD}`);
    L.push(`  ${bits.join(C.dim + ' · ' + C.r)}`);
    if (v.issues.length) {
      for (const i of v.issues) L.push(`  ${C.red}⚠ ${i}${C.r}`);
    } else {
      L.push(`  ${C.dim}✓ arithmetic checks out against the levels${C.r}`);
    }
    if (Number.isFinite(v.rr) && v.rr < 1.5) L.push(`  ${C.amber}⚠ under 1.5R — thin edge for a scalp${C.r}`);
  }

  const sec = (title, items) => {
    const list = (items || []).filter(x => x != null && String(x).trim());
    if (!list.length) return;
    L.push('');
    L.push(`  ${C.dim}${title.toUpperCase()}${C.r}`);
    for (const i of list) L.push(`   ${C.dim}·${C.r} ${i}`);
  };
  if (t.invalidation) sec(bias === 'no-trade' ? 'waiting for' : 'invalidated if', [t.invalidation]);
  sec('structure', t.structure);
  sec('momentum', t.momentum);
  if (t.key_levels?.length) {
    sec('levels', t.key_levels.slice(0, 8).map(k => `${fmt(n(k.price), tick)}  ${[k.kind, k.note].filter(Boolean).join(' · ')}`));
  }
  sec('what kills it', t.risks);
  sec('would raise conviction', t.raise_conviction);
  if (t.readable !== false) sec('could not make out', t.unreadable);
  L.push('');
  return L.join('\n');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) try {
  const { a, rest } = parseArgs(process.argv.slice(2));
  const riskUSD = n(a.risk ?? process.env.SCALP_RISK_USD);
  const shape = (t, r) => a.full ? render(t) : a.terse ? renderTerse(t, r) : renderBare(t, r);
  if (a.bias || a.entry) {
    // live path: flags in, direction and three numbers out
    console.log(shape(fromFlags(a), riskUSD));
  } else {
    const t = parseTolerant(rest[0] && rest[0] !== '-' ? readFileSync(rest[0], 'utf8') : readFileSync(0, 'utf8'));
    console.log(shape(t, Number.isFinite(riskUSD) ? riskUSD : n(t.risk_per_trade_usd)));
  }
} catch (e) {
  console.error(`verify.mjs: ${e.message}`);
  process.exit(1);
}
