// The question is not "does the strategy work", it is "does the gross edge
// survive the fee schedule". Run the same market at different maker fees and
// find where it goes negative.

import { runAvg } from './sim.mjs';

const FEES_BPS = [0, 0.2, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0];

console.log('maker fee sweep (10 markets each, lat=3, edge=2 ticks, qty=4)');
console.log('instrument ~$200, tick $0.01, so 1 tick = 5 bps of price\n');
console.log('  fee(bps) | avg pnl 10mkts | avg fills | pnl per fill | verdict');
console.log('  ---------|----------------|-----------|--------------|--------');

let breakEven = null;
for (const bps of FEES_BPS) {
  const r = runAvg({ makerFee: bps / 10_000, lat: 3, edge: 2 });
  const perFill = r.fills > 0 ? r.pnl / r.fills : 0;
  if (breakEven === null && r.pnl < 0) breakEven = bps;
  const verdict = r.pnl > 0 ? 'ok' : 'NEGATIVE';
  console.log(
    `  ${String(bps).padStart(8)} | ${String(r.pnl).padStart(14)} | ` +
    `${String(r.fills).padStart(9)} | ${perFill.toFixed(4).padStart(12)} | ${verdict}`
  );
}

console.log(`\n  gross edge per fill (fee=0): see row 1`);
if (breakEven !== null) {
  console.log(`  strategy goes NEGATIVE between ${FEES_BPS[FEES_BPS.indexOf(breakEven) - 1]} and ${breakEven} bps maker fee`);
}

// ---- what does that mean for a real account ----
console.log('\n=== what the fee math means in dollars ===');

const market = runAvg({ makerFee: 0, lat: 3, edge: 2 });
// reconstruct traded notional: fills * qty * price
const px = 200;         // mid price in the sim
const qty = 4;
const tradedNotional = market.fills * qty * px;
const grossEdgeBps = (market.pnl / tradedNotional) * 10_000;

console.log(`  avg fills per run            ${market.fills}`);
console.log(`  notional traded per run      $${tradedNotional.toFixed(0)}`);
console.log(`  gross edge                   ${grossEdgeBps.toFixed(2)} bps of notional`);
console.log(`  net per run                  $${market.pnl}`);

console.log('\n  to earn a given income at that edge, you must turn over:');
for (const target of [1_000, 10_000, 50_000, 250_000]) {
  const turnover = target / (grossEdgeBps / 10_000);
  console.log(`    $${String(target).padStart(7)}/yr  ->  $${(turnover / 1e6).toFixed(1)}M notional/yr  ` +
              `($${(turnover / 252 / 1e3).toFixed(0)}k/day)`);
}

console.log('\n  and at a top-tier crypto venue (2 bps maker, no rebate):');
const at2bps = runAvg({ makerFee: 0.0002, lat: 3, edge: 2 });
console.log(`    net per run = $${at2bps.pnl}  (gross $${market.pnl})`);
console.log(`    you are paying ${(2 / grossEdgeBps).toFixed(1)}x your gross edge in fees.`);
