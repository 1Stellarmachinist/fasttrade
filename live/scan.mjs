// Live spread scanner (REST).
//
// Uses the public REST ticker for every product, so coverage is complete and
// deterministic. The websocket `ticker` channel only emits on trades, which
// silently drops quiet products -- fine for a live feed, wrong for a survey.
//
// The question: is the quoted spread wide enough to cover the fees a maker pays
// on BOTH legs?
//
//      spread_bps  >  2 x maker_fee_bps
//
// A maker buys at the bid and sells at the ask. Gross per round trip is the
// spread; fees are paid on each fill. Everything else is downstream of this.

import { fetchUsdProducts } from './feed.mjs';

const SAMPLES = Number(process.env.SCAN_SAMPLES || 3);
const GAP_MS = Number(process.env.SCAN_GAP_MS || 1500);
const CONCURRENCY = 8;

const FEE_TIERS = [
  { label: 'lowest tier (0.40%)', maker: 40 },
  { label: '$15k-250k volume', maker: 25 },
  { label: '$1M-15M volume', maker: 15 },
  { label: '$50M+ volume', maker: 8 },
  { label: 'stable-pair / rebate', maker: 0 },
];

const bps = (num, den) => (den > 0 ? (num / den) * 10_000 : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ticker(product) {
  const url = `https://api.exchange.coinbase.com/products/${product}/ticker`;
  const r = await fetch(url, { headers: { 'User-Agent': 'fasttrade-readonly/1.0' } });
  if (!r.ok) return null;
  const j = await r.json();
  const bid = parseFloat(j.bid), ask = parseFloat(j.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) return null;
  return { bid, ask, mid: (bid + ask) / 2, vol: parseFloat(j.volume) || 0 };
}

// bounded-concurrency map so we do not get rate-limited into oblivion
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

const t0 = Date.now();
const products = await fetchUsdProducts();
const ids = products.map((p) => p.id);
console.log(`probing ${ids.length} USD products, ${SAMPLES} samples each (public REST, read-only)\n`);

const acc = new Map();
for (let s = 0; s < SAMPLES; s++) {
  const res = await mapLimit(ids, CONCURRENCY, ticker);
  for (let k = 0; k < ids.length; k++) {
    const t = res[k];
    if (!t) continue;
    let a = acc.get(ids[k]);
    if (!a) acc.set(ids[k], (a = { spreads: [], last: t }));
    a.spreads.push(bps(t.ask - t.bid, t.mid));
    a.last = t;
  }
  process.stdout.write(`  sample ${s + 1}/${SAMPLES} done (${((Date.now() - t0) / 1000).toFixed(1)}s)\r`);
  if (s < SAMPLES - 1) await sleep(GAP_MS);
}
console.log(`\ncollected ${acc.size} products with valid two-sided quotes\n`);

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [...acc.entries()]
  .map(([product, a]) => ({
    product,
    n: a.spreads.length,
    med: median(a.spreads),
    min: Math.min(...a.spreads),
    max: Math.max(...a.spreads),
    px: a.last.mid,
  }))
  .sort((a, b) => b.med - a.med);

console.log('top 25 by median spread (bps of price):');
console.log('  product          n | median |   min |   max | price');
console.log('  -----------------|---|--------|-------|-------|----------');
for (const r of rows.slice(0, 25)) {
  console.log(
    `  ${r.product.padEnd(17)}${String(r.n).padStart(2)} | ${r.med.toFixed(2).padStart(6)} | ` +
    `${r.min.toFixed(2).padStart(5)} | ${r.max.toFixed(2).padStart(5)} | ${r.px.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
  );
}

console.log('\n=== the ones you would actually trade: tightest spreads ===');
console.log('  product          n | median bps | implied round-trip cost at 40bps maker fee');
for (const r of rows.slice(-8).reverse()) {
  const feeBps = 80;                       // 2 x 40
  const netBps = r.med - feeBps;
  console.log(
    `  ${r.product.padEnd(17)}${String(r.n).padStart(2)} | ${r.med.toFixed(2).padStart(10)} | ` +
    `spread ${r.med.toFixed(2)} - fee ${feeBps} = ${netBps.toFixed(2)} bps  ${netBps > 0 ? 'VIABLE' : 'loss'}`
  );
}

console.log('\n=== how many products clear each fee tier? ===\n');
for (const tier of FEE_TIERS) {
  const need = 2 * tier.maker;
  const viable = rows.filter((r) => r.med > need);
  console.log(
    `  ${tier.label.padEnd(22)} maker=${String(tier.maker).padStart(2)}bps ` +
    `need >${String(need).padStart(3)}bps  ->  ${String(viable.length).padStart(3)}/${rows.length}` +
    (viable.length ? `  e.g. ${viable.slice(0, 3).map((v) => `${v.product}(${v.med.toFixed(0)}bps)`).join(', ')}` : '')
  );
}

const liquid = rows.filter((r) => r.product.match(/(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|LINK|LTC|SUI)-USD$/));
console.log('\n=== the liquid majors (where you can actually get filled) ===\n');
for (const r of liquid.sort((a, b) => a.med - b.med)) {
  console.log(`  ${r.product.padEnd(10)} median spread ${r.med.toFixed(3).padStart(7)} bps   (fee is 40 bps at the lowest tier)`);
}

console.log(`\n  the widest spread among liquid majors is still ~${Math.max(...liquid.map((r) => r.med), 0).toFixed(2)} bps.`);
console.log('  40 bps of maker fee is 10-1000x that. market making the majors');
console.log('  on this fee schedule is not a small-margin business, it is a');
console.log('  donation. the wide-spread products are illiquid precisely because');
console.log('  nobody wants to hold them, which is the risk you would be paid for.');
console.log(`\n  scan took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
