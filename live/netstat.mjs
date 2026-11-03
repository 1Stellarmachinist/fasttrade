// What does the network actually cost you?
//
// The engine's decision logic is ~100 ns. That number is irrelevant if the
// round trip to the venue is 100,000x larger. This measures the real thing:
// request -> first byte, and websocket message inter-arrival, from wherever
// this process happens to be running (a laptop, not a colo rack).

const N = 20;
const URL = 'https://api.exchange.coinbase.com/products/BTC-USD/ticker';

console.log('=== REST round trip to api.exchange.coinbase.com ===\n');
const rtts = [];
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(URL, { headers: { 'User-Agent': 'fasttrade-readonly/1.0' }, cache: 'no-store' });
  await r.text();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.ok) rtts.push(ms);
  process.stdout.write(`  ${i + 1}/${N}: ${ms.toFixed(1)} ms\r`);
  await new Promise((r2) => setTimeout(r2, 250));
}

rtts.sort((a, b) => a - b);
const q = (p) => rtts[Math.min(rtts.length - 1, Math.floor(p * rtts.length))];
console.log(`\n  samples ${rtts.length}`);
console.log(`  p50 ${q(0.5).toFixed(1)} ms   p90 ${q(0.9).toFixed(1)} ms   max ${rtts[rtts.length - 1].toFixed(1)} ms`);

// ---- websocket inter-arrival ----
console.log('\n=== websocket message cadence (level2, BTC-USD) ===\n');
const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
let gaps = [];
let count = 0;
let last = 0;
const GATHER = 12000;

await new Promise((resolve) => {
  const done = () => { try { ws.close(); } catch {} resolve(); };
  const timer = setTimeout(done, GATHER);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['level2_batch', 'matches'] }));
  };
  ws.onmessage = (e) => {
    const now = Date.now();
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'l2update' || m.type === 'match' || m.type === 'snapshot') {
      count++;
      if (last) gaps.push(now - last);
      last = now;
    }
  };
  ws.onerror = () => {};
});

const total = gaps.reduce((a, b) => a + b, 0);
const meanGap = gaps.length ? total / gaps.length : 0;
gaps.sort((a, b) => a - b);
console.log(`  messages ${count} in ${GATHER / 1000}s`);
console.log(`  mean gap ${meanGap.toFixed(1)} ms   median ${gaps.length ? gaps[gaps.length >> 1] : 0} ms`);
console.log(`  p10 ${gaps[Math.floor(gaps.length * 0.1)] ?? 0} ms (bursts this fast)`);

// ---- the comparison that matters ----
const rtt = q(0.5);
const decisionNs = 100;
const humanMs = 250;
console.log('\n=== where your latency actually goes ===\n');
const rows = [
  ['your decision code', decisionNs / 1e6, 'ms'],
  ['one-way network (est. rtt/2)', rtt / 2, 'ms'],
  ['full REST round trip', rtt, 'ms'],
  ['human reaction', humanMs, 'ms'],
];
const maxV = Math.max(...rows.map((r) => r[1]));
for (const [label, ms] of rows) {
  const len = Math.max(1, Math.round((ms / maxV) * 44));
  console.log(`  ${label.padEnd(32)} ${ms.toFixed(4).padStart(9)} ms  ${'#'.repeat(len)}`);
}
console.log(`\n  your code is ${(rtt / (decisionNs / 1e6)).toLocaleString('en-US', { maximumFractionDigits: 0 })}x smaller than the network hop.`);
console.log('  every microsecond you shave in code is invisible next to this.');
console.log('\n  a colocated participant at the venue is ~0.1-0.2 ms away.');
console.log(`  you are ~${rtt.toFixed(1)} ms away. you lose every queue race.`);
process.exit(0);
