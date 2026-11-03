// Live paper trading on real Coinbase market data. READ-ONLY: no orders are
// ever sent, no credentials are used. This subscribes to public level2 + matches
// and runs the fasttrade engine against the real book, simulating fills.
//
// Why bother with zero capital: it produces a verifiable track record and it
// shows you the two numbers that decide the strategy -- fill rate and markout --
// on data you did not get to choose. A backtest you designed proves nothing.

import { CoinbaseFeed } from './feed.mjs';
import { Book } from '../book.mjs';
import { MarketMaker } from '../strategy.mjs';
import { RiskGate } from '../risk.mjs';
import { SimExchange } from '../exchange.mjs';
import { writeFileSync } from 'node:fs';

const PRODUCT = process.env.PRODUCT || 'BTC-USD';
const RUNTIME_MS = Number(process.env.RUNTIME_MS || 60000);
const MAKER_FEE = Number(process.env.MAKER_FEE ?? 0.0040);   // 40 bps = Coinbase lowest tier
const EDGE_TICKS = Number(process.env.EDGE_TICKS || 2);
const QTY = Number(process.env.QTY || 0.0005);               // BTC units
const MARKOUT_MS = 5000;

const TICK = 0.01;
const SPAN = 400_000;            // +/- $2000 around the open, in $0.01 ticks
let BOOK;                        // created once we know the price
let LO = 0;
const touched = new Set();       // indices we have written, so we can clear them

const idx = (px) => Math.round((px - LO) / TICK);
const pxOf = (i) => LO + i * TICK;

let ex, mm, risk;
let frames = 0;
let lastMid = null;
let starts = 0;
let staleCleared = 0;

// markout bookkeeping: fills resolved against the mid MARKOUT_MS later
const openFills = [];
let markoutTicks = 0, markoutVol = 0;
let grossPnl = 0, netPnl = 0;

let midNow = null;
const t0 = Date.now();

// live latency measurement: how long one full decision costs, on real data
const latSamples = [];
let badFrames = 0;
const hr = () => process.hrtime.bigint();

function init(price) {
  LO = Math.round(price) - SPAN / 2 * TICK;   // center the window on the open
  BOOK = new Book(TICK, LO, SPAN);
  ex = new SimExchange(BOOK, { lat: 0, makerFee: MAKER_FEE });
  mm = new MarketMaker({ edge: EDGE_TICKS, invSkew: 0.05, maxInv: 200, qty: QTY });
  risk = new RiskGate({ maxPos: 400, maxOrder: QTY * 4, maxNotional: 100_000, rate: 5000 });
  console.log(`book initialised at ${price.toFixed(2)} (window ${pxOf(0).toFixed(0)}..${pxOf(SPAN - 1).toFixed(0)})`);
}

const feed = new CoinbaseFeed({
  products: [PRODUCT],
  channels: ['level2_batch', 'matches'],
  onBook: (product, b, kind) => {
    if (product !== PRODUCT) return;
    if (!BOOK) {
      const m = (b.bb + b.ba) / 2;
      if (!Number.isFinite(m) || m <= 0) return;
      init(m * TICK);
    }
    // Mirror the venue book into our hot-path book.
    //
    // The venue book (b.bid/b.ask maps) is the authority: level2_50 keeps full
    // state, and a deleted level simply disappears from the map. So we clear
    // every index we previously wrote and re-apply the current state. A partial
    // update would leave stale sizes behind, which silently corrupts the touch
    // (the first version produced negative spreads this way).
    for (const i of touched) { BOOK.setBid(i, 0); BOOK.setAsk(i, 0); }
    staleCleared += touched.size;
    touched.clear();

    for (const [c, s] of b.bid) {
      const i = idx(c / 100);
      if (i >= 0 && i < SPAN && s > 0) { BOOK.setBid(i, s); touched.add(i); }
    }
    for (const [c, s] of b.ask) {
      const i = idx(c / 100);
      if (i >= 0 && i < SPAN && s > 0) { BOOK.setAsk(i, s); touched.add(i); }
    }
    onBookReady();
  },
  onTrade: (t) => {
    if (!BOOK || t.product !== PRODUCT) return;
    const i = idx(t.priceCents / 100);
    if (i < 0 || i >= SPAN) return;
    // `side` on a Coinbase match is the MAKER side.
    // maker sold => aggressor bought (lifted the ask) => agg = +1
    const agg = t.makerSide === 'sell' ? 1 : -1;
    const before = ex.fills;
    ex.seq++;
    ex.activate();
    ex.onTrade(i, t.size, agg);
    if (ex.fills > before) {
      openFills.push({ at: Date.now(), side: agg > 0 ? -1 : 1, px: i, qty: t.size });
    }
  },
  onStatus: (s) => {
    if (s.type === 'open') { starts++; if (starts > 1) console.log('reconnecting...'); }
    if (s.type === 'subscribed') console.log(`subscribed to ${s.channels.map((c) => c.name).join(', ')}`);
    if (s.type === 'feedError') console.log(`feed error: ${s.message}`);
  },
}).start();

function onBookReady() {
  if (!BOOK || !mm) return;
  frames++;
  midNow = pxOf(BOOK.mid());
  lastMid = midNow;

  // reject obviously corrupt frames rather than quoting into them
  const sp = BOOK.ba - BOOK.bb;
  if (BOOK.bb < 0 || BOOK.ba >= SPAN || sp <= 0 || sp > 1000) { badFrames++; return; }

  // advance the simulated clock and let in-flight orders start working, even
  // if no trade has printed (the first version only did this on trades, so a
  // quiet market left orders permanently pending)
  ex.seq++;
  ex.activate();

  // resolve markouts
  const now = Date.now();
  while (openFills.length && now - openFills[0].at >= MARKOUT_MS) {
    const f = openFills.shift();
    const ref = idx(midNow);
    markoutTicks += f.side * (ref - f.px) * f.qty;
    markoutVol += f.qty;
  }

  // run the strategy on the real book
  const tStart = hr();
  const t = mm.target(BOOK, ex.pos);
  if (t === null) { ex.cancel(1); ex.cancel(-1); }
  else {
    quote(1, t.bidPx, t.bidQty, now);
    quote(-1, t.askPx, t.askQty, now);
  }
  if (latSamples.length < 200_000) latSamples.push(Number(hr() - tStart));
}

function quote(side, pxIndex, qty, nowNs) {
  if (pxIndex < 0) { ex.cancel(side); return; }
  const cur = side > 0 ? ex.bidOrder : ex.askOrder;
  if (cur && cur.alive && cur.active && Math.abs(cur.px - pxIndex) < 1) return;
  if (cur && cur.alive && !cur.active && cur.px === pxIndex) return;
  if (cur && cur.alive) ex.cancel(side);
  if (!risk.check(side, qty, pxOf(pxIndex), ex.pos, nowNs * 1000)) return;
  ex.place(side, pxIndex, qty);
}

// ---- periodic status ----
const status = setInterval(() => {
  if (!BOOK) return;
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const notional = ex.fills * QTY * (midNow || 0);
  const feeCost = notional * MAKER_FEE;
  const gross = ex.equity();
  console.log(
    `[${secs.padStart(3)}s] mid ${midNow?.toFixed(2)}  spread ${BOOK.spread()}t  ` +
    `pos ${ex.pos.toFixed(5)}  fills ${ex.fills}  orders ${ex.ordersSent}  ` +
    `grossPnL ${gross.toFixed(4)}  fees ${feeCost.toFixed(4)}  net ${(gross - feeCost).toFixed(4)}`
  );
}, 10000);
status.unref?.();

setTimeout(finish, RUNTIME_MS);

function finish() {
  clearInterval(status);
  feed.stop();
  if (!BOOK || frames === 0) {
    console.log('\nno data received; aborting');
    process.exit(1);
  }
  const notional = ex.fills * QTY * (midNow || 0);
  const feeCost = notional * MAKER_FEE;
  const gross = ex.equity();
  const net = gross - feeCost;
  const midTicks = markoutVol ? markoutTicks / markoutVol : 0;
  const bpsOfNotional = notional > 0 ? (net / notional) * 10_000 : 0;

  console.log('\n=== paper trading summary (real Coinbase data, simulated fills) ===');
  console.log(`  product              ${PRODUCT}`);
  console.log(`  runtime              ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  book frames          ${frames}`);
  console.log(`  orders sent          ${ex.ordersSent}  (cancels ${ex.cancels})`);
  console.log(`  fills                ${ex.fills}`);
  console.log(`  fill rate            ${(ex.fills / Math.max(1, ex.ordersSent) * 100).toFixed(2)}%`);
  console.log(`  volume traded        ${ex.volume.toFixed(6)} units`);
  console.log(`  notional traded      $${notional.toFixed(2)}`);
  console.log(`  final position       ${ex.pos.toFixed(6)}`);
  console.log(`  gross PnL            $${gross.toFixed(4)}`);
  console.log(`  fees (${(MAKER_FEE * 1e4).toFixed(1)} bps)         -$${feeCost.toFixed(4)}`);
  console.log(`  NET PnL              $${net.toFixed(4)}`);
  console.log(`  net as bps of notional ${bpsOfNotional.toFixed(2)} bps`);
  console.log(`  markout per unit     ${midTicks.toFixed(2)} ticks (${(midTicks * 100).toFixed(0)} x $0.01)`);
  console.log(`  bad frames skipped   ${badFrames}`);

  if (latSamples.length) {
    latSamples.sort((a, b) => a - b);
    const q = (p) => latSamples[Math.min(latSamples.length - 1, Math.floor(p * latSamples.length))];
    const p50 = q(0.5), p99 = q(0.99), max = latSamples[latSamples.length - 1];
    console.log(`\n  decision latency on live data (${latSamples.length} decisions):`);
    console.log(`    p50 ${p50} ns   p99 ${p99} ns   max ${max} ns`);
    console.log(`    a human takes ~250 ms = ${(250e6 / Math.max(1, p50)).toLocaleString('en-US', { maximumFractionDigits: 0 })}x slower`);
  }
  console.log(`\n  READ-ONLY: no orders were placed. This is a simulation against`);
  console.log(`  live market data. Fill modelling is optimistic (no queue position`);
  console.log(`  for our orders, lat=0), so treat these as an upper bound.`);

  writeFileSync('paper_result.json', JSON.stringify({
    product: PRODUCT, runtimeMs: Date.now() - t0, makerFee: MAKER_FEE,
    frames, orders: ex.ordersSent, fills: ex.fills, volume: ex.volume,
    notional, gross, feeCost, net, markoutTicks: midTicks, pos: ex.pos,
  }, null, 2));
  console.log('\n  wrote paper_result.json');
  process.exit(0);
}
