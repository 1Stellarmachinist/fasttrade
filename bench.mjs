// Measures the hot path. This is the part of the claim that is checkable:
// how long one decision actually takes on this machine.
//
// Note what is NOT measured here: network round trip to an exchange (0.1-20 ms
// depending on colocation), exchange matching, and kernel/GC jitter. Those
// dominate real-world latency. This benchmark isolates the code.

import { Book } from './book.mjs';
import { MarketMaker } from './strategy.mjs';
import { RiskGate } from './risk.mjs';

const hr = () => process.hrtime.bigint();

function bench(name, fn, iters, warmup = Math.min(200_000, iters)) {
  for (let i = 0; i < warmup; i++) fn(i);          // let the JIT settle
  const t0 = hr();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = hr();
  const ns = Number(t1 - t0) / iters;
  return { name, ns, iters };
}

const fmt = (ns) =>
  ns >= 1000 ? `${(ns / 1000).toFixed(2)} us` : `${ns.toFixed(1)} ns`;

const results = [];

// ---- 1. single book update ----
{
  const book = new Book();
  for (let i = 1; i <= 20; i++) { book.setBid(20000 - i, 10); book.setAsk(20000 + i, 10); }
  let i = 0;
  results.push(bench('book update (1 level)', () => {
    const px = 19000 + (i++ % 2000);
    book.setBid(px, (i & 7) + 1);
  }, 5_000_000));
}

// ---- 2. strategy decision ----
{
  const book = new Book();
  for (let i = 1; i <= 20; i++) { book.setBid(20000 - i, 10 + i); book.setAsk(20000 + i, 10 + i); }
  const mm = new MarketMaker();
  let pos = 0;
  results.push(bench('strategy decision', () => {
    const t = mm.target(book, pos);
    pos = t ? (pos + 1) % 20 : pos;
  }, 5_000_000));
}

// ---- 3. risk check ----
{
  const risk = new RiskGate({ rate: 1e9 });
  let n = 0;
  results.push(bench('risk check', () => {
    risk.check(1, 4, 200, 0, n++ * 1000);
  }, 5_000_000));
}

// ---- 4. full decision loop: book -> strategy -> risk -> order ----
{
  const book = new Book();
  for (let i = 1; i <= 20; i++) { book.setBid(20000 - i, 10 + i); book.setAsk(20000 + i, 10 + i); }
  const mm = new MarketMaker();
  const risk = new RiskGate({ rate: 1e9 });
  let pos = 0, n = 0, sent = 0;
  results.push(bench('full tick (update+decide+risk)', () => {
    // keep a genuinely two-sided, non-crossed book so the strategy does its
    // full amount of work instead of bailing out early
    const bidPx = 19990 + (n % 8);
    const askPx = 20010 + (n % 8);
    book.setBid(bidPx, (n & 7) + 1);
    book.setAsk(askPx, (n & 7) + 1);
    const t = mm.target(book, pos);
    if (t && t.bidPx >= 0 && risk.check(1, t.bidQty, book.px(t.bidPx), pos, n * 1000)) {
      sent++; pos = ((pos + 1) % 40) - 20;
    }
    n++;
  }, 5_000_000));
}

console.log('=== hot path cost, measured on this machine ===');
for (const r of results) {
  console.log(`  ${r.name.padEnd(34)} ${fmt(r.ns).padStart(10)}   (${r.iters.toLocaleString()} iters)`);
}

// ---- 5. against a human ----
const HUMAN_REACTION_MS = 250;        // simple visual stimulus -> motor response
const HUMAN_DECISION_MS = 600;        // read a screen, decide, click
const tick = results[results.length - 1].ns;

const perHuman = (ms) => Math.floor((ms * 1e6) / tick);

console.log('\n=== same interval, human vs this loop ===');
console.log(`  one decision loop       ${fmt(tick)}`);
console.log(`  human reaction (~250ms) ${perHuman(HUMAN_REACTION_MS).toLocaleString()} loops`);
console.log(`  human decide+click(~600ms) ${perHuman(HUMAN_DECISION_MS).toLocaleString()} loops`);
console.log(`  speed ratio (250ms)     ~${Math.round((HUMAN_REACTION_MS * 1e6) / tick).toLocaleString()}x`);

// ---- 6. and against the actual competition ----
console.log('\n=== what actually decides winners, for scale ===');
const layers = [
  ['your code path (above)', tick],
  ['core-to-core hop on the same box', 2_000],
  ['same rack, kernel bypass (DPDK/Solarflare)', 20_000],
  ['colocated cross-connect: send + ack', 150_000],
  ['retail internet to an exchange API', 40_000_000],
  ['human reaction time', 250_000_000],
];
const maxNs = Math.max(...layers.map((l) => l[1]));
const minNs = Math.min(...layers.map((l) => l[1]));
const LOG_LO = Math.log10(minNs), LOG_HI = Math.log10(maxNs);
for (const [label, ns] of layers) {
  // log scale: on a linear axis the microsecond layers are all one pixel
  const frac = (Math.log10(ns) - LOG_LO) / (LOG_HI - LOG_LO);
  const len = Math.max(1, Math.round(frac * 46));
  const val = ns >= 1e9 ? `${(ns / 1e9).toFixed(2)} s`
            : ns >= 1e6 ? `${(ns / 1e6).toFixed(1)} ms`
            : ns >= 1000 ? `${(ns / 1000).toFixed(1)} us`
            : `${ns.toFixed(0)} ns`;
  console.log(`  ${label.padEnd(42)} ${val.padStart(8)} ${'#'.repeat(len)}`);
}
console.log('\n  Log scale. Your code is the thin bar on the left; network and');
console.log('  venue placement are the long bars. That is the whole story.');
