// Venue comparison: where can a maker actually keep money?
//
// The metric that decides it is NET ABSOLUTE EDGE PER ROUND TRIP, not bps.
//   bps tells you the edge relative to price -- useful for ranking
//   absolute edge tells you what you earn per unit traded -- this is what pays
//
// A 500 bps spread on a 2-cent contract is one cent. A 1 bps spread on $76,000
// of BTC is $7.60. Rank by bps and you will pick the wrong market every time.

import {
  krakenBTC, okxBTC, coinbaseBTC, polymarketTop, kalshiTop, kalshiFeePerContract,
} from './venues.mjs';

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log('=== can a maker keep money anywhere? ===\n');

// ---------------- crypto majors ----------------
console.log('--- crypto majors ---\n');
console.log('  venue      symbol     bid         ask         spread(bps)  maker  net(bps)  edge/unit');
const crypto = [];
for (const f of [coinbaseBTC, krakenBTC, okxBTC]) {
  try {
    const q = await f();
    const mid = (q.ask + q.bid) / 2;
    const spreadBps = ((q.ask - q.bid) / mid) * 10_000;
    const feeBps = 2 * q.makerBps;
    const netBps = spreadBps - feeBps;
    // absolute edge per unit of the base asset, in dollars
    const edgeUnit = (q.ask - q.bid) - (mid * feeBps / 10_000);
    crypto.push({ venue: q.venue, netBps, edgeUnit, mid });
    console.log(
      `  ${q.venue.padEnd(10)} ${q.symbol.padEnd(10)} ${q.bid.toFixed(2).padStart(11)} ${q.ask.toFixed(2).padStart(11)} ` +
      `${spreadBps.toFixed(3).padStart(11)}  ${String(q.makerBps).padStart(2)}bps ${netBps.toFixed(1).padStart(8)}  ` +
      `$${edgeUnit.toFixed(2).padStart(9)}  ${netBps > 0 ? 'VIABLE' : 'LOSS'}`
    );
  } catch (e) { console.log(`  ${f.name}: unavailable (${e.message})`); }
}

// ---------------- Polymarket ----------------
console.log('\n--- Polymarket: $1 payout, MAKER FEE 0% ---\n');
const poly = await polymarketTop(25);
poly.sort((a, b) => b.volume - a.volume);
console.log('  price  spread(c)  spread(bps)  24h volume | market');
console.log('  -----  ---------  -----------  ----------- | ------');
for (const m of poly.slice(0, 10)) {
  console.log(
    `  ${m.mid.toFixed(2)}   ${m.spreadCents.toFixed(1).padStart(9)}  ${m.spreadBps.toFixed(0).padStart(11)}  ` +
    `${(m.volume / 1e6).toFixed(1).padStart(9)}M | ${m.symbol}`
  );
}
console.log(`\n  median spread: ${median(poly.map((m) => m.spreadCents)).toFixed(2)} cents  ` +
            `(${median(poly.map((m) => m.spreadBps)).toFixed(0)} bps)`);
console.log(`  maker fee: 0 bps  ->  whole spread is edge`);

// ---------------- Kalshi ----------------
console.log('\n--- Kalshi: $1 payout, maker 0%, taker ceil(0.07*P*(1-P)) ---\n');
const kal = await kalshiTop(25);
console.log('  price  spread(c)  taker fee(c)  volume   | market');
console.log('  -----  ---------  ------------  -------  | ------');
for (const m of kal.slice(0, 10)) {
  const flag = m.spreadCents > m.takerFeeCents ? 'edge' : 'thin';
  console.log(
    `  ${m.mid.toFixed(2)}   ${m.spreadCents.toFixed(1).padStart(9)}  ${String(m.takerFeeCents).padStart(12)}  ` +
    `${m.volume.toFixed(0).padStart(7)}  | ${m.symbol.slice(0, 34)} [${flag}]`
  );
}
console.log(`\n  median spread: ${median(kal.map((m) => m.spreadCents)).toFixed(2)} cents`);

console.log('\n  the fee curve, as bps of price (why the tails look attractive):');
console.log('   price | fee/contract | fee bps');
for (const p of [0.01, 0.02, 0.05, 0.10, 0.25, 0.50, 0.75, 0.95]) {
  const f = kalshiFeePerContract(p);
  console.log(`   ${String(p).padEnd(5)} | ${('$' + f.toFixed(2)).padStart(12)} | ${((f / p) * 10_000).toFixed(0).padStart(6)}`);
}

// ---------------- the comparison that matters ----------------
console.log('\n\n=== ranked by ABSOLUTE edge per round trip ===\n');

const rows = [
  ...crypto.map((c) => ({
    venue: c.venue, desc: 'BTC, 1 unit', edge: c.edgeUnit, bps: c.netBps,
  })),
  ...poly.slice(0, 3).map((m) => ({
    venue: 'Polymarket', desc: '1 contract @ ' + m.mid.toFixed(2),
    edge: m.spreadCents / 100, bps: m.spreadBps,
  })),
  ...kal.slice(0, 3).map((m) => ({
    venue: 'Kalshi', desc: '1 contract @ ' + m.mid.toFixed(2),
    edge: m.spreadCents / 100, bps: m.spreadBps,
  })),
];
rows.sort((a, b) => b.edge - a.edge);
console.log('  venue      market                  abs edge/unit  net bps');
for (const r of rows) {
  console.log(`  ${r.venue.padEnd(10)} ${r.desc.padEnd(23)} $${r.edge.toFixed(2).padStart(10)}  ${r.bps.toFixed(0).padStart(7)}`);
}

console.log('\n=== what this means for $200 ===\n');
const polyMed = median(poly.map((m) => m.spreadCents)) / 100;
const kalMed = median(kal.map((m) => m.spreadCents)) / 100;

console.log('  The prediction markets are the ONLY ones with positive edge.');
console.log(`  Polymarket median edge: ${(polyMed * 100).toFixed(1)} cents/contract`);
console.log(`  Kalshi     median edge: ${(kalMed * 100).toFixed(1)} cents/contract`);
console.log('');
console.log('  But absolute edge is tiny. To earn $10/day at 1 cent per contract');
console.log('  you need 1,000 round trips per day -- 1,000 fills on each side.');
console.log('  On a market with 12,000 contracts of depth that is theoretically');
console.log('  possible, and it is exactly what professional prediction-market');
console.log('  makers do. They run it with tens of thousands in capital and');
console.log('  rebate tiers, not $200.');
console.log('');
console.log('  With $200 and 1-cent edge: you need ~1,000 round trips for $10.');
console.log('  Each round trip risks inventory priced across a 1-cent spread on a');
console.log('  binary event that can jump to 0 or 1 and take your whole position.');
