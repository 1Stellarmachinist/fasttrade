# Case study: building a market maker, then proving it loses money

Most quant portfolio projects claim a Sharpe ratio. This one claims the opposite:
a working low-latency market-making engine, a queue-aware simulator, six live
venue adapters — and a measured conclusion that the strategy is unprofitable at
retail fee tiers.

That is the point. Here is why it is the more valuable thing to show.

## The short version

| | |
|---|---|
| Decision loop | **~120 ns** (book update + strategy + risk) |
| vs human reaction | **~2M** loops per 250 ms |
| Backtested | 200 independent markets, t-stat 10.5 |
| Live venue test | **−80 bps** net on Coinbase BTC-USD |
| Where it flips | prediction markets, 0 bps maker fee |
| Why that still fails | ~87,000-contract queue at the touch |

## What was built

Seven modules, zero dependencies, Node 18+:

- **`book.mjs`** — L2 order book on integer tick indices with preallocated
  typed arrays. No allocation in the hot path, O(1) updates.
- **`strategy.mjs`** — market maker quoting a *reservation price* derived from
  microprice, skewed by inventory. Not a fixed spread.
- **`risk.mjs`** — fail-closed pre-trade gate: size, position, notional, rate
  limiter, kill switch.
- **`exchange.mjs`** — simulator modelling the two effects that decide whether a
  passive strategy survives: **latency as a queue penalty**, and **queue
  position** requiring size ahead of you to trade first.
- **`sim.mjs`** — synthetic market with a latent efficient price and informed
  order flow. Deterministic seeds so sweeps are comparable.
- **`live/`** — read-only adapters for Coinbase, Kraken, OKX, Polymarket,
  Kalshi. No credentials, no order entry.
- **`test.mjs`** — 19 invariant tests.

## The measurements

**Latency is a queue penalty, not a delay.** Same market, only the wire delay
changing, averaged over 10 markets:

```
lat |   avg pnl | fills |  fill% | markout/unit
  1 |      1.38 |  56.4 |  0.145 |        1.012
 10 |      0.68 |  36.2 |  0.097 |        0.804
 50 |      0.48 |  12.7 |  0.034 |        1.263
250 |      0.22 |   1.8 |  0.004 |        2.248
```

Fill rate falls 36×. You don't get slower fills — you get almost none, and the
ones you get are the ones nobody wanted.

**Speed buys markout, and it flips sign:**

```
lat | ideal | captured | markout |    net
  1 |  1.00 |    0.995 |  +0.336 | +1.332
100 |  1.00 |    1.265 |  -1.510 | -0.245
```

Spread capture is ~1 tick at every latency. What changes is whether the mid
moves toward or away from you after the fill.

**The fee wall.** Gross edge is 0.39 bps of notional. Break-even maker fee is
between 0.5 and 1 bps. Every retail venue charges 8–40 bps:

| venue | spread | maker fee | net |
|---|---|---|---|
| Coinbase BTC-USD | 0.001 bps | 40 bps | −80 bps |
| Kraken BTC/USD | 0.013 bps | 25 bps | −50 bps |
| OKX BTC/USDT | 0.013 bps | 8 bps | −16 bps |
| Polymarket | ~1 cent | **0 bps** | +1 cent |
| Kalshi | ~1.8 cents | **0 bps** | +1.8 cents |

**The queue wall.** Prediction markets have zero maker fee and a real spread, so
the sign flips. But the spread is exactly one tick, so every maker is forced to
the same price:

| market | depth at touch | notional ahead of you |
|---|---|---|
| Polymarket R Senate, R House | 457,914 | $22,896 |
| Polymarket Dem House | 2,143,931 | $2,015,295 |

Median: **87,632 contracts**. A 5-contract order sits behind all of it. Edge per
round trip is $0.05; capturing it needs queue priority you don't have.

## The bug log

This is the part I would actually hire for. Nine bugs, each of which made the
numbers look **better** than reality:

1. **Frozen latent price.** Final mid pinned at 200.00, so latency couldn't
   hurt and the sweep was noise. A backtest that can't lose is not a backtest.
2. **Requoting every book update.** 383,000 cancels in 200,000 events, filling
   almost never. Real makers use hysteresis because repricing costs queue
   priority.
3. **Mean-reverting latent price.** Pulling the price back toward centre handed
   the maker a free edge — markout came out *positive at every latency*, which
   is physically impossible. This one was only caught because the sign was
   implausible. It invalidated every earlier result.
4. **Stale book levels in the live mirror.** Levels deleted by the venue
   persisted forever, so stale bids drifted above the asks: `spread -1927t`.
5. **Pending orders that never activated.** The sim clock only advanced on
   trades, so in a quiet market orders sat in flight forever (5 orders, 0 fills,
   0 cancels).
6. **`ticker` channel drops quiet products.** It only emits on trades, so a
   40-product survey returned data for 7. Scanner switched to REST.
7. **Liquidity ranked by base-currency volume.** That put PEPE above BTC, since
   Coinbase reports volume in coins. Fixed to `volume × price`.
8. **Unkillable process.** `stop()` closed the socket, `onclose` reconnected, no
   exit path — the scan hung until interrupted. Fixed with a stopped flag, timer
   cleanup, and deterministic exit.
9. **Wrong endpoints, silently.** Kalshi's `/markets?status=open` returns
   provisional combos with zero quotes (5 live in 12,000 scanned); the real
   liquidity is under `/events?with_nested_markets=true`. Polymarket sorted by
   lifetime volume returns dead books at 0.01/1.00, manufacturing a 19,604 bps
   "spread."

Pattern across all nine: the bug made the strategy look better. That is the
failure mode to watch for, and it is why the discipline is to measure the
quantity that would *embarrass* the thesis.

## What this demonstrates

- Fluency in market microstructure: queue position, adverse selection, markout,
  microprice, inventory skew, maker/taker economics.
- Performance engineering with receipts: nanosecond measurement, allocation-free
  hot paths, honest separation of code latency from network latency.
- Empirical discipline: deterministic seeds, 200-market sampling, t-tests,
  sample-size calculation, and the willingness to publish a negative result.
- Debugging across a hostile boundary: live websockets, undocumented API
  behaviour, reconnection semantics, and silent data-quality failures.

## What it does not demonstrate

Stated plainly, because a portfolio that overclaims is worse than none:

- No production trading system. No order entry, no auth, no FIX, no colocation.
- Not C++/Rust/FPGA. Real HFT is; this is readable JS with measured numbers.
- The strategy is not novel. Reservation-price market making is textbook.
- The synthetic market is not a profit forecast. It tests mechanism, not alpha.
- No P&L record. The live paper trade lost money, correctly modelled.

## The honest positioning

The value is not "I have a profitable strategy." It is: **I build measurement
apparatus, find the bugs in it, and report results that kill my own thesis.**

That is the scarce skill. Most people can write the engine. Far fewer can tell
you why the engine's output is wrong.

---

*Repo: `fasttrade` — seven modules, 19 tests, six venue adapters, zero
dependencies. All figures reproduced from code in this repo.*
