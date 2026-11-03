// What does $200 actually do in a market-making strategy?
//
// Three numbers decide it:
//   capital x turnover x edge          = gross income
//   capital x turnover x fee           = cost (and this is bigger)
//   capital x adverse price move       = risk to the inventory you must hold
//
// The third one is the one people forget, and it is the one that ends accounts.

const CAPITAL = 200;

// --- fee schedules, in bps of notional (1 bp = 0.01%) ---
const venues = [
  { name: 'Coinbase Advanced, lowest tier', maker: 40,  note: '0.40% maker' },
  { name: 'Coinbase Advanced, $15k-250k tier', maker: 25, note: '0.25% maker' },
  { name: 'Kraken Pro, base tier',            maker: 25,  note: '0.25% maker' },
  { name: 'Binance spot, base + BNB',        maker: 7.5, note: '0.075% maker' },
  { name: 'Binance VIP9 / rebate tier',      maker: 0,   note: 'needs huge volume' },
];

// gross edge measured by the engine, in bps of notional traded
const GROSS_EDGE_BPS = 0.39;

// realistic number of times you turn your capital over per day as a maker.
// 10x/day is aggressive for a human-free bot on a $200 book.
const TURNOVERS = [1, 5, 10, 50];

const fmt = (n) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(4);
const bpsToFrac = (bps) => bps / 10_000;

console.log(`=== $${CAPITAL} as market-making capital ===`);
console.log(`engine's measured gross edge: ${GROSS_EDGE_BPS} bps of notional traded\n`);

// ---------- 1. the cost problem ----------
console.log('1. GROSS INCOME vs FEES (per day)');
console.log('   turnover |   gross  |  Coinbase 40bps |  Binance 7.5bps |  zero-fee');
console.log('   ---------|----------|-----------------|-----------------|----------');
for (const t of TURNOVERS) {
  const traded = CAPITAL * t;
  const gross = traded * bpsToFrac(GROSS_EDGE_BPS);
  const cb = gross - traded * bpsToFrac(40);
  const bn = gross - traded * bpsToFrac(7.5);
  const zf = gross;
  console.log(
    `   ${String(t).padStart(7)}x | ${fmt(gross).padStart(8)} | ` +
    `${fmt(cb).padStart(15)} | ${fmt(bn).padStart(15)} | ${fmt(zf).padStart(8)}`
  );
}

// ---------- 2. how long to double, at zero fees ----------
console.log('\n2. BEST CASE: assume ZERO fees, which you do not get');
const t = 10;
const dailyZeroFee = CAPITAL * t * bpsToFrac(GROSS_EDGE_BPS);
const daysToDouble = Math.log(2) / Math.log(1 + dailyZeroFee / CAPITAL);
console.log(`   at ${t}x turnover/day, gross = ${fmt(dailyZeroFee)}/day`);
console.log(`   annual gross              = ${fmt(dailyZeroFee * 365)}`);
console.log(`   time to double $${CAPITAL}      = ~${Math.round(daysToDouble).toLocaleString()} days (${(daysToDouble / 365).toFixed(1)} years)`);
console.log(`   ...and that assumes you never have a losing day, or a fee.`);

// ---------- 3. the risk problem ----------
console.log('\n3. THE PART THAT ACTUALLY ENDS ACCOUNTS: inventory risk');
console.log('   a maker must hold inventory. that inventory moves against you.');
console.log('   move on held inventory | loss | = days of gross edge (at 10x, zero fee)');
console.log('   -----------------------|------|------------------------------------');
for (const move of [1, 2, 5, 10]) {
  const loss = CAPITAL * (move / 100);
  const days = loss / dailyZeroFee;
  console.log(
    `   ${String(move + '%').padStart(22)} | ${('$' + loss.toFixed(2)).padStart(4)} | ` +
    `${Math.round(days).toLocaleString()} days of gross income`
  );
}
console.log('\n   crypto routinely moves 5% in a day. at 10x turnover with zero fees');
console.log('   that is ~128 days of gross income erased in one session, before');
console.log('   paying a single fee. and you cannot diversify, hedge, or size down');
console.log('   to safety when the whole account is $200.');

// ---------- 4. what $200 realistically becomes ----------
console.log('\n4. REALISTIC OUTCOME DISTRIBUTION (net of fees, Coinbase 40bps)');
console.log('   every trade costs 100x what it earns. so:');
console.log('   - the bot trades at all        -> you bleed fees every day');
console.log('   - the bot sits still           -> $0, but you kept your $200');
console.log('   - one 5% adverse move          -> -$10 in a day, regardless');
console.log('   expected value of running it   -> negative');
console.log('   expected value of NOT running  -> $0 (you still have $200)');

console.log('\n=== the honest summary ===');
console.log(`  max plausible gross: ${fmt(dailyZeroFee)}/day at zero fees, perfect execution`);
console.log(`  actual fees:         40 bps = ${fmt(CAPITAL * t * bpsToFrac(40))}/day at ${t}x turnover`);
console.log('  fee / gross ratio:   103x  (Coinbase), 19x (Binance base)');
console.log('\n  there is no parameter choice that fixes this. the capital is too');
console.log('  small to compound and the fee is too large to clear. $200 is not');
console.log('  a small version of a working business; the fixed costs (fees,');
console.log('  spread, at least $1k of inventory risk tolerance) are larger than');
console.log('  the entire account.');
