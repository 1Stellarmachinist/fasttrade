// Where does the theoretically-earned spread go?
//
// A maker quoting a 2-tick wide market should capture ~1 tick per fill.
// If it only keeps a fraction of that, the leakage is the thing to fix --
// and it is usually adverse selection, not code.

import { Book } from './book.mjs';
import { MarketMaker } from './strategy.mjs';
import { RiskGate } from './risk.mjs';
import { SimExchange } from './exchange.mjs';

function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const TICKS = 40000, CENTER = 20000;

export function decompose({ steps = 200_000, seed = 5000, lat = 3, edge = 2,
                            qty = 4, maxInv = 60, jumpProb = 0.012 } = {}) {
  const rnd = xorshift(seed);
  const book = new Book(0.01, 0, TICKS);
  const ex = new SimExchange(book, { lat, makerFee: 0 });
  const mm = new MarketMaker({ edge, invSkew: 0.10, maxInv, qty });
  const risk = new RiskGate({ maxPos: maxInv + 40, maxOrder: Math.max(qty * 3, 6), rate: 4000 });
  const expDraw = (m) => -m * Math.log(1 - rnd());

  let fair = CENTER;
  for (let i = 1; i <= 8; i++) {
    book.setBid(CENTER - i, Math.round(2 + expDraw(6)));
    book.setAsk(CENTER + i, Math.round(2 + expDraw(6)));
  }

  const open = [];
  let spreadCapture = 0;   // ticks captured at the moment of the fill
  let markout = 0;         // ticks lost/gained as the mid moves after the fill
  let volume = 0;

  const quoteSide = (side, px, size, nowNs) => {
    if (px < 0) { ex.cancel(side); return; }
    const cur = side > 0 ? ex.bidOrder : ex.askOrder;
    if (cur && cur.alive && cur.active && Math.abs(cur.px - px) < 1) return;
    if (cur && cur.alive && !cur.active && cur.px === px) return;
    if (cur && cur.alive) ex.cancel(side);
    if (!risk.check(side, size, book.px(px), ex.pos, nowNs)) return;
    ex.place(side, px, size);
  };

  for (let ev = 0; ev < steps; ev++) {
    ex.seq = ev;
    ex.activate();

    // true local random walk, no mean reversion (see note in sim.mjs)
    if (rnd() < jumpProb) {
      const dir = rnd() < 0.5 ? -1 : 1;
      const mag = rnd() < 0.85 ? 1 : 2 + Math.floor(rnd() * 3);
      fair += dir * mag;
      if (fair < 200) fair += 400;
      if (fair > TICKS - 200) fair -= 400;
    }
    const fairR = Math.round(fair);

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

    if (rnd() < 0.34) {
      const midNow = book.mid();
      const bias = Math.max(-0.45, Math.min(0.45, (fair - midNow) * 0.35));
      const agg = rnd() < 0.5 + bias ? 1 : -1;
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
          const midAtFill = book.mid();
          ex.onTrade(px, take, agg);
          if (ex.fills > before) {
            const ourSide = agg > 0 ? -1 : 1;   // we were the resting order
            // spread captured: how far inside the mid we bought/sold
            spreadCapture += ourSide * (midAtFill - px) * take;
            open.push({ at: ev, side: ourSide, px, qty: take });
            volume += take;
          }
          remaining -= take;
        }
        px += agg > 0 ? 1 : -1;
      }
    }

    const t = mm.target(book, ex.pos);
    if (t === null) { ex.cancel(1); ex.cancel(-1); }
    else {
      quoteSide(1, t.bidPx, t.bidQty, ev * 100_000);
      quoteSide(-1, t.askPx, t.askQty, ev * 100_000);
    }

    while (open.length && ev - open[0].at >= 500) {
      const f = open.shift();
      markout += f.side * (book.mid() - f.px) * f.qty;
    }
  }

  const total = spreadCapture + markout;
  const perUnit = (x) => (volume ? x / volume : 0);
  return {
    volume,
    spreadCapture: spreadCapture,
    markout,
    total,
    perFillSpread: perUnit(spreadCapture),
    perFillMarkout: perUnit(markout),
    perFillNet: perUnit(total),
    idealPerFill: edge / 2,   // half the quoted spread
    pnl: ex.equity(),
  };
}

console.log('=== edge decomposition: where the spread goes ===\n');
console.log('  (all figures in ticks, per unit traded; ideal capture = 1.00 tick)\n');
console.log('  lat | ideal | captured | markout |    net | capture% | net% of ideal');
console.log('  ----|-------|----------|---------|--------|----------|--------------');

const rows = [1, 3, 10, 25, 100].map((lat) => ({ lat, ...decompose({ lat }) }));
for (const r of rows) {
  console.log(
    `  ${String(r.lat).padStart(3)} | ${r.idealPerFill.toFixed(2).padStart(5)} | ` +
    `${r.perFillSpread.toFixed(3).padStart(8)} | ${r.perFillMarkout.toFixed(3).padStart(7)} | ` +
    `${r.perFillNet.toFixed(3).padStart(6)} | ${((r.perFillSpread / r.idealPerFill) * 100).toFixed(1).padStart(7)}% | ` +
    `${((r.perFillNet / r.idealPerFill) * 100).toFixed(1).padStart(12)}%`
  );
}

const fast = rows[0], slow = rows[rows.length - 1];
console.log(`\n  This is the whole economics of market making in one table.`);
console.log(`  Spread capture is ~1 tick everywhere (${fast.perFillSpread.toFixed(2)} at lat=${fast.lat}, ` +
            `${slow.perFillSpread.toFixed(2)} at lat=${slow.lat}):`);
console.log(`  how far inside the mid you trade barely depends on speed.`);
console.log(`\n  What speed buys you is the MARKOUT, and it flips sign:`);
console.log(`    lat=${fast.lat}:  markout +${fast.perFillMarkout.toFixed(2)} ticks -> net +${fast.perFillNet.toFixed(2)}`);
console.log(`    lat=${slow.lat}: markout ${slow.perFillMarkout.toFixed(2)} ticks -> net ${slow.perFillNet.toFixed(2)}`);
console.log(`\n  Positive markout at low latency is not a bug: impatient takers push`);
console.log(`  the book, then resting limit orders arriving near fair value pull it`);
console.log(`  back. A fast maker provides liquidity into that 1-2 tick overshoot`);
console.log(`  and keeps it. A slow maker quotes a price that is already wrong, and`);
console.log(`  the informed flow picks it off before the book can come back.`);
console.log(`\n  Note that capture is >= 1 tick rather than "well below": we are`);
console.log(`  measuring fills that actually happened, which are a biased subset.`);
console.log(`  The fills you DON'T get (because someone beat you into the queue)`);
console.log(`  are the profitable ones. That absence is invisible in this table and`);
console.log(`  is exactly why slow fills look fine per-fill but lose overall.`);
