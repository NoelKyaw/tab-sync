import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPinTab, matches, normalizeUrl, pinState, queryTerms, type Pin } from '../src/lib/match.ts';

test('normalizeUrl drops query, hash and trailing slash', () => {
  assert.equal(normalizeUrl('https://mail.google.com/mail/u/0/#inbox'), 'https://mail.google.com/mail/u/0');
  assert.equal(normalizeUrl('https://linear.app/acme/?x=1'), 'https://linear.app/acme');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('chrome://newtab/'), 'chrome://newtab');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

const pin: Pin = { id: 'p1', url: 'https://mail.google.com/mail/u/0/', title: 'Gmail' };

test('findPinTab prefers the bound tab even after it navigated away', () => {
  const tabs = [
    { id: 1, windowId: 10, url: 'https://mail.google.com/mail/u/0/#inbox' },
    { id: 2, windowId: 20, url: 'https://mail.google.com/mail/u/0/#sent/abc' },
    { id: 3, windowId: 20, url: 'https://other.example/' },
  ];
  assert.equal(findPinTab(pin, tabs, { p1: 3 }, 10)?.id, 3);
});

test('findPinTab falls back to URL match, preferring the current window', () => {
  const tabs = [
    { id: 1, windowId: 10, url: 'https://mail.google.com/mail/u/0/#inbox' },
    { id: 2, windowId: 20, url: 'https://mail.google.com/mail/u/0/' },
  ];
  assert.equal(findPinTab(pin, tabs, {}, 20)?.id, 2);
  assert.equal(findPinTab(pin, tabs, {}, 10)?.id, 1);
  assert.equal(findPinTab(pin, tabs, {}, 99)?.id, 1);
});

test('findPinTab ignores a stale binding and uses pendingUrl for loading tabs', () => {
  const tabs = [{ id: 5, windowId: 10, url: '', pendingUrl: 'https://mail.google.com/mail/u/0' }];
  assert.equal(findPinTab(pin, tabs, { p1: 999 }, 10)?.id, 5);
  assert.equal(findPinTab(pin, [], { p1: 999 }, 10), undefined);
});

test('pinState', () => {
  assert.equal(pinState(undefined, 1), 'closed');
  assert.equal(pinState({ windowId: 1 }, 1), 'here');
  assert.equal(pinState({ windowId: 2 }, 1), 'elsewhere');
});

test('matches requires every term in title or url, case-insensitively', () => {
  const terms = queryTerms('  Fig  sync ');
  assert.deepEqual(terms, ['fig', 'sync']);
  assert.ok(matches(terms, 'Figma · Tab Sync v1', 'https://figma.com/file/x'));
  assert.ok(matches(terms, 'Design', 'https://figma.com/sync'));
  assert.ok(!matches(terms, 'Figma', 'https://figma.com/'));
  assert.ok(matches([], undefined, undefined));
});
