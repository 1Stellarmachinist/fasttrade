// Simulated exchange with the two things that decide whether a passive strategy
// actually makes money:
//
//  1. LATENCY -- an order is not working until `lat` events after you send it.
//     By then the queue at that price has grown, so you join the back of a
//     longer line. This single effect erases most of the paper profit that
//     naive backtests show.
//  2. QUEUE -- a trade at your price must consume the size resting ahead of you
//     before it touches your order.
//
// One working order per side, which is what a market maker actually sends.
// Fee defaults are generous (no maker fee); real maker fees change the answer.

export class SimExchange {
  constructor(book, { lat = 3, makerFee = 0, takerFee = 0.0003 } = {}) {
    this.book = book;
    this.lat = lat;
    this.makerFee = makerFee;
    this.takerFee = takerFee;
    this.bidOrder = null;
    this.askOrder = null;
    this.seq = 0;          // logical event clock
    this.pending = [];     // [{ at, side, px, qty, id }] in flight
    this.cash = 0;
    this.pos = 0;
    this.fills = 0;
    this.volume = 0;
    this.fees = 0;
    this.ordersSent = 0;
    this.cancels = 0;
  }

  // ---------------- order entry ----------------
  place(side, px, qty) {
    const id = ++this.ordersSent;
    const o = { id, side, px, qty, filled: 0, queue: 0, active: false, alive: true };
    this.pending.push({ at: this.seq + this.lat, o });
    if (side > 0) this.bidOrder = o; else this.askOrder = o;
    return o;
  }

  cancel(side) {
    const o = side > 0 ? this.bidOrder : this.askOrder;
    if (!o) return false;              // nothing working: no order on the wire
    o.alive = false;
    o.active = false;
    if (side > 0) this.bidOrder = null; else this.askOrder = null;
    this.cancels++;
    return true;
  }

  // Move orders that have arrived onto the book. Their queue position is fixed
  // from the CURRENT book depth: whatever accumulated while our bytes were in
  // flight is no longer ahead of us in theory, but it is in practice.
  activate() {
    if (this.pending.length === 0) return;
    const keep = [];
    const book = this.book;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.at <= this.seq) {
        const o = p.o;
        if (o.alive) {
          o.active = true;
          o.queue = o.side > 0 ? book.bid[o.px] : book.ask[o.px];
        }
      } else keep.push(p);
    }
    this.pending = keep;
  }

  // ---------------- market events ----------------
  // agg = -1 aggressor sold (hits bids), +1 aggressor bought (hits asks)
  onTrade(px, size, agg) {
    const o = agg < 0 ? this.bidOrder : this.askOrder;
    if (!o || !o.alive || !o.active) return;
    if (o.px !== px) return;   // a print at another level cannot touch us

    const q = o.queue;
    if (q >= size) { o.queue = q - size; return; }
    o.queue = 0;
    this._fill(o, Math.min(size - q, o.qty - o.filled), px);
  }

  // Someone ahead of us in the queue cancelled: we move up in line without
  // trading. Ignoring this understates fill rates.
  advance(side, px, delta) {
    const o = side > 0 ? this.bidOrder : this.askOrder;
    if (!o || !o.alive || !o.active || o.px !== px) return;
    o.queue = Math.max(0, o.queue - delta);
  }

  _fill(o, qty, px) {
    if (qty <= 0) return;
    const price = this.book.px(px);
    this.cash -= o.side * qty * price;
    this.pos += o.side * qty;
    const fee = qty * price * this.makerFee;
    this.cash -= fee;
    this.fees += fee;
    o.filled += qty;
    this.fills++;
    this.volume += qty;
    if (o.filled >= o.qty) {
      o.alive = false;
      o.active = false;
      if (o.side > 0) { if (this.bidOrder === o) this.bidOrder = null; }
      else { if (this.askOrder === o) this.askOrder = null; }
    }
  }

  equity() { return this.cash + this.pos * this.book.px(this.book.mid()); }
}
