// Normalise several venues to a single shape so one comparison is possible.
//
// Every venue quotes differently:
//   crypto    -- dollars, small bps spreads, non-zero maker fees
//   prediction-- probability in [0,1], huge bps spreads near the tails, and
//                fee formulas that depend on price rather than notional

const j = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'fasttrade-readonly/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
};

// ---------- Kraken ----------
export async function krakenBTC() {
  const d = await j('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
  const k = Object.keys(d.result)[0];
  const t = d.result[k];
  const bid = parseFloat(t.b[0]), ask = parseFloat(t.a[0]);
  return { venue: 'Kraken', symbol: 'BTC/USD', bid, ask, tick: 0.1,
           makerBps: 25, note: 'base tier 0.25% maker' };
}

// ---------- OKX ----------
export async function okxBTC() {
  const d = await j('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT');
  const t = d.data[0];
  return { venue: 'OKX', symbol: 'BTC/USDT', bid: parseFloat(t.bidPx), ask: parseFloat(t.askPx),
           tick: 0.1, makerBps: 8, note: 'base tier 0.08% maker' };
}

// ---------- Coinbase (for continuity) ----------
export async function coinbaseBTC() {
  const d = await j('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
  return { venue: 'Coinbase', symbol: 'BTC-USD', bid: parseFloat(d.bid), ask: parseFloat(d.ask),
           tick: 0.01, makerBps: 40, note: 'lowest tier 0.40% maker' };
}

// ---------- Polymarket ----------
// Contracts pay $1 if the event resolves true. Price == probability.
// Maker fee is 0%; taker fees are charged on some categories, and 0 on others.
// Spread in bps of the contract's price is the relevant number, but the thing
// that actually matters is cents-per-contract versus the fee per contract.

const polyFeeBps = (price, takerFeeRate) => {
  // Polymarket's taker fee is symmetric around 0.5, proportional to p(1-p).
  // feePerContract = takerFeeRate * p * (1-p)  (in dollars)
  // as bps of price:  (fee / p) * 10000
  if (!takerFeeRate || price <= 0) return 0;
  return ((takerFeeRate * price * (1 - price)) / price) * 10_000;
};

export async function polymarketTop(n = 40) {
  // Sort by 24h volume. Sorting by lifetime `volume` returns dead novelty
  // markets with empty books (bid 0.01 / ask 1.00), which is how the first
  // version of this produced a nonsense 19,604 bps "spread".
  const raw = await j(`https://gamma-api.polymarket.com/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false`);
  const out = [];
  for (const m of raw) {
    const bid = m.bestBid != null ? parseFloat(m.bestBid) : null;
    const ask = m.bestAsk != null ? parseFloat(m.bestAsk) : null;
    const vol = parseFloat(m.volume24hr) || parseFloat(m.volume) || 0;
    if (bid == null || ask == null || !(ask > bid) || bid <= 0) continue;
    // reject empty books: a 1-cent bid and a 1-dollar ask is no market at all
    if (ask - bid > 0.25) continue;
    const mid = (bid + ask) / 2;
    out.push({
      venue: 'Polymarket',
      symbol: (m.question || m.slug || '').slice(0, 46),
      bid, ask, mid,
      tick: parseFloat(m.orderPriceMinTickSize) || 0.001,
      spreadBps: ((ask - bid) / mid) * 10_000,
      spreadCents: (ask - bid) * 100,
      makerBps: 0,                       // makers never pay
      takerBps: polyFeeBps(mid, 0.02),   // indicative: 2% peak fee rate
      volume: vol,
      liquidity: parseFloat(m.liquidity) || 0,
    });
    if (out.length >= n) break;
  }
  return out;
}

// ---------- Kalshi ----------
// Fee: ceil(0.07 * C * P * (1-P)) per order, so per contract at price P:
//   feePerContract = ceil(0.07 * P * (1-P) * 100)/100 for C=1 (cents, rounded up)
// As bps of price: (feePerContract / P) * 10000.
// This is why a 1-cent contract is the cheapest place to quote: the fee
// -> 0 as P -> 0 or 1.
export function kalshiFeePerContract(price) {
  const raw = 0.07 * price * (1 - price);
  return Math.ceil(raw * 100) / 100;      // rounded up to the next cent
}

export function kalshiFeeBps(price) {
  if (price <= 0) return 0;
  return (kalshiFeePerContract(price) / price) * 10_000;
}

export async function kalshiTop(n = 40) {
  // The /markets?status=open endpoint only exposes provisional combo markets
  // (5 live quotes in 12,000). The real liquidity is under /events with nested
  // markets: ~1,100 live two-sided markets per 200 events.
  const d = await j('https://api.elections.kalshi.com/trade-api/v2/events?limit=200&status=open&with_nested_markets=true');
  const out = [];
  for (const e of d.events || []) {
    for (const m of e.markets || []) {
      const yb = parseFloat(m.yes_bid_dollars), ya = parseFloat(m.yes_ask_dollars);
      const vol = parseFloat(m.volume_fp) || 0;
      if (!(ya > yb) || yb <= 0 || vol <= 0) continue;
      const mid = (yb + ya) / 2;
      out.push({
        venue: 'Kalshi',
        symbol: (m.title || m.ticker || e.title || '').slice(0, 46),
        bid: yb, ask: ya, mid,
        tick: 0.01,
        spreadBps: ((ya - yb) / mid) * 10_000,
        spreadCents: (ya - yb) * 100,
        makerBps: 0,                               // maker fee is 0 on most markets
        takerBps: kalshiFeeBps(mid),
        takerFeeCents: kalshiFeePerContract(mid),
        volume: vol,
      });
    }
  }
  out.sort((a, b) => b.volume - a.volume);
  return out.slice(0, n);
}

export const fmtPct = (x) => `${x.toFixed(2)}%`;
