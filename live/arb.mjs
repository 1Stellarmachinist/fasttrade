// Can the sockets be used to farm crypto via arbitrage?
//
// The only income path a read-only market-data feed could support is
// cross-venue arbitrage: buy where it's cheap, sell where it's dear.
// So measure it directly, simultaneously, net of the fees you'd actually pay.
//
// Arbitrage means TAKING on both legs (crossing the spread on each venue),
// so you pay TAKER fees on both sides. That is the number this computes.

const j = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'fasttrade-readonly/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// taker fees in bps (what you pay when you cross the spread)
const TAKER = {
  Coinbase: 60,   // 0.60% lowest tier
  Kraken:   40,   // 0.40%
  OKX:      10,   // 0.10%
};

async function snapshot() {
  const out = {};
  await Promise.all([
    (async () => {
      const d = await j('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
      out.Coinbase = { bid: +d.bid, ask: +d.ask };
    })().catch(() => {}),
    (async () => {
      const d = await j('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
      const t = d.result[Object.keys(d.result)[0]];
      out.Kraken = { bid: +t.b[0], ask: +t.a[0] };
    })().catch(() => {}),
    (async () => {
      const d = await j('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT');
      const t = d.data[0];
      out.OKX = { bid: +t.bidPx, ask: +t.askPx };
    })().catch(() => {}),
  ]);
  // OKX quotes USDT, not USD. Convert using a reference rate.
  if (out.OKX) {
    try {
      const d = await j('https://api.exchange.coinbase.com/products/USDT-USD/ticker');
      const rate = (+d.bid + +d.ask) / 2;
      out.OKX.usdtRate = rate;
      out.OKX.bidUsd = out.OKX.bid * rate;
      out.OKX.askUsd = out.OKX.ask * rate;
    } catch {
      out.OKX.usdtRate = 1;
      out.OKX.bidUsd = out.OKX.bid;
      out.OKX.askUsd = out.OKX.ask;
    }
  }
  return out;
}

const SAMPLES = 6;
const GAP = 1200;
const observations = [];

console.log('=== cross-venue BTC arbitrage, measured live ===\n');
console.log('sampling 3 venues simultaneously...\n');

for (let i = 0; i < SAMPLES; i++) {
  const s = await snapshot();
  const venues = Object.keys(s).filter((k) => s[k]?.bid);
  if (venues.length >= 2) {
    // best place to BUY = lowest ask; best place to SELL = highest bid
    let buyV = null, sellV = null;
    for (const v of venues) {
      const ask = v === 'OKX' ? s[v].askUsd : s[v].ask;
      const bid = v === 'OKX' ? s[v].bidUsd : s[v].bid;
      s[v].askUsdEff = ask; s[v].bidUsdEff = bid;
      if (!buyV || ask < s[buyV].askUsdEff) buyV = v;
      if (!sellV || bid > s[sellV].bidUsdEff) sellV = v;
    }
    if (buyV !== sellV) {
      const buyAt = s[buyV].askUsdEff;
      const sellAt = s[sellV].bidUsdEff;
      const grossBps = ((sellAt - buyAt) / buyAt) * 10_000;
      const feesBps = TAKER[buyV] + TAKER[sellV];
      observations.push({
        buyV, sellV, buyAt, sellAt,
        grossBps, feesBps, netBps: grossBps - feesBps,
      });
      process.stdout.write(
        `  ${i + 1}/${SAMPLES}  buy ${buyV}@${buyAt.toFixed(0)} sell ${sellV}@${sellAt.toFixed(0)}  ` +
        `gross ${grossBps.toFixed(1)} bps  fees ${feesBps} bps  net ${(grossBps - feesBps).toFixed(1)} bps\r`
      );
    }
  }
  if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, GAP));
}

console.log('\n');
if (!observations.length) {
  console.log('no cross-venue pairs captured');
  process.exit(0);
}

const gross = observations.map((o) => o.grossBps);
const net = observations.map((o) => o.netBps);
const max = Math.max(...gross);
const profitable = observations.filter((o) => o.netBps > 0).length;

console.log('  pair | buy              | sell             | gross bps | fees | net bps');
console.log('  -----|------------------|------------------|-----------|------|--------');
for (const o of observations) {
  console.log(
    `       | ${o.buyV.padEnd(8)} ${o.buyAt.toFixed(0).padStart(7)} | ` +
    `${o.sellV.padEnd(8)} ${o.sellAt.toFixed(0).padStart(7)} | ` +
    `${o.grossBps.toFixed(1).padStart(9)} | ${String(o.feesBps).padStart(4)} | ` +
    `${o.netBps.toFixed(1).padStart(7)}  ${o.netBps > 0 ? 'PROFIT' : 'loss'}`
  );
}

console.log(`\n  best gross dislocation observed: ${max.toFixed(1)} bps`);
console.log(`  taker fees round trip:            ${Math.min(...observations.map((o) => o.feesBps))}-${Math.max(...observations.map((o) => o.feesBps))} bps`);
console.log(`  profitable opportunities:         ${profitable}/${observations.length}`);
console.log(`  mean net:                         ${(net.reduce((a, b) => a + b, 0) / net.length).toFixed(1)} bps`);

console.log('\n  fees exceed the dislocation by roughly');
const ratios = observations.map((o) => o.feesBps / Math.max(0.01, o.grossBps));
console.log(`  ${Math.min(...ratios).toFixed(0)}x to ${Math.max(...ratios).toFixed(0)}x depending on the venue pair.`);
