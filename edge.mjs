// Is the gross edge real, or is it an artefact of one seed?
// Run many independent markets and look at the distribution of PnL and the
// t-statistic. A strategy whose edge is indistinguishable from zero is not
// a strategy, it is a random number generator with extra steps.

import { runBacktest } from './sim.mjs';

const N = 200;
const opts = { lat: 3, edge: 2 };

const pnls = [];
const fills = [];
for (let i = 0; i < N; i++) {
  const r = runBacktest({ ...opts, seed: 20_000 + i * 104_729 });
  pnls.push(r.pnl);
  fills.push(r.fills);
}

const mean = pnls.reduce((a, b) => a + b, 0) / N;
const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (N - 1);
const sd = Math.sqrt(variance);
const se = sd / Math.sqrt(N);
const t = mean / se;
const wins = pnls.filter((p) => p > 0).length;

pnls.sort((a, b) => a - b);
const q = (p) => pnls[Math.floor(p * (N - 1))];

console.log(`=== ${N} independent markets, lat=3, edge=2, fee=0 ===\n`);
console.log(`  mean pnl          $${mean.toFixed(3)}`);
console.log(`  std dev           $${sd.toFixed(3)}`);
console.log(`  std error         $${se.toFixed(3)}`);
console.log(`  t-statistic       ${t.toFixed(2)}`);
console.log(`  profitable runs   ${wins}/${N}  (${((wins / N) * 100).toFixed(0)}%)`);
console.log(`  median            $${q(0.5).toFixed(3)}`);
console.log(`  p05 / p95         $${q(0.05).toFixed(2)} / $${q(0.95).toFixed(2)}`);
console.log(`  worst / best      $${pnls[0].toFixed(2)} / $${pnls[N - 1].toFixed(2)}`);
console.log(`  mean fills        ${(fills.reduce((a, b) => a + b, 0) / N).toFixed(1)}`);

console.log('\n  histogram of per-market pnl:');
const lo = pnls[0], hi = pnls[N - 1];
const bins = 15;
const counts = new Array(bins).fill(0);
for (const p of pnls) {
  const idx = Math.min(bins - 1, Math.floor(((p - lo) / (hi - lo)) * bins));
  counts[idx]++;
}
const maxC = Math.max(...counts);
for (let i = 0; i < bins; i++) {
  const from = lo + (i / bins) * (hi - lo);
  console.log(
    `  ${from.toFixed(1).padStart(7)} | ${'#'.repeat(Math.round((counts[i] / maxC) * 42))} ${counts[i] || ''}`
  );
}

const verdict =
  t > 2 ? 'statistically positive (but tiny, and fee-free)'
  : t > 1 ? 'weak evidence, not conclusive'
  : 'INDISTINGUISHABLE FROM ZERO';
console.log(`\n  verdict: ${verdict}`);

// how many markets to resolve the edge?
const nNeeded = Math.ceil((2 * sd / mean) ** 2);
console.log(`\n  to establish this edge at t=2 you would need ~${nNeeded} independent markets.`);
console.log(`  that is the sample size. one backtest proves nothing.`);
