# fasttrade

**A market-making engine, a queue-aware simulator, and six live venue adapters —
built to answer one question: is retail market making viable?**

The answer is no, and this repo measures why instead of assuming it.

Zero dependencies. Node 18+.

```
npm test              # 19 invariant tests
npm run bench         # hot-path latency, measured
npm run sim           # backtest, latency sweep, edge sweep
npm run venues        # six venues head-to-head, live
```

---

## The finding

Three independent measurements, all live, all reproducible:

| measurement | result |
|---|---|
| Decision loop (book update + strategy + risk) | **~120 ns** |
| vs human reaction time | **~2M×** faster |
| Spread on Coinbase BTC-USD | **0.001 bps** |
| Cheapest retail maker fee | **8 bps** (OKX) |
| Net edge per round trip, crypto majors | **−16 to −80 bps** |
| Cross-venue arbitrage dislocation | **1.4 bps** vs 50–100 bps fees |
| Prediction-market queue at the touch | **~87,000 contracts** |

Market making is negative on every crypto venue tested, and the two places where
the sign flips are guarded by walls this repo also measures.

Read [`CASE_STUDY.md`](CASE_STUDY.md) for the full write-up, or
[`live/VENUES.md`](live/VENUES.md) for the cross-venue detail.

---

## The bug log

The most useful thing here. Nine bugs, and **every one made the strategy look
*more* profitable than reality**. That is the failure mode, so the discipline is
to measure the quantity that would embarrass the thesis.

| # | Bug | Why it flattered the result |
|---|---|---|
| 1 | Frozen latent price | Latency couldn't hurt, so the sweep was noise |
| 2 | Requoting on every book tick | 383,000 cancels in 200,000 events; filled almost never |
| 3 | Mean-reverting latent price | Manufactured free edge — markout was positive at *every* latency |
| 4 | Stale levels in the live book mirror | Deleted levels persisted; bids drifted above asks (`spread -1927t`) |
| 5 | Orders that never activated | Clock only advanced on trades; quiet market left orders pending forever |
| 6 | `ticker` drops quiet products | Survey of 40 products returned data for 7 |
| 7 | Liquidity ranked by base volume | PEPE outranked BTC (Coinbase reports volume in coins) |
| 8 | Unkillable process | `stop()` closed the socket, `onclose` reconnected, no exit path |
| 9 | Wrong endpoints, silently | Kalshi: 5 live quotes in 12,000. Polymarket: 19,604 bps "spread" from empty books |

Bug 3 is the one that matters most: it was only caught because the sign was
physically implausible. It invalidated every earlier result in the project.

---

## What the simulator shows

**Latency is a queue penalty, not a delay.** An order isn't working until it
arrives, and its queue position is read from the book *at arrival* — so whatever
size accumulated in flight sits ahead of you. Same market, same seed, only the
wire delay changing, averaged over 10 markets:

```
lat |   avg pnl | fills |  fill% | markout/unit
  1 |      1.38 |  56.4 |  0.145 |        1.012
 10 |      0.68 |  36.2 |  0.097 |        0.804
 50 |      0.48 |  12.7 |  0.034 |        1.263
250 |      0.22 |   1.8 |  0.004 |        2.248
```

Fill rate falls 36×. You don't get slower fills — you get *almost none*, and the
ones you get are the ones nobody else wanted.

**Speed buys markout, and it flips sign.** Spread capture is ~1 tick at every
latency. What changes is whether the mid moves toward or away after the fill:

```
lat | ideal | captured | markout |    net
  1 |  1.00 |    0.995 |  +0.336 | +1.332
100 |  1.00 |    1.265 |  -1.510 | -0.245
```

---

## The fee wall

Measured live. Crypto charges a percentage of notional; prediction markets charge
makers nothing. That structural difference is the only reason the sign ever flips.

| venue | market | spread | maker fee | net / round trip |
|---|---|---|---|---|
| Coinbase | BTC-USD | 0.001 bps | 40 bps | **−80 bps** |
| Kraken | BTC/USD | 0.013 bps | 25 bps | **−50 bps** |
| OKX | BTC/USDT | 0.013 bps | 8 bps | **−16 bps** |
| Polymarket | event contracts | ~1 cent | **0 bps** | +1 cent |
| Kalshi | event contracts | ~1.8 cents | **0 bps** | +1.8 cents |

Kalshi's fee is `ceil(0.07 × P × (1−P))` per contract — it peaks at 50¢ and
vanishes at the tails (105 bps at 0.95, 10,000 bps at 0.01).

**Then the queue wall.** On prediction markets the spread *is* the minimum tick,
so every maker is forced to the same price:

| market | depth at touch | notional ahead of you |
|---|---|---|
| Polymarket — R Senate, R House | 457,914 | $22,896 |
| Polymarket — Dem House control | 2,143,931 | $2,015,295 |

A 5-contract order sits behind all of it and earns $0.05 per round trip.

---

## Why the nanosecond number doesn't matter

```
your code path                    120 ns  #
core-to-core hop, same box          2.0 us  #########
kernel bypass (DPDK/Solarflare)    20.0 us  ################
colocated cross-connect + ack     150.0 us  #######################
retail internet to exchange API    44.0 ms  ########################################
human reaction time               250.0 ms  ##############################################
```

Measured: **44 ms** REST round trip (p50) from a normal internet connection, and
a mean **41.7 ms** gap between websocket updates. Your code is 0.0003% of the
path to a colocated participant. Optimising it further is a rounding error.

Ranking what actually decides outcomes:

1. Physical distance to the matching engine
2. Queue position
3. Wire protocol and kernel
4. Strategy
5. Your code — this repo

---

## Install and run

```bash
git clone https://github.com/<you>/fasttrade.git
cd fasttrade
node --version     # needs 18+
npm test           # 19 tests, no install step, no dependencies
```

Everything uses public data. **No credentials, no API keys, no order entry.**

| command | what it does |
|---|---|
| `npm test` | 19 invariant tests (queue, risk, book, strategy) |
| `npm run bench` | hot-path latency + human/network comparison |
| `npm run sim` | backtest, latency sweep, edge sweep |
| `npm run fees` | fee sweep: where the strategy goes negative |
| `npm run edge` | 200-market distribution, t-stat, sample size |
| `npm run decompose` | spread capture vs markout, by latency |
| `npm run scenarios` | what $200 of capital actually does |
| `npm run scan` | spread vs fee across all Coinbase USD products |
| `npm run paper` | paper trade the engine on the live book |
| `npm run venues` | six venues head-to-head, ranked by absolute edge |
| `npm run queue` | queue depth: can you ever actually get filled? |
| `npm run netstat` | REST/websocket latency measurement |
| `npm run arb` | cross-venue arbitrage, net of taker fees |

---

## Design notes

- **Integer tick indices, never floats.** Price comparisons are exact.
- **Preallocated `Float64Array` book.** No allocation in the hot path, so no GC
  pauses.
- **O(1) book updates.** One array store plus a short inward walk.
- **Reservation-price quoting**, not a fixed spread — inventory leaning is built
  into the price rather than bolted on as a separate rule.
- **Hysteresis on requotes.** A real maker doesn't chase every book update,
  because repricing costs queue priority.
- **Fail-closed risk gate.** Boring, hard-coded, trips the kill switch rather than
  guessing.

---

## Scope, honestly

**What it demonstrates:** market-microstructure fluency (queue position, adverse
selection, markout, microprice, inventory skew, maker/taker economics);
performance engineering with receipts; empirical discipline (deterministic seeds,
200-market sampling, t-tests, sample size); and debugging across a hostile
boundary (live websockets, undocumented APIs, silent data-quality failures).

**What it does not:**
- No production trading system. No order entry, no auth, no FIX, no colocation.
- Not C++/Rust/FPGA. Real HFT is; this is readable JS with measured numbers.
- The strategy is not novel. Reservation-price market making is textbook.
- The synthetic market is not a profit forecast. It tests mechanism, not alpha.
- No P&L record. The live paper trade lost money, correctly modelled.

The value is not "I have a profitable strategy." It is: **I build measurement
apparatus, find the bugs in it, and report results that kill my own thesis.**

---

## Licence

MIT — see [`LICENSE`](LICENSE).
