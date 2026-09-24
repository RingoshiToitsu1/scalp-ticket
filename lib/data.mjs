// Candle fetching and caching. Coinbase serves 300 one-minute candles per request and keeps
// about 30 days of them, so a month of history is ~145 polite requests — worth caching to
// disk so a grid search does not re-download the market every run.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const API = 'https://api.exchange.coinbase.com';
export const CACHE = '/tmp/claude-1000/scalp-cache';

export function productId(word) {
  const w = (word || 'btc').toUpperCase();
  return w.includes('-') ? w : `${w}-USD`;
}

export async function tickSize(id) {
  const r = await fetch(`${API}/products/${id}`, { headers: { 'User-Agent': 'scalp-ticket' } });
  const j = await r.json();
  return parseFloat(j.quote_increment) || 0.01;
}

export async function candles(id, days, { quiet = false, granularity = 60 } = {}) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const file = `${CACHE}/${id}-${days}d-${granularity}s.json`;
  if (existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() / 1000 - c.at < 3600) return c.candles;
  }
  const out = new Map();
  const end = Math.floor(Date.now() / 1000), start = end - days * 86400;
  const span = 300 * granularity;
  for (let t = start; t < end; t += span) {
    const a = new Date(t * 1000).toISOString();
    const b = new Date(Math.min(t + span, end) * 1000).toISOString();
    let rows = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${API}/products/${id}/candles?granularity=${granularity}&start=${a}&end=${b}`,
        { headers: { 'User-Agent': 'scalp-ticket' } });
      if (r.ok) { rows = await r.json(); break; }
      await new Promise(s => setTimeout(s, 700 * (attempt + 1)));   // rate limited: back off
    }
    for (const c of rows) out.set(c[0], c);
    if (!quiet) process.stderr.write(`\r${id}: ${out.size} candles`);
    await new Promise(s => setTimeout(s, 160));
  }
  if (!quiet) process.stderr.write('\r[K');
  const candlesOut = [...out.values()].sort((x, y) => x[0] - y[0])
    .map(c => ({ t: c[0], l: c[1], h: c[2], o: c[3], c: c[4], v: c[5] }));
  writeFileSync(file, JSON.stringify({ at: Date.now() / 1000, candles: candlesOut }));
  return candlesOut;
}
