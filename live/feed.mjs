// Coinbase public market-data client. Read-only by construction: this module
// contains no order-entry code and no credentials. It can only subscribe to
// public market data channels.
//
// Book model: prices are integer cents (Math.round(px * 100)) so comparisons are
// exact and there is no float drift. Depth comes from level2_50, which the
// public (unauthenticated) endpoint silently serves in place of level2_batch.

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

export class CoinbaseFeed {
  constructor({ products, channels = ['ticker'], onTicker, onBook, onTrade, onStatus } = {}) {
    this.products = products;
    this.channels = channels;
    this.onTicker = onTicker;
    this.onBook = onBook;
    this.onTrade = onTrade;
    this.onStatus = onStatus;
    this.ws = null;
    this.books = new Map();   // product -> { bid: Map<cents,size>, ask: Map, bb, ba }
    this.connected = false;
    this.stopped = false;          // set by stop(); blocks the reconnect loop
    this.msgCount = 0;
    this.reconnects = 0;
    this.lastMsgAt = 0;
    this._retryTimer = null;
  }

  start() {
    this.stopped = false;
    this._connect();
    return this;
  }

  _connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopped) { try { ws.close(); } catch {} return; }
      this.connected = true;
      this.lastMsgAt = Date.now();
      this.onStatus?.({ type: 'open' });
      // Coinbase rejects oversized subscriptions; send in modest chunks.
      const chunk = 20;
      for (let i = 0; i < this.products.length; i += chunk) {
        const part = this.products.slice(i, i + chunk);
        ws.send(JSON.stringify({ type: 'subscribe', product_ids: part, channels: this.channels }));
      }
    };

    ws.onmessage = (e) => {
      this.msgCount++;
      this.lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this._handle(m);
    };

    ws.onerror = () => this.onStatus?.({ type: 'error' });

    ws.onclose = () => {
      this.connected = false;
      if (this.stopped) return;          // deliberate shutdown: do not resurrect
      this.onStatus?.({ type: 'closed' });
      // simple capped backoff; the feed drops connections during maintenance
      const delay = Math.min(1000 * (1 + this.reconnects), 15000);
      this.reconnects++;
      this._retryTimer = setTimeout(() => this._connect(), delay);
      this._retryTimer.unref?.();        // never hold the process open by itself
    };
  }

  _book(product) {
    let b = this.books.get(product);
    if (!b) {
      b = { bid: new Map(), ask: new Map(), bb: -1, ba: Number.MAX_SAFE_INTEGER, seq: 0 };
      this.books.set(product, b);
    }
    return b;
  }

  _handle(m) {
    switch (m.type) {
      case 'subscriptions':
        this.onStatus?.({ type: 'subscribed', channels: m.channels });
        break;

      case 'snapshot': {
        const b = this._book(m.product_id);
        b.bid.clear(); b.ask.clear(); b.bb = -1; b.ba = Number.MAX_SAFE_INTEGER;
        for (const [p, sz] of m.bids || []) {
          const c = Math.round(parseFloat(p) * 100);
          const s = parseFloat(sz);
          if (s > 0) { b.bid.set(c, s); if (c > b.bb) b.bb = c; }
        }
        for (const [p, sz] of m.asks || []) {
          const c = Math.round(parseFloat(p) * 100);
          const s = parseFloat(sz);
          if (s > 0) { b.ask.set(c, s); if (c < b.ba) b.ba = c; }
        }
        this.onBook?.(m.product_id, b, 'snapshot');
        break;
      }

      case 'l2update': {
        const b = this._book(m.product_id);
        for (const [side, p, sz] of m.changes) {
          const c = Math.round(parseFloat(p) * 100);
          const s = parseFloat(sz);
          const arr = side === 'buy' ? b.bid : b.ask;
          if (s === 0) arr.delete(c); else arr.set(c, s);
        }
        // recompute best lazily only if the touch was affected
        if (!b.bid.has(b.bb)) {
          let best = -1;
          for (const k of b.bid.keys()) if (k > best) best = k;
          b.bb = best;
        }
        if (!b.ask.has(b.ba)) {
          let best = Number.MAX_SAFE_INTEGER;
          for (const k of b.ask.keys()) if (k < best) best = k;
          b.ba = best;
        }
        this.onBook?.(m.product_id, b, 'update');
        break;
      }

      case 'match':
      case 'last_match': {
        // `side` is the MAKER side. So side='sell' means a seller was resting
        // and a buyer crossed -> the aggressor lifted the ask.
        this.onTrade?.({
          product: m.product_id,
          priceCents: Math.round(parseFloat(m.price) * 100),
          size: parseFloat(m.size),
          makerSide: m.side,
          time: m.time,
          seq: m.sequence,
        });
        break;
      }

      case 'ticker': {
        this.onTicker?.({
          product: m.product_id,
          bidCents: m.best_bid ? Math.round(parseFloat(m.best_bid) * 100) : null,
          askCents: m.best_ask ? Math.round(parseFloat(m.best_ask) * 100) : null,
          bidSize: m.best_bid_size ? parseFloat(m.best_bid_size) : null,
          askSize: m.best_ask_size ? parseFloat(m.best_ask_size) : null,
          lastCents: m.price ? Math.round(parseFloat(m.price) * 100) : null,
          time: m.time,
        });
        break;
      }

      case 'heartbeat':
        this.onStatus?.({ type: 'heartbeat' });
        break;

      case 'error':
        this.onStatus?.({ type: 'feedError', message: m.message, reason: m.reason });
        break;
    }
  }

  stop() {
    this.stopped = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.close(); } catch {}
    }
  }
}

// List tradable USD products via the public REST endpoint.
export async function fetchUsdProducts() {
  const r = await fetch('https://api.exchange.coinbase.com/products', {
    headers: { 'User-Agent': 'fasttrade-readonly/1.0' },
  });
  if (!r.ok) throw new Error(`products HTTP ${r.status}`);
  const all = await r.json();
  return all
    .filter((p) => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map((p) => ({ id: p.id, base: p.base_currency, quote: p.quote_currency }));
}

// The most liquid USD products first.
//
// Careful: /products/stats reports volume in BASE currency units, so ranking by
// raw volume puts PEPE (1e12 coins) above BTC. Multiply by price to get a
// quote-currency (USD-ish) proxy. Without this you scan a long tail of dead
// markets whose wide spreads are just the absence of a counter-party.
export async function fetchLiquidUsdProducts(limit = 40) {
  const [products, statsRes] = await Promise.all([
    fetchUsdProducts(),
    fetch('https://api.exchange.coinbase.com/products/stats', {
      headers: { 'User-Agent': 'fasttrade-readonly/1.0' },
    }),
  ]);
  const stats = new Map();
  if (statsRes.ok) {
    const raw = await statsRes.json();
    // object keyed by product_id; tolerate an array shape too
    const entries = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, s]) => ({ product_id: id, ...s }));
    for (const s of entries) {
      const d = s?.stats_24hour || {};
      const volCoins = parseFloat(d.volume) || 0;
      const last = parseFloat(d.last) || 0;
      stats.set(s.product_id, { usdVolume: volCoins * last, last });
    }
  }
  return products
    .map((p) => ({ ...p, ...(stats.get(p.id) || { usdVolume: 0 }) }))
    .sort((a, b) => b.usdVolume - a.usdVolume)
    .slice(0, limit);
}
