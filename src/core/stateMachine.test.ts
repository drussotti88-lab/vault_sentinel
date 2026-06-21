import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './stateMachine.js';
import type { Watch } from '../db/types.js';
import type { CheckResult } from '../adapters/types.js';

function baseWatch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: 'w1',
    retailer_id: 'r1',
    product_id: 'p1',
    source_url: 'https://example.com/p1',
    display_name: 'Item',
    image_url: null,
    threshold: 50,
    tcg_sku: null,
    interval_sec: null,
    last_status: 'out',
    last_price: null,
    last_checked: null,
    last_alerted: null,
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    inStock: true,
    confidence: 'exact',
    price: 49.99,
    currency: 'USD',
    name: 'Item',
    image: null,
    url: 'https://example.com/p1',
    addToCartUrl: null,
    stockQty: 3,
    queue: null,
    ...overrides,
  };
}

const COOLDOWN = 300;

test('fires on out -> in under threshold', () => {
  const d = decide({ watch: baseWatch(), result: result(), cooldownSec: COOLDOWN });
  assert.equal(d.shouldAlert, true);
  assert.equal(d.alertKind, 'restock');
  assert.equal(d.newStatus, 'in');
});

test('does not fire when in stock but above threshold', () => {
  const d = decide({
    watch: baseWatch(),
    result: result({ price: 99.99 }),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.newStatus, 'in');
});

test('does not fire when already in stock (no transition)', () => {
  const d = decide({
    watch: baseWatch({ last_status: 'in', last_price: 49.99 }),
    result: result(),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, false);
});

test('suppresses re-alert within cooldown (flapping)', () => {
  const now = Date.now();
  const d = decide({
    watch: baseWatch({
      last_status: 'out',
      last_alerted: new Date(now - 60_000).toISOString(),
      last_price: 49.99,
    }),
    result: result({ price: 49.99 }),
    cooldownSec: COOLDOWN,
    now,
  });
  assert.equal(d.shouldAlert, false, 'within cooldown and no further drop');
});

test('re-alerts within cooldown when price drops further', () => {
  const now = Date.now();
  const d = decide({
    watch: baseWatch({
      last_status: 'out',
      last_alerted: new Date(now - 60_000).toISOString(),
      last_price: 49.99,
    }),
    result: result({ price: 39.99 }),
    cooldownSec: COOLDOWN,
    now,
  });
  assert.equal(d.shouldAlert, true);
});

test('queue going active emits a one-shot queue alert', () => {
  const d = decide({
    watch: baseWatch({ last_status: 'out' }),
    result: result({ inStock: false, confidence: 'queue_gated', queue: { active: true } }),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, true);
  assert.equal(d.alertKind, 'queue');
  assert.equal(d.newStatus, 'queue');
});

test('queue already active does not re-alert', () => {
  const d = decide({
    watch: baseWatch({ last_status: 'queue' }),
    result: result({ inStock: false, confidence: 'queue_gated', queue: { active: true } }),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, false);
});

test('errors hold previous status and never alert', () => {
  const d = decide({
    watch: baseWatch({ last_status: 'in' }),
    result: result({ error: { code: 'http_500', retryable: true, message: 'boom' } }),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, false);
  assert.equal(d.newStatus, 'in');
});

test('null threshold means any price triggers', () => {
  const d = decide({
    watch: baseWatch({ threshold: null }),
    result: result({ price: 999 }),
    cooldownSec: COOLDOWN,
  });
  assert.equal(d.shouldAlert, true);
});
