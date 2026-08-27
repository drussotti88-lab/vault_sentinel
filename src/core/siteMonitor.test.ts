import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySiteState } from './siteMonitor.js';

test('classifySiteState: network failure -> unreachable', () => {
  assert.equal(classifySiteState(0, ''), 'unreachable');
});

test('classifySiteState: queue-it markers win over everything', () => {
  assert.equal(
    classifySiteState(200, '<html>redirecting to pokemoncenter.queue-it.net waiting room</html>'),
    'queue',
  );
  // Even on a maintenance-ish page, an active queue reference dominates.
  assert.equal(classifySiteState(503, 'site maintenance … queue-it.net'), 'queue');
});

test('classifySiteState: maintenance page detected', () => {
  assert.equal(classifySiteState(503, "<h1>We'll be right back</h1>"), 'maintenance');
  assert.equal(classifySiteState(200, 'The site is down for maintenance'), 'maintenance');
});

test('classifySiteState: cloudflare challenge -> blocked', () => {
  assert.equal(classifySiteState(403, 'Just a moment... challenge-platform'), 'blocked');
  assert.equal(
    classifySiteState(403, 'Enable JavaScript and cookies to continue'),
    'blocked',
  );
});

test('classifySiteState: real content -> normal', () => {
  assert.equal(classifySiteState(200, '<div id="__next"></div><script id="__NEXT_DATA__">'), 'normal');
  assert.equal(classifySiteState(200, '<title>Pokemon Center</title> Add to Cart'), 'normal');
});

test('classifySiteState: bare error statuses without markers -> blocked', () => {
  assert.equal(classifySiteState(403, 'forbidden'), 'blocked');
  assert.equal(classifySiteState(429, 'too many requests'), 'blocked');
});

test('classifySiteState: plain 200 with no markers -> normal', () => {
  assert.equal(classifySiteState(200, '<html><body>hello</body></html>'), 'normal');
});

test('classifySiteState: unexpected status with no markers -> unknown', () => {
  assert.equal(classifySiteState(302, ''), 'unknown');
});
