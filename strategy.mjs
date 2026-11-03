// Passive market-making strategy.
//
// The quote is a reservation price, not a fixed spread: we lean against our own
// inventory so that being long makes us a cheaper seller and a dearer buyer.
// This is the single most important risk control in a market maker -- without it
// you accumulate position exactly when you are wrong.

export class MarketMaker {
  constructor({ edge = 2, invSkew = 0.10, maxInv = 60, qty = 4 } = {}) {
    this.edge = edge;        // target half-spread we try to earn, in ticks
    this.invSkew = invSkew;  // ticks of lean per unit of inventory
    this.maxInv = maxInv;    // hard inventory cap per side
    this.qty = qty;          // size per quote
  }

  // Returns { bidPx, bidQty, askPx, askQty } in tick indices (px === -1 => no quote)
  target(book, pos) {
    const bb = book.bb, ba = book.ba;
    if (bb < 0 || ba >= book.n || ba - bb < 1) return null;

    const fair = book.microprice() - this.invSkew * pos;
    const half = this.edge * 0.5;

    let bid = Math.round(fair - half);
    let ask = Math.round(fair + half);

    // never cross; join the touch if a fair-value quote would cross it
    if (bid > bb) bid = bb;
    if (ask < ba) ask = ba;
    if (ask <= bid) return null;

    const out = { bidPx: bid, bidQty: this.qty, askPx: ask, askQty: this.qty };
    if (pos >= this.maxInv) out.bidPx = -1;
    if (pos <= -this.maxInv) out.askPx = -1;
    if (out.bidPx < 0 && out.askPx < 0) return null;
    return out;
  }
}
