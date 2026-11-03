// Pre-trade risk gate. Every order passes through here before it can reach the
// exchange. In a real system this is also where the venue's own risk API and
// kill switch get wired in.
//
// Rules are deliberately boring and hard-coded. Clever risk checks fail open.

export class RiskGate {
  constructor({ maxPos = 80, maxOrder = 20, maxNotional = 50000,
                rate = 2000, winNs = 1e9 } = {}) {
    this.maxPos = maxPos;
    this.maxOrder = maxOrder;
    this.maxNotional = maxNotional;
    this.rate = rate;          // max orders per window
    this.winNs = winNs;
    this._winStart = 0;
    this._count = 0;
    this.halted = false;
    this.reason = '';
    this.rejects = 0;
    this.rejectBy = Object.create(null);
  }

  check(side, qty, pxValue, pos, nowNs) {
    if (this.halted) return this._reject('halted');
    if (qty <= 0 || qty > this.maxOrder) return this._reject('size');

    const newPos = pos + side * qty;
    if (newPos > this.maxPos || newPos < -this.maxPos) return this._reject('position');
    if (qty * pxValue > this.maxNotional) return this._reject('notional');

    if (nowNs - this._winStart > this.winNs) {
      this._winStart = nowNs;
      this._count = 0;
    }
    if (++this._count > this.rate) return this._reject('rate');
    return true;
  }

  _reject(why) {
    this.rejects++;
    this.reason = why;
    this.rejectBy[why] = (this.rejectBy[why] || 0) + 1;
    return false;
  }

  // Kill switch: once tripped, nothing gets out until a human clears it.
  trip(why) { this.halted = true; this.reason = why; }
}
