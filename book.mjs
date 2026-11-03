// L2 order book built for the hot path.
//
// Design rules that matter more than the algorithm:
//   * prices are integer tick indices, never floats
//   * all state lives in preallocated typed arrays -> no allocation in the loop
//   * every mutation is O(1) amortised (one array store + a short inward walk)

export class Book {
  constructor(tick = 0.01, lo = 0, n = 40000) {
    this.tick = tick;      // price increment, currency units
    this.lo = lo;          // price of tick index 0
    this.n = n;            // tick indices available
    this.bid = new Float64Array(n);  // resting bid size per tick index
    this.ask = new Float64Array(n);  // resting ask size per tick index
    this.bb = -1;          // best bid index (-1 => side empty)
    this.ba = n;           // best ask index (n  => side empty)
    this.updates = 0;
  }

  // ---------------- hot path ----------------
  setBid(i, size) {
    this.updates++;
    this.bid[i] = size;
    if (size > 0) {
      if (i > this.bb) this.bb = i;
    } else if (i === this.bb) {
      let j = i;
      const b = this.bid;
      while (j >= 0 && b[j] === 0) j--;
      this.bb = j;
    }
  }

  setAsk(i, size) {
    this.updates++;
    this.ask[i] = size;
    if (size > 0) {
      if (i < this.ba) this.ba = i;
    } else if (i === this.ba) {
      let j = i;
      const a = this.ask;
      const n = this.n;
      while (j < n && a[j] === 0) j++;
      this.ba = j;
    }
  }

  // ---------------- derived views ----------------
  mid() {
    if (this.bb < 0 || this.ba >= this.n) return 0;
    return (this.bb + this.ba) * 0.5;
  }

  // Size-weighted fair value. A better predictor of the next move than mid,
  // because it leans toward whichever side has less resting liquidity.
  microprice() {
    const bb = this.bb, ba = this.ba;
    if (bb < 0 || ba >= this.n) return 0;
    const bs = this.bid[bb], az = this.ask[ba], tot = bs + az;
    if (tot === 0) return (bb + ba) * 0.5;
    return (bb * az + ba * bs) / tot;
  }

  imbalance() {
    const bb = this.bb, ba = this.ba;
    if (bb < 0 || ba >= this.n) return 0;
    const bs = this.bid[bb], az = this.ask[ba], tot = bs + az;
    return tot === 0 ? 0 : (bs - az) / tot;
  }

  spread() { return this.ba - this.bb; }
  px(i) { return this.lo + i * this.tick; }
}
