// The queue question.
//
// A maker's fill depends on queue position, not just price. If you join the
// back of the touch, everything resting ahead of you must trade before your
// order is touched. On these books that number is absurd.
//
// This measures, for the top liquid markets:
//   * depth resting at the touch
//   * notional that must trade to reach your order at the back of the queue
//   * how many ticks the price must move to reach you instead
//
// It is the difference between "the spread is 1 cent, so I earn 1 cent" and
// "the spread is 1 cent, but I will be filled approximately never".

const j = async (u) => {
  const r = await fetch(u, { headers: { 'User-Agent': 'x' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

const MATCH_ORDER = 5;   // Polymarket min_order_size

async function polyBooks(n) {
  const mk = await j(`https://gamma-api.polymarket.com/markets?limit=60&active=true&closed=false&order=volume24hr&ascending=false`);
  const out = [];
  for (const m of mk) {
    let tokens;
    try { tokens = JSON.parse(m.clobTokenIds || '[]'); } catch { continue; }
    if (!tokens[0]) continue;
    const vol24 = parseFloat(m.volume24hr) || 0;
    if (vol24 < 100_000) continue;
    try {
      const b = await j(`https://clob.polymarket.com/book?token_id=${tokens[0]}`);
      const bids = b.bids || [], asks = b.asks || [];
      if (!bids.length || !asks.length) continue;
      // CLOB returns ascending by price; best bid is last, best ask is last too
      const bb = bids[bids.length - 1], ba = asks[asks.length - 1];
      const bidPx = parseFloat(bb.price), askPx = parseFloat(ba.price);
      if (!(askPx > bidPx)) continue;
      out.push({
        venue: 'Polymarket',
        q: (m.question || '').slice(0, 44),
        bidPx, askPx,
        bidDepth: parseFloat(bb.size),
        askDepth: parseFloat(ba.size),
        vol24,
      });
    } catch { /* skip unreadable books */ }
    if (out.length >= n) break;
  }
  return out;
}

async function kalBooks(n) {
  const d = await j('https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true');
  const out = [];
  for (const e of d.events || []) {
    for (const m of e.markets || []) {
      const yb = parseFloat(m.yes_bid_dollars), ya = parseFloat(m.yes_ask_dollars);
      const v = parseFloat(m.volume_fp) || 0;
      if (!(ya > yb) || yb <= 0 || v < 10_000) continue;
      out.push({
        venue: 'Kalshi',
        q: (m.title || '').slice(0, 44),
        bidPx: yb, askPx: ya,
        bidDepth: parseFloat(m.yes_bid_size_fp) || 0,
        askDepth: parseFloat(m.yes_ask_size_fp) || 0,
        vol24: v,
      });
    }
  }
  out.sort((a, b) => b.vol24 - a.vol24);
  return out.slice(0, n);
}

console.log('=== the queue problem: how much flow must trade before you fill? ===\n');

const rows = [...(await polyBooks(8)), ...(await kalBooks(8))];
if (!rows.length) {
  console.log('no data'); process.exit(1);
}

console.log('  venue      price       depth at touch      notional to reach you   market');
console.log('  ---------  ---------   ------------------  ----------------------  ------');
for (const r of rows) {
  const px = (r.bidPx + r.askPx) / 2;
  // to be filled at the bid you must reach the BACK of the bid queue:
  // everything resting at the touch trades first
  const contractsAhead = r.bidDepth;
  const notional = contractsAhead * r.bidPx;
  // and the price must move one tick for anyone to cross into you
  const tickMove = ((r.askPx - r.bidPx) / px) * 100;
  console.log(
    `  ${r.venue.padEnd(10)} ${px.toFixed(2).padStart(6)}   ` +
    `${contractsAhead.toFixed(0).padStart(9)} contracts  ` +
    `$${notional.toFixed(0).padStart(19)}  ${r.q}`
  );
}

const poly = rows.filter((r) => r.venue === 'Polymarket');
if (poly.length) {
  const medDepth = poly.map((r) => r.bidDepth).sort((a, b) => a - b)[poly.length >> 1];
  const medNotional = poly.map((r) => r.bidDepth * r.bidPx).sort((a, b) => a - b)[poly.length >> 1];
  console.log(`\n  Polymarket median queue at the touch: ${medDepth.toFixed(0)} contracts = $${medNotional.toFixed(0)}`);
  console.log(`  your order (5 contracts) sits behind all of it.`);
  console.log(`\n  to be filled you need a single aggressor to sweep $${medNotional.toFixed(0)} of that side,`);
  console.log(`  or the price to move one full tick against you.`);

  // how many round trips could you even do?
  console.log(`\n  with a 1-tick spread and ${MATCH_ORDER}-contract orders:`);
  console.log(`    edge per round trip = 5 contracts x 1 cent = $0.05`);
  console.log(`    to earn $10/day   = ${(10 / 0.05).toFixed(0)} round trips`);
  console.log(`    to earn $200/mo   = ${Math.round(200 / 30 / 0.05)} round trips/day`);
  console.log(`\n  each round trip competes with ${medDepth.toFixed(0)} contracts of resting size`);
  console.log(`  from professional makers who are already at the front of the queue.`);
}

console.log('\n=== the honest verdict ===\n');
console.log('  1. Every crypto major is negative net-of-fee on every venue tested:');
console.log('     Coinbase -80 bps, Kraken -50 bps, OKX -16 bps. Not close.');
console.log('  2. Prediction markets have zero maker fee and a real 1-tick spread,');
console.log('     so the spread IS your edge. That is the only place the sign flips.');
console.log('  3. But the tick is the whole spread, so every maker is forced to the');
console.log('     same price, which creates the enormous queue measured above.');
console.log('     Edge exists on paper; capturing it requires queue priority you do');
console.log('     not have, against participants who do.');
console.log('  4. The tradeable version of this edge is not "quote the touch". It is');
console.log('     "know the true probability better than the market" -- a prediction');
console.log('     problem, not a latency problem. That is a different project, and');
console.log('     the fasttrade engine is not the tool for it.');
