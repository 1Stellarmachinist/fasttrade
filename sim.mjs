// Event-driven backtest against a synthetic limit order book.
//
// There is no free historical L2 data with queue position, so the honest thing
// is to generate a book with the microstructure that actually decides whether a
// passive strategy survives:
//
//   * a latent efficient price that random-walks (so quotes go stale)
//   * informed aggressive flow that trades toward the new price (so stale
//     quotes get picked off -- this is "adverse selection", the thing that
//     kills market makers)
//   * size and queue ahead of us, so fills are not free
//
// This is a mechanism test, not a profit forecast. It tells you the *shape* of
// the trade-off, not the size of the cheque.

import { Book } from './book.mjs';
import { MarketMaker } from './strategy.mjs';
import { RiskGate } from './risk.mjs';
import { SimExchange } from './exchange.mjs';
import { pathToFileURL } from 'node:url';

// deterministic PRNG so sweeps are comparable
function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const TICKS = 40000;
const CENTER = 20000;

export function runBacktest({
  steps = 200_000,
  seed = 2024,
  lat = 3,          // how many market events our order is in flight for
  edge = 2,         // target half-spread, ticks
  qty = 4,
  maxInv = 60,
  makerFee = 0.0,
  jumpProb = 0.012, // probability per event that the efficient price jumps
  markoutEvents = 500,
  verbose = false,
} = {}) {
  const rnd = xorshift(seed);
  const book = new Book(0.01, 0, TICKS);
  const ex = new SimExchange(book, { lat, makerFee });
  const mm = new MarketMaker({ edge, invSkew: 0.10, maxInv, qty });
  const risk = new RiskGate({ maxPos: maxInv + 40, maxOrder: Math.max(qty * 3, 6), rate: 4000 });

  const expDraw = (mean) => -mean * Math.log(1 - rnd());

  let fair = CENTER;              // latent efficient price, in tick units

  // ---- seat the book around the latent price ----
  for (let i = 1; i <= 8; i++) {
    book.setBid(CENTER - i, Math.round(2 + expDraw(6)));
    book.setAsk(CENTER + i, Math.round(2 + expDraw(6)));
  }

  let maxPosSeen = 0;
  let replaced = 0;
  let adverseNotional = 0;   // signed markout of our fills, in ticks*size
  let markedVolume = 0;
  const openFills = [];      // { at, side, px, qty } awaiting markout

  // Requoting policy: hysteresis, not "chase every tick". A real maker only
  // pulls a quote when fair value has moved enough to pay for losing queue
  // priority. Without this you cancel on every book update and never fill.
  const hysteresis = 1;   // ticks of fair-value drift tolerated before requoting

  const quoteSide = (side, px, size, nowNs) => {
    if (px < 0) { ex.cancel(side); return; }
    const cur = side > 0 ? ex.bidOrder : ex.askOrder;

    if (cur && cur.alive && cur.active) {
      if (Math.abs(cur.px - px) < hysteresis) return;   // good enough: leave it working
    } else if (cur && cur.alive && !cur.active && cur.px === px) {
      return;                                            // still in flight to that price
    }

    if (cur && cur.alive) { ex.cancel(side); replaced++; }
    if (!risk.check(side, size, book.px(px), ex.pos, nowNs)) return;
    ex.place(side, px, size);
  };

  for (let ev = 0; ev < steps; ev++) {
    ex.seq = ev;

    // 1. orders sent earlier finish their wire delay and start working.
    //    Their queue position is read from the book *now* -- i.e. after
    //    anything that happened while our bytes were travelling.
    ex.activate();

    // 2. the efficient price moves. A true local random walk -- NO mean
    //    reversion. (An earlier version pulled fair back toward CENTER, which
    //    quietly handed the maker a free edge: every fill was bailed out by
    //    reversion. Don't reintroduce that.) Reflecting bounds only at the
    //    far edges keep the walk on the map.
    if (rnd() < jumpProb) {
      const dir = rnd() < 0.5 ? -1 : 1;
      const mag = rnd() < 0.85 ? 1 : 2 + Math.floor(rnd() * 3);
      fair += dir * mag;
      if (fair < 200) fair += 400;          // reflect off the map edges
      if (fair > TICKS - 200) fair -= 400;
    }
    const fairR = Math.round(fair);

    // 3. limit order arrivals pull the visible book toward the efficient price.
    if (rnd() < 0.62) {
      const side = rnd() < 0.5 ? 1 : -1;
      const off = Math.floor(-Math.log(1 - rnd()) * 2.2);
      const px = side > 0 ? fairR - 1 - off : fairR + 1 + off;
      if (px > 1 && px < TICKS - 1) {
        const sz = 1 + Math.floor(expDraw(4));
        if (side > 0) book.setBid(px, book.bid[px] + sz);
        else book.setAsk(px, book.ask[px] + sz);
      }
    }

    // 4. cancels ahead of us in the queue (we move up in line for free).
    if (rnd() < 0.14) {
      const side = rnd() < 0.5 ? 1 : -1;
      const lvl = Math.floor(-Math.log(1 - rnd()) * 2.2);
      const px = side > 0 ? book.bb - lvl : book.ba + lvl;
      const arr = side > 0 ? book.bid : book.ask;
      if (px > 0 && px < TICKS && arr[px] > 0) {
        const cut = Math.min(arr[px], 1 + Math.floor(expDraw(3)));
        if (side > 0) book.setBid(px, arr[px] - cut);
        else book.setAsk(px, arr[px] - cut);
        ex.advance(side, px, cut);
      }
    }

    // 5. aggressive flow, biased toward the efficient price => informed flow.
    if (rnd() < 0.34) {
      const midNow = book.mid();
      const bias = Math.max(-0.45, Math.min(0.45, (fair - midNow) * 0.35));
      const agg = rnd() < 0.5 + bias ? 1 : -1;   // +1 buys (hits asks)
      let remaining = 1 + Math.floor(expDraw(3.2));
      let px = agg > 0 ? book.ba : book.bb;
      let guard = 0;
      while (remaining > 0 && px > 0 && px < TICKS && guard++ < 12) {
        const avail = agg > 0 ? book.ask[px] : book.bid[px];
        if (avail > 0) {
          const take = Math.min(remaining, avail);
          if (agg > 0) book.setAsk(px, avail - take);
          else book.setBid(px, avail - take);
          const before = ex.fills;
          ex.onTrade(px, take, agg);
          if (ex.fills > before) {
            openFills.push({ at: ev, side: agg > 0 ? -1 : 1, px, qty: take });
          }
          remaining -= take;
        }
        px += agg > 0 ? 1 : -1;
      }
    }

    // 6. our decision, taken on the freshly observed book.
    const t = mm.target(book, ex.pos);
    if (t === null) {
      ex.cancel(1); ex.cancel(-1);
    } else {
      quoteSide(1, t.bidPx, t.bidQty, ev * 100_000);
      quoteSide(-1, t.askPx, t.askQty, ev * 100_000);
    }

    // 7. resolve markouts: did the price move against what we just bought/sold?
    while (openFills.length && ev - openFills[0].at >= markoutEvents) {
      const f = openFills.shift();
      const ref = book.mid();
      // we bought at f.px and the mid is `ref`: profit = ref - px, per unit
      adverseNotional += f.side * (ref - f.px) * f.qty;
      markedVolume += f.qty;
    }

    const ap = Math.abs(ex.pos);
    if (ap > maxPosSeen) maxPosSeen = ap;
  }

  const midNow = book.mid();
  const pnl = ex.equity();

  // split realised vs open risk: a run that "makes money" purely by holding a
  // lucky inventory is not a working strategy.
  const unrealised = ex.pos * (midNow - 0) * book.tick;
  const res = {
    steps, lat, edge, qty,
    pnl: +pnl.toFixed(2),
    fills: ex.fills,
    volume: ex.volume,
    pos: ex.pos,
    maxPos: maxPosSeen,
    orders: ex.ordersSent,
    cancels: ex.cancels,
    fillRate: ex.ordersSent ? +(ex.fills / ex.ordersSent).toFixed(3) : 0,
    markout: markedVolume ? +(adverseNotional / markedVolume).toFixed(4) : 0,
    // post-fill markout in ticks, measured `markoutEvents` later.
    // + = the mid moved our way after we traded. This is the number that
    // decays when you are slow: you get filled, then the price keeps going.
    markedVolume,
    fees: +ex.fees.toFixed(2),
    rejects: risk.rejects,
    fairDrift: +(fair - CENTER).toFixed(1),
  };
  if (verbose) console.log(res);
  return res;
}

// Latency sweep: identical market and seed, only wire delay changes.
export function latencySweep(latencies = [1, 2, 3, 5, 10, 25, 50, 100, 250], opts = {}) {
  return latencies.map((lat) => runBacktest({ ...opts, lat }));
}

// One market is one sample. Average over several so the latency conclusion is
// not an artefact of a single lucky random walk.
export function runAvg({ seeds = 10, ...opts } = {}) {
  const acc = { pnl: 0, fills: 0, volume: 0, markout: 0, marked: 0, fillRate: 0 };
  for (let i = 1; i <= seeds; i++) {
    const r = runBacktest({ ...opts, seed: 1000 + i * 7919 });
    acc.pnl += r.pnl;
    acc.fills += r.fills;
    acc.volume += r.volume;
    acc.markout += r.markout * r.markedVolume;
    acc.marked += r.markedVolume;
    acc.fillRate += r.fillRate;
  }
  const s = seeds;
  return {
    ...opts,
    pnl: +(acc.pnl / s).toFixed(2),
    fills: +(acc.fills / s).toFixed(1),
    volume: +(acc.volume / s).toFixed(1),
    fillRate: +(acc.fillRate / s).toFixed(3),
    markout: acc.marked ? +(acc.markout / acc.marked).toFixed(3) : 0,
  };
}

export function latencySweepAvg(latencies, opts = {}) {
  return latencies.map((lat) => runAvg({ ...opts, lat }));
}

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

if (isMain) {
  console.log('=== single run ===');
  runBacktest({ verbose: true });

  console.log('\n=== does latency matter? (10 markets averaged) ===');
  console.log('  lat |   avg pnl | fills |  fill% | markout/unit');
  for (const r of latencySweepAvg([1, 2, 3, 5, 10, 25, 50, 100, 250])) {
    console.log(
      `  ${String(r.lat).padStart(3)} | ${String(r.pnl).padStart(9)} | ` +
      `${String(r.fills).padStart(5)} | ${String(r.fillRate).padStart(6)} | ` +
      `${String(r.markout).padStart(12)}`
    );
  }

  console.log('\n=== does the edge setting matter? (lat=3, 10 markets) ===');
  for (const edge of [1, 2, 3, 4, 6, 8]) {
    const r = runAvg({ edge, lat: 3 });
    console.log(`  edge=${String(edge).padStart(2)}  pnl=${String(r.pnl).padStart(8)}  fills=${String(r.fills).padStart(6)}  markout=${r.markout}`);
  }
}
