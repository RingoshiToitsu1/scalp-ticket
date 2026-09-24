// The rule, parameterised, plus a fast simulator over it.
//
// Every variant the grid searches is a set of values for `params` below; the live `scalp`
// command is one particular set (`DEFAULTS`). One implementation, so a backtest can never
// test something different from what actually fires.
//
// The metric everything is judged on is R — the trade's result divided by the money it had
// at risk — because R makes trades on different instruments and sizes comparable. Costs are
// expressed in R too: a fee of f (as a fraction) on a position entered at price P with a
// stop D away costs f·P/D of an R. That ratio is the whole economics of scalping. On BTC at
// $84,000 with a 50-point stop, a 0.05% fee is 0.84R per side — the trade has to be
// extraordinary to survive its own costs. Widen the stop and the cost falls proportionally.

export const DEFAULTS = {
  k: 2,              // pivot window: a swing is the extreme of the k candles either side
  lookback: 120,     // candles of context
  atrLen: 20,
  trend: 'swings',   // swings | ema | none
  entry: 'retest',   // retest | market | break
  target: 'pivot',   // pivot | atr:N | rr:N
  stopBuf: 0.5,      // stop sits this many ATRs beyond the anchoring swing
  maxDist: 4,        // entry must be within this many ATRs of price
  minRR: 1.5,
  timeStop: 0,       // bars; 0 = hold until stop or target
  emaFast: 9,
  emaSlow: 30
};

// ---- preparation (once per series) -----------------------------------------
export function prepare(candles, opts = {}) {
  const ks = opts.ks || [DEFAULTS.k];
  const atrLens = opts.atrLens || [DEFAULTS.atrLen];
  const n = candles.length;

  const tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const p = candles[i - 1].c, c = candles[i];
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p));
  }
  const atr = {};
  for (const len of atrLens) {
    const a = new Float64Array(n);
    let sum = 0;
    for (let i = 1; i < n; i++) {
      sum += tr[i];
      if (i > len) sum -= tr[i - len];
      a[i] = sum / Math.min(i, len);
    }
    atr[len] = a;
  }

  // Pivots, with the index at which each becomes KNOWN (confirm = i + k). Nothing in the
  // simulation may look at a pivot before its confirm bar — that is where backtests lie.
  const piv = {};
  for (const k of ks) {
    const highs = [], lows = [];
    for (let i = k; i < n - k; i++) {
      let isH = true, isL = true;
      for (let j = i - k; j <= i + k && (isH || isL); j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) highs.push({ i, price: candles[i].h, confirm: i + k });
      if (isL) lows.push({ i, price: candles[i].l, confirm: i + k });
    }
    piv[k] = { highs, lows };
  }

  const ema = {};
  for (const len of [opts.emaFast || DEFAULTS.emaFast, opts.emaSlow || DEFAULTS.emaSlow]) {
    const e = new Float64Array(n); const a = 2 / (len + 1);
    e[0] = candles[0].c;
    for (let i = 1; i < n; i++) e[i] = candles[i].c * a + e[i - 1] * (1 - a);
    ema[len] = e;
  }
  return { atr, piv, ema, n };
}

// Confirmed-by-bar-i pivots, newest last. Linear scan from a cursor kept by the caller would
// be faster still; this binary search is fast enough and much harder to get wrong.
function confirmedUpTo(list, i, want) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m].confirm <= i) lo = m + 1; else hi = m; }
  return lo >= want ? list.slice(lo - want, lo) : [];
}

function roundStep(price) {
  return Math.pow(10, Math.floor(Math.log10(Math.abs(price || 1))) - 2);
}

// ---- the signal ------------------------------------------------------------
export function signal(candles, prep, i, p, tick) {
  const P = { ...DEFAULTS, ...p };
  const price = candles[i].c;
  const atr = prep.atr[P.atrLen][i];
  if (!(atr > 0)) return null;
  const { highs, lows } = prep.piv[P.k];
  const H = confirmedUpTo(highs, i, 2), L = confirmedUpTo(lows, i, 2);
  if (H.length < 2 || L.length < 2) return null;

  // --- direction ---
  let down = false, up = false;
  if (P.trend === 'swings') {
    down = H[1].price < H[0].price && L[1].price < L[0].price;
    up   = H[1].price > H[0].price && L[1].price > L[0].price;
  } else if (P.trend === 'ema') {
    const f = prep.ema[P.emaFast][i], s = prep.ema[P.emaSlow][i];
    down = f < s; up = f > s;
  } else {
    const back = candles[Math.max(0, i - 10)].c;
    down = price < back; up = price > back;
  }
  if (!down && !up) return null;

  const lastHigh = H[1].price, lastLow = L[1].price;
  const step = roundStep(price);
  let entry, anchor;

  if (P.entry === 'market') {
    entry = price;
    anchor = down ? lastHigh : lastLow;
  } else if (P.entry === 'break') {
    // continuation: join once price takes out the swing in the trend's direction
    entry = down ? lastLow : lastHigh;
    anchor = down ? lastHigh : lastLow;
  } else {
    // retest: the nearest level AGAINST the current push
    if (down) {
      const cands = [Math.ceil(price / step) * step, lastHigh > price ? lastHigh : Infinity].filter(v => v > price && Number.isFinite(v));
      if (!cands.length) return null;
      entry = Math.min(...cands);
      anchor = Math.max(entry, lastHigh > entry ? lastHigh : entry);
    } else {
      const cands = [Math.floor(price / step) * step, lastLow < price ? lastLow : -Infinity].filter(v => v < price && Number.isFinite(v));
      if (!cands.length) return null;
      entry = Math.max(...cands);
      anchor = Math.min(entry, lastLow < entry ? lastLow : entry);
    }
  }
  if (Math.abs(entry - price) > P.maxDist * atr) return null;

  const stop = down ? anchor + P.stopBuf * atr : anchor - P.stopBuf * atr;
  const risk = Math.abs(entry - stop);
  // A quiet patch — or a gap in the venue's candles, where consecutive bars repeat — drives
  // ATR toward zero, and a near-zero risk denominator turns one trade into an infinite R
  // that swamps every average it lands in. Require the stop to be a real distance.
  if (!(risk > 0) || risk < tick || risk < 0.05 * atr) return null;

  let tp;
  if (P.target === 'pivot') tp = down ? lastLow : lastHigh;
  else if (P.target.startsWith('atr:')) {
    const m = parseFloat(P.target.slice(4));
    tp = down ? entry - m * atr : entry + m * atr;
  } else {
    const m = parseFloat(P.target.slice(3));
    tp = down ? entry - m * risk : entry + m * risk;
  }

  const ok = down ? (stop > entry && tp < entry) : (stop < entry && tp > entry);
  if (!ok) return null;
  const rr = Math.abs(tp - entry) / risk;
  if (rr < P.minRR) return null;

  const r = v => Math.round(v / tick) * tick;
  return { bias: down ? 'short' : 'long', entry: r(entry), stop: r(stop), tp1: r(tp), rr, atr };
}

// ---- simulation ------------------------------------------------------------
// Returns results in R, plus the fee cost in R so the two can be compared directly.
// Pessimism, deliberately: resolution starts on the bar after the fill, and a bar that
// touches both stop and target counts as a stop.
export function simulate(candles, prep, p, tick, costs = {}) {
  const P = { ...DEFAULTS, ...p };
  const maker = costs.maker ?? 0.0002, taker = costs.taker ?? 0.0005, slip = costs.slip ?? 0.0001;
  const expiry = costs.expiry ?? 15;
  const n = candles.length;
  let i = Math.max(P.lookback, P.atrLen + 2);
  let sumR = 0, sumNetR = 0, hits = 0, trades = 0, sumCostR = 0, sumHold = 0;
  let equityR = 0, peak = 0, maxDDR = 0;

  while (i < n - 1) {
    const s = signal(candles, prep, i, P, tick);
    if (!s) { i++; continue; }
    // Spot has no short side. `only: 'long'` drops every short signal instead of pretending
    // the account could take it.
    if (P.only && s.bias !== P.only) { i++; continue; }
    const short = s.bias === 'short';

    // A market order fills on the signal bar's close; anything resting fills when a later bar
    // trades through it. Which side the bar must reach is decided by where the order sits
    // relative to price, NOT by the direction of the trade — a short can be a sell limit
    // above price (retest) or a sell stop below it (break), and treating both as "above"
    // silently fills breakouts at prices that never traded.
    let j, filled = false;
    if (P.entry === 'market') { j = i; filled = true; }
    else {
      const above = s.entry > candles[i].c;
      for (j = i + 1; j < n && j <= i + expiry; j++) {
        const c = candles[j];
        if (above ? c.h >= s.entry : c.l <= s.entry) { filled = true; break; }
      }
    }
    if (!filled) { i++; continue; }

    const risk = Math.abs(s.entry - s.stop);
    let exit = null, stopped = false, k = j + 1;
    for (; k < n; k++) {
      const c = candles[k];
      const hitStop = short ? c.h >= s.stop : c.l <= s.stop;
      const hitTP = short ? c.l <= s.tp1 : c.h >= s.tp1;
      if (hitStop) { exit = s.stop * (1 + (short ? slip : -slip)); stopped = true; break; }
      if (hitTP) { exit = s.tp1; break; }
      if (P.timeStop && k - j >= P.timeStop) { exit = c.c; break; }
    }
    if (exit == null) break;

    const grossR = (short ? (s.entry - exit) : (exit - s.entry)) / risk;
    // fee in R: (fee fraction x notional) / (risk x quantity) — quantity cancels
    // Which side of the book each leg lands on, rather than assuming the cheap one:
    //   retest  — a resting limit order, so maker
    //   market  — crosses the spread, so taker
    //   break   — a stop order, which executes at market when triggered, so taker
    // The exit is maker at the target (a resting limit) and taker at the stop (stop-market).
    const feeIn = P.entry === 'retest' ? maker : taker;
    const feeOut = stopped ? taker : maker;
    const costR = (s.entry * feeIn + exit * feeOut) / risk;
    sumR += grossR; sumCostR += costR; sumNetR += grossR - costR;
    if (!stopped && exit === s.tp1) hits++;
    trades++; sumHold += k - j;
    equityR += grossR - costR;
    peak = Math.max(peak, equityR);
    maxDDR = Math.max(maxDDR, peak - equityR);
    i = k + 1;
  }
  return {
    trades, hitRate: trades ? hits / trades : 0,
    avgR: trades ? sumR / trades : 0,
    avgCostR: trades ? sumCostR / trades : 0,
    avgNetR: trades ? sumNetR / trades : 0,
    totalR: sumR, totalNetR: sumNetR,
    avgHold: trades ? sumHold / trades : 0,
    maxDDR
  };
}
