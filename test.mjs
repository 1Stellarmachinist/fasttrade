// Sanity tests for the parts that are easy to get subtly wrong:
// queue position, in-flight orders, book best-price maintenance, risk limits.
// These are the bugs that make a backtest look profitable for the wrong reason.

import assert from 'node:assert/strict';
import { Book } from './book.mjs';
import { SimExchange } from './exchange.mjs';
import { RiskGate } from './risk.mjs';
import { MarketMaker } from './strategy.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('book:');

test('best bid/ask track insert and removal', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 5); b.setBid(102, 5); b.setAsk(104, 5); b.setAsk(103, 5);
  assert.equal(b.bb, 102);
  assert.equal(b.ba, 103);
  b.setBid(102, 0);          // removing best must walk down
  assert.equal(b.bb, 100);
  b.setAsk(103, 0);
  assert.equal(b.ba, 104);
});

test('empty side is detectable', () => {
  const b = new Book(0.01, 0, 100);
  assert.equal(b.bb, -1);
  assert.equal(b.ba, 100);
  assert.equal(b.mid(), 0);
});

test('microprice leans toward the thinner side', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 100);  // heavy bid
  b.setAsk(102, 1);    // thin ask -> price should lean up
  const mp = b.microprice();
  assert.ok(mp > 101, `expected >101, got ${mp}`);
  assert.ok(mp < 102, `expected <102, got ${mp}`);
});

test('imbalance sign matches heavier side', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 90); b.setAsk(101, 10);
  assert.ok(b.imbalance() > 0);
});

console.log('exchange / queue:');

const mkBook = () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 50); b.setAsk(101, 50);
  return b;
};

test('order is not working until latency elapses', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 3 });
  ex.place(1, 100, 10);
  assert.equal(ex.bidOrder.active, false);
  for (let i = 1; i <= 3; i++) { ex.seq = i; ex.activate(); if (i < 3) assert.equal(ex.bidOrder.active, false); }
  assert.equal(ex.bidOrder.active, true);
});

test('queue position is taken from the book at arrival, not at send', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 2 });
  ex.place(1, 100, 10);
  b.setBid(100, 80);          // 30 more lots join ahead of us in flight
  ex.seq = 2; ex.activate();
  assert.equal(ex.bidOrder.queue, 80, 'must join the BACK of the longer queue');
});

test('partial trade does not fill us while queue ahead remains', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 0 });
  ex.place(1, 100, 10);
  ex.seq = 0; ex.activate();
  assert.equal(ex.bidOrder.queue, 50);
  ex.onTrade(100, 20, -1);
  assert.equal(ex.fills, 0, 'no fill: 30 lots still ahead');
  assert.equal(ex.bidOrder.queue, 30);
});

test('trade that clears the queue fills us for the remainder only', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 0 });
  ex.place(1, 100, 10);
  ex.seq = 0; ex.activate();
  ex.onTrade(100, 55, -1);         // 50 ahead + 5 into us
  assert.equal(ex.pos, 5);
  assert.equal(ex.bidOrder.filled, 5);
  assert.equal(ex.bidOrder.alive, true);
});

test('cancels ahead of us improve queue position without trading', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 0 });
  ex.place(1, 100, 10);
  ex.seq = 0; ex.activate();
  ex.advance(1, 100, 30);
  assert.equal(ex.bidOrder.queue, 20);
  assert.equal(ex.fills, 0);
});

test('a print at another price cannot fill us', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 0 });
  ex.place(1, 100, 10);
  ex.seq = 0; ex.activate();
  ex.onTrade(99, 500, -1);         // away from our level
  assert.equal(ex.fills, 0);
  assert.equal(ex.bidOrder.alive, true);
});

test('full fill retires the order and updates cash', () => {
  const b = mkBook();
  const ex = new SimExchange(b, { lat: 0 });
  ex.place(1, 100, 10);
  ex.seq = 0; ex.activate();
  ex.onTrade(100, 500, -1);
  assert.equal(ex.pos, 10);
  assert.equal(ex.bidOrder, null);
  assert.ok(Math.abs(ex.cash - (-10 * b.px(100))) < 1e-9);
});

console.log('risk:');

test('rejects oversize order', () => {
  const r = new RiskGate({ maxOrder: 10 });
  assert.equal(r.check(1, 11, 100, 0, 0), false);
  assert.equal(r.reason, 'size');
});

test('rejects order that breaches position limit', () => {
  const r = new RiskGate({ maxPos: 50, maxOrder: 100 });
  assert.equal(r.check(1, 20, 100, 40, 0), false);
  assert.equal(r.reason, 'position');
});

test('rejects notional above cap', () => {
  const r = new RiskGate({ maxNotional: 1000, maxOrder: 100 });
  assert.equal(r.check(1, 10, 500, 0, 0), false);
  assert.equal(r.reason, 'notional');
});

test('rate limit engages then recovers after window', () => {
  const r = new RiskGate({ rate: 3, winNs: 1000, maxOrder: 100 });
  for (let i = 0; i < 3; i++) assert.equal(r.check(1, 1, 1, 0, 0), true);
  assert.equal(r.check(1, 1, 1, 0, 0), false);
  assert.equal(r.check(1, 1, 1, 0, 2000), true);
});

test('kill switch blocks everything', () => {
  const r = new RiskGate();
  r.trip('manual');
  assert.equal(r.check(1, 1, 1, 0, 0), false);
  assert.equal(r.reason, 'halted');
});

console.log('strategy:');

test('never quotes a crossing book', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 10); b.setAsk(101, 10);
  const mm = new MarketMaker({ edge: 8 });
  const t = mm.target(b, 0);
  assert.ok(t === null || t.askPx > t.bidPx);
});

test('long inventory stops bidding and skews the ask down', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 10); b.setAsk(101, 10);
  const mm = new MarketMaker({ maxInv: 10, invSkew: 0.5 });
  const flat = mm.target(b, 0);
  const long = mm.target(b, 10);
  assert.equal(long.bidPx, -1, 'at max inventory, do not bid');
  assert.ok(long.askPx <= flat.askPx, 'long inventory should sell more eagerly');
});

test('short inventory stops offering', () => {
  const b = new Book(0.01, 0, 1000);
  b.setBid(100, 10); b.setAsk(101, 10);
  const mm = new MarketMaker({ maxInv: 10 });
  const short = mm.target(b, -10);
  assert.equal(short.askPx, -1);
});

console.log(`\n${passed} passed`);
