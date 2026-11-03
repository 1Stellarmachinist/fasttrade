# Where can a maker actually keep money?

Measured live against six venues. Every number below was pulled from a public
API during this session — nothing is estimated.

```
node live/compare.mjs   # fee + spread across venues, ranked by absolute edge
node live/queue.mjs     # the queue depth that decides whether you get filled
```

## The head-to-head

| venue | market | spread | maker fee | net per round trip |
|---|---|---|---|---|
| Coinbase | BTC-USD | 0.001 bps | 40 bps | **−80 bps** |
| Kraken | BTC/USD | 0.013 bps | 25 bps | **−50 bps** |
| OKX | BTC/USDT | 0.013 bps | 8 bps | **−16 bps** |
| Polymarket | event contracts | ~1 cent | **0 bps** | **+1 cent** |
| Kalshi | event contracts | ~1.8 cents | **0 bps** | **+1.8 cents** |

The sign flips at the prediction markets, and only there.

## Why: the fee models are completely different shapes

Crypto charges a **percentage of notional**. Prediction markets charge
**nothing to makers**, and their taker fee is a function of price:

```
Kalshi taker fee per contract = ceil(0.07 × P × (1 − P))
```

| price | fee/contract | fee in bps |
|---|---|---|
| 0.01 | $0.01 | 10,000 bps |
| 0.05 | $0.01 | 2,000 bps |
| 0.50 | $0.02 | 400 bps |
| 0.95 | $0.01 | 105 bps |

Two consequences that matter:

1. **Makers pay zero**, so the entire spread is edge. On crypto the spread is
   0.001 bps and the fee is 40 bps — you pay 40,000× the spread.
2. **The fee peaks at 50 cents and vanishes at the tails.** This is why
   prediction-market professionals quote near 0 or 1, not near 0.5.

## But the spread is exactly one tick

This is the part that kills it, and it took measuring to see:

```
Polymarket "R Senate, R House":  bid 0.05 / ask 0.06   tick = 0.01
```

The spread **is** the minimum tick. Every maker in the world is therefore forced
to the same two prices, which produces an enormous queue:

| market | depth at the touch | notional ahead of you |
|---|---|---|
| Polymarket R Senate, R House | 457,914 contracts | $22,896 |
| Polymarket Dem House control | 2,143,931 contracts | $2,015,295 |
| Kalshi "Spain win 2030 WC" | 2,014 contracts | $316 |

Median Polymarket queue at the touch: **87,632 contracts (~$22,896)**.

Your 5-contract order sits behind all of it. To be filled, either a single
aggressor sweeps $22,896 of that side, or the price moves a full tick against
you — at which point you're filled *because you're wrong*.

## What the edge is actually worth

```
edge per round trip = 5 contracts × 1 cent = $0.05
$10/day  = 200 round trips/day
$200/mo  = 133 round trips/day
```

Each of those round trips competes with ~87,000 contracts of resting size from
makers who are already at the front of the queue. They are there because they
placed orders first and they hold the position. Queue priority is not something
you can buy with better code — it is a function of time-in-queue and size.

## Bugs I hit getting these numbers

Recording them because each one produced a *flattering* wrong answer:

1. **Sorted Polymarket by lifetime volume.** That returns dead novelty markets
   with empty books (bid 0.01 / ask 1.00), which manufactured a 19,604 bps
   "spread". Fixed: sort by 24h volume and reject books wider than 25 cents.
2. **Kalshi `/markets?status=open` is the wrong endpoint.** It returns 1,000
   provisional combo markets with zero quotes — 5 live quotes in 12,000 scanned.
   The real liquidity is under `/events?with_nested_markets=true`, which returned
   1,137 live two-sided markets.
3. **Ranked venues by bps instead of absolute edge.** bps says a 2-cent contract
   has a 1,818 bps spread; absolute edge is 1 cent. A 0.001 bps spread on $76,000
   of BTC is $0.76. Rank by bps and you pick the wrong market every time.
4. **Assumed a wide spread meant opportunity.** A 99-cent spread on a 0.505
   contract is not edge, it is an empty book.

## The actual conclusion

Three measurements, one answer:

- **Crypto market making is dead at your fee tier.** Not marginal — negative by
  2× to 4× the spread on every venue, including the cheapest (OKX, 8 bps).
- **The sign flips on prediction markets**, because makers pay zero. That is a
  genuine, verified difference in market structure, not a modelling artefact.
- **But the capturable edge is ~1 cent per contract**, behind a queue of ~87,000
  contracts. The edge is real and unreachable by quoting the touch.

The version of this that *is* reachable is **not a latency play**. It is a
prediction play: quote where the crowd is wrong about a probability, and hold
inventory until it converges. That is a different project — it needs a model of
the event, not a faster order book — and the fasttrade engine is the wrong tool
for it. I'd rather say that plainly than sell you the queue.

What this repo now does is kill that idea in 30 seconds with live data, which is
worth more than another week of building.
