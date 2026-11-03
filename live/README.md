# fasttrade / live

Live, **read-only** market data tools. No credentials, no order entry, no keys.
The feed module can only subscribe to public channels — there is no code path
that can place an order.

```
node live/scan.mjs      # survey all USD products: is the spread wider than the fee?
node live/paper.mjs     # run the engine against the real book, simulate fills
node live/netstat.mjs   # measure the network cost (the part that dominates)
node live/compare.mjs   # SIX venues head-to-head, ranked by absolute edge
node live/queue.mjs     # how much flow must trade before you get filled
```

**Start with `VENUES.md`** — it has the cross-venue result, which is the only
place in this repo where the economics turn positive.

Env vars:

| task | var | default |
|---|---|---|
| `scan.mjs` | `SCAN_SAMPLES`, `SCAN_GAP_MS` | 3, 1500 |
| `paper.mjs` | `PRODUCT`, `RUNTIME_MS`, `MAKER_FEE`, `EDGE_TICKS`, `QTY` | BTC-USD, 60000, 0.0040, 2, 0.0005 |

## What the live data actually says

`scan.mjs` polls all 404 USD products (340 return valid two-sided quotes).
Median spread over 3 samples, in bps of price:

| product | median spread |
|---|---|
| BTC-USD | **0.001 bps** |
| ETH-USD | 0.31 bps |
| XRP-USD | 0.80 bps |
| SOL-USD | 1.09 bps |
| DOGE-USD | 2.71 bps |
| LTC-USD | 3.17 bps |

The tightest Coinbase maker fee is **40 bps**. To break even a maker needs
`spread > 2 x fee` = **80 bps** — on both legs.

```
lowest tier (0.40%)   need >80bps  ->  42/340 viable
$15k-250k volume      need >50bps  ->  75/340
$1M-15M volume        need >30bps  -> 133/340
$50M+ volume          need >16bps  -> 209/340
```

The 42 that "clear" it are things like MOG-USD (1053 bps) and GST-USD (186 bps).
Those are not opportunities — they are markets where nobody is on the other side.
The wide spread is payment for holding inventory you cannot lay off.

**No liquid major clears its own fee by three orders of magnitude.** BTC's
spread is 0.001 bps; the fee is 40 bps.

## The paper trading result

`paper.mjs` against live BTC-USD for 60s:

```
frames 1004, orders sent 331, fills 6, fill rate 1.81%
notional traded $229.87
gross PnL      -$0.4592
fees (40 bps)  -$0.9195
NET PnL        -$1.3787   (-59.98 bps of notional)
markout/unit   -849 ticks
```

Negative gross PnL before fees. That is not a bug — it is the strategy being
adversely selected on real data. The markout is deeply negative, meaning the mid
moved against every position right after we acquired it: the flow that fills a
resting order at the touch is flow that knows where the price is going.

Every fill cost ~$0.23 in fees and made −$0.08 on the price. With $200 of
capital, six fills in a minute is a −$1.38 minute.

Caveat: our paper fills are **optimistic** (lat 0, no queue position), so the
real number is worse than this, not better.

## The network, measured

```
REST round trip p50      44.0 ms   (p90 80.6 ms, max 745 ms)
one-way estimate         22.0 ms
your decision code        0.0001 ms
```

Your code is ~440,000x smaller than the network hop. A colocated participant is
0.1–0.2 ms from the matching engine; you are ~44 ms away. On every queue race,
you lose.

Also note the websocket cadence: mean gap 41.7 ms between updates, median 52 ms.
You do not even *see* the book at the frequency you think you do.

## Bugs found while building this

Worth recording, because each one made the numbers *look* better than reality:

1. **Stale levels in the mirrored book.** I only wrote levels present in the
   venue book, so deleted levels persisted forever and stale bids drifted above
   the asks — negative spreads (`spread -1927t`). Fixed by clearing every index
   written on each frame.
2. **Pending orders that never activated.** I advanced the simulated clock only
   on trades, so in a quiet market orders sat in flight and never worked
   (5 orders, 0 fills, 0 cancels). Fixed by ticking the clock per book frame.
3. **`ticker` channel drops quiet products.** It only emits on trades, so a
   survey of 40 products returned data for 7. The scanner now uses REST.
4. **Liquidity ranked by base-currency volume.** That put PEPE above BTC, since
   Coinbase reports volume in coins. Fixed to rank by `volume * price`.
5. **Unkillable process.** `stop()` closed the socket, `onclose` reconnected, and
   the script had no exit path — it hung until interrupted. Fixed with a
   `stopped` flag, timer cleanup, and deterministic `process.exit`.

## The honest conclusion

Three independent measurements agree:

- the spread on liquid pairs is **0.001–3 bps**
- the cheapest fee available to you is **40 bps** on Coinbase, 25 on Kraken,
  8 on OKX
- the network adds **44 ms** of latency you cannot remove

Market making on crypto with $200 is not a small-margin business, it is a
certain loss. The tools here let you *verify* that for yourself in 20 seconds,
which is the actual value: they kill bad ideas cheaply.

## Where the sign flips

`compare.mjs` tests six venues. Crypto is negative everywhere. **Prediction
markets (Polymarket, Kalshi) charge makers 0 bps**, so the whole spread is edge.

That is a real structural difference, not a modelling artefact — but `queue.mjs`
then shows the catch: the spread is exactly one tick, so all makers are forced
to the same price, creating a **~87,000-contract queue** at the touch. The edge
is real and unreachable by quoting. See `VENUES.md`.

Where the same code becomes interesting is a venue with maker **rebates**
(negative fees) and colocation — and access to that is gated by capital and
volume, not by code.
