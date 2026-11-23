// SPDX-License-Identifier: MIT
// btc-race-24h-20261123-0511 — Tidehunter: a two-leg cbBTC/USDC bot on 1-minute bars.
//
// Why two legs: on 1-minute BTC a single signal family is a coin flip on the
// race window's regime. The dev window is a slow +3.6% grind, the previous race's
// dev window a -2.8% slide — one regime's winner is the other's loser. So this bot
// hunts in two independent ways, each with its own size, and every leg pays the
// same exit discipline: take profit, trailing stop, hard stop, max hold. A full
// round trip costs ~26 bps (4 fee + 2 slippage + ~7 impact each way, plus the
// flatten), so no leg fires on a wiggle: entries need a confirmed move, exits
// need a real one. A momentum-cross leg was tried and dropped: both of its
// firings across the two test windows were breakout failures that hit the hard
// stop, so breakouts are not bought at all.
//
// Leg P (pullback): flat, EMA(16) above EMA(64), the slow EMA rising over 60
//   bars (the regime filter: in a falling market every EMA touch is a trap),
//   close touching the fast EMA from above (within 0.2%) with a positive
//   60-bar return. Buys 60% of cash. In a grind-up window this is where the
//   money is: the trend keeps going, the pullbacks keep coming.
// Leg D (dip): 120-bar return at or below -0.8% with the close within 0.4% of
//   the 120-bar Donchian low, the current bar closing above its open, and the
//   close above the fast EMA (the bounce is confirmed by the trend, not
//   hoped). Buys 60% of cash. Catches washouts without catching the falling
//   knife mid-air.
// Exits (all legs): +1.2% take-profit, 0.6% trailing stop off the running peak,
//   -0.7% hard stop off the blended fill, 300-bar max hold, or EMA(16)
//   crossing back below EMA(64).
// Risk: 20-bar cooldown after every exit; after 2 losing round trips the bot
//   stands down for the rest of the window (two losers means the regime is
//   against every leg). At most 8 round trips. No entry before bar 70 (the slow
//   EMA needs 64 closes to seed), none in the last 25 bars.
// Insurance: if nothing has ever filled by bar 1200, buy 30% blind (take-profit
//   0.8%, trail 0.5%, hold 120) so the entry always meets the race guardrail
//   of at least 1 trade. Deterministic: state is bar history + fill reports only.

import { runBars } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const SLIP_BPS = 500;

// --- indicators ---
const EMA_FAST = 16;
const EMA_SLOW = 64;
const DONCHIAN_N = 120;

// --- leg P (trend pullback, regime-filtered) ---
const P_RET60 = 0.0; // 60-bar return > 0
const P_TOUCH = 0.002; // close within 0.2% above the fast EMA
const P_SIZE_NUM = 60n;
const P_SIZE_DEN = 100n;

// --- leg D (washout dip) ---
const D_RET120 = -0.008; // 120-bar return <= -0.8%
const D_LOW_GAP = 0.004; // close within 0.4% above the Donchian low
const D_SIZE_NUM = 60n;
const D_SIZE_DEN = 100n;

// --- shared exits ---
const TP = 0.012;
const TRAIL = 0.006;
const HARD_STOP = -0.007;
const MAX_HOLD = 300;

// --- insurance leg (I) ---
const I_BAR = 1200;
const I_SIZE_NUM = 30n;
const I_SIZE_DEN = 100n;
const I_TP = 0.008;
const I_TRAIL = 0.005;
const I_HOLD = 120;

// --- shared risk rules ---
const MIN_BAR = 70;
const LAST_ENTRY_BAR = 1414; // no entry in the last 25 bars (1440 total)
const COOLDOWN = 20;
const MAX_LOSSES = 2; // losing round trips, then stand down for the day
const MAX_TRADES = 8;

const closes: number[] = [];
const opens: number[] = [];
const lows: number[] = [];

let emaFast: number | null = null;
let emaSlow: number | null = null;
let prevGap: number | null = null; // fast - slow after the previous bar
const slowHist: number[] = []; // slow EMA per bar, for the regime filter
const fastWarm: number[] = [];
const slowWarm: number[] = [];

let entryPrice = 0; // blended fill price of the open position
let entryQty = 0n;
let entrySeq = -1;
let entrySpent = 0n;
let peak = 0; // highest close since entry
let leg: 'P' | 'D' | 'I' | null = null;
let losses = 0;
let lastExitSeq = -100000;
let trades = 0; // closed round trips
let fills = 0; // filled orders (buys + sells)
let pendingLeg: 'P' | 'D' | 'I' | null = null;

function emaStep(warm: number[], value: number | null, span: number, close: number): number | null {
  if (value !== null) return value + (2 / (span + 1)) * (close - value);
  warm.push(close);
  if (warm.length === span) {
    let s = 0;
    for (const x of warm) s += x;
    return s / span;
  }
  return null;
}

function donchianLow(n: number): number {
  let m = Infinity;
  const start = Math.max(0, lows.length - n);
  for (let i = start; i < lows.length; i++) if (lows[i] < m) m = lows[i];
  return m;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars[0];
    if (bar !== undefined) {
      closes.push(Number(bar.c) / 1e5);
      opens.push(Number(bar.o) / 1e5);
      lows.push(Number(bar.l) / 1e5);
      const close = closes[closes.length - 1];
      emaFast = emaStep(fastWarm, emaFast, EMA_FAST, close);
      emaSlow = emaStep(slowWarm, emaSlow, EMA_SLOW, close);
      if (emaSlow !== null) slowHist.push(emaSlow);
    }
    const seq = state.seq;

    // Fold in this batch's fills: buys set/extend the entry, sells close it.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      fills++;
      if (f.side === 'buy') {
        const q = BigInt(f.qty);
        const p = Number(f.price) / 1e5;
        entryPrice = entryQty === 0n ? p : (entryPrice * Number(entryQty) + p * Number(q)) / Number(entryQty + q);
        entryQty += q;
        entrySpent += BigInt(f.notional_quote_units);
        entrySeq = seq;
        peak = Math.max(peak, closes[closes.length - 1]);
        if (leg === null) leg = pendingLeg;
      } else {
        const proceeds = BigInt(f.notional_quote_units);
        if (state.positions.get(SYM) === undefined) {
          trades++;
          if (proceeds < entrySpent) losses++;
          lastExitSeq = seq;
          entryPrice = 0;
          entryQty = 0n;
          entrySpent = 0n;
          entrySeq = -1;
          peak = 0;
          leg = null;
        }
      }
    }
    pendingLeg = null;

    const pos = state.positions.get(SYM);
    const close = closes[closes.length - 1];
    if (close === undefined) return [];

    // Current EMA gap, and the previous bar's gap for cross detection.
    const gap = emaFast !== null && emaSlow !== null ? emaFast - emaSlow : null;
    const crossedDown = gap !== null && prevGap !== null && gap < 0 && prevGap >= 0;
    if (gap !== null) prevGap = gap;

    // --- holding: manage the exit ---
    if (pos !== undefined && pos.qty > 0n) {
      if (close > peak) peak = close;
      const held = seq - entrySeq;
      const tp = leg === 'I' ? I_TP : TP;
      const trail = leg === 'I' ? I_TRAIL : TRAIL;
      const maxHold = leg === 'I' ? I_HOLD : MAX_HOLD;
      const exit =
        close >= entryPrice * (1 + tp) ||
        close <= peak * (1 - trail) ||
        close <= entryPrice * (1 + HARD_STOP) ||
        held >= maxHold ||
        crossedDown;
      if (exit) {
        return [{ side: 'sell', symbol: SYM, qty: pos.qty, max_slippage_bps: SLIP_BPS }];
      }
      return [];
    }

    // --- flat: entry gates ---
    if (state.warmingUp) return [];
    if (closes.length < MIN_BAR || closes.length > LAST_ENTRY_BAR) return [];
    if (losses >= MAX_LOSSES) return [];
    if (seq - lastExitSeq < COOLDOWN) return [];
    if (trades >= MAX_TRADES) return [];

    const n = closes.length;
    // ret60/ret120 are -Infinity until enough bars exist; every leg below
    // requires its lookback to be real, so a leg can never fire on -Infinity.
    const ret60 = n >= 61 ? close / closes[n - 61] - 1 : -Infinity;
    const ret120 = n >= 121 ? close / closes[n - 121] - 1 : -Infinity;

    // Leg P: pullback to the fast EMA inside a rising regime. The slow EMA
    // must be rising over 60 bars (the regime filter: in a falling market
    // every EMA touch is a trap), the fast EMA must be above the slow one,
    // and the close must be touching the fast EMA from above with a positive
    // 60-bar return. No momentum-cross leg: both of its firings across the
    // two test windows were breakout failures that hit the hard stop.
    const regimeUp = slowHist.length >= 61 && emaSlow !== null && emaSlow > slowHist[slowHist.length - 61];
    if (
      gap !== null && gap > 0 && emaFast !== null && regimeUp &&
      close >= emaFast && close <= emaFast * (1 + P_TOUCH) &&
      ret60 > P_RET60
    ) {
      const amt = (state.cash * P_SIZE_NUM) / P_SIZE_DEN;
      if (amt >= 1_000_000n) {
        pendingLeg = 'P';
        return [{ side: 'buy', symbol: SYM, notional_quote_units: amt, max_slippage_bps: SLIP_BPS }];
      }
    }

    // Leg D: washout dip — deep 120-bar fall, price at the Donchian low,
    // this bar already bouncing (close above its open), and the fast EMA
    // already turning up (close above it): the bounce is confirmed, not hoped.
    // (n >= 121 is load-bearing: ret120 is -Infinity before that, and
    // -Infinity would pass the <= test and fire the leg on no data at all.)
    if (n >= 121 && ret120 <= D_RET120) {
      const bounce = close / donchianLow(DONCHIAN_N) - 1;
      if (bounce >= 0 && bounce <= D_LOW_GAP && close > opens[n - 1] && emaFast !== null && close > emaFast) {
        const amt = (state.cash * D_SIZE_NUM) / D_SIZE_DEN;
        if (amt >= 1_000_000n) {
          pendingLeg = 'D';
          return [{ side: 'buy', symbol: SYM, notional_quote_units: amt, max_slippage_bps: SLIP_BPS }];
        }
      }
    }

    // Insurance: no trade yet by bar 1200 -> buy 30% blind.
    if (trades === 0 && fills === 0 && closes.length >= I_BAR) {
      const amt = (state.cash * I_SIZE_NUM) / I_SIZE_DEN;
      if (amt >= 1_000_000n) {
        pendingLeg = 'I';
        return [{ side: 'buy', symbol: SYM, notional_quote_units: amt, max_slippage_bps: SLIP_BPS }];
      }
    }
    return [];
  },
});
