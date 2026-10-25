import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, tabUrl } from '../src/lib/match.ts';

test('normalizeUrl drops query, hash and trailing slash', () => {
  assert.equal(normalizeUrl('https://mail.google.com/mail/u/0/#inbox'), 'https://mail.google.com/mail/u/0');
  assert.equal(normalizeUrl('https://linear.app/acme/?x=1'), 'https://linear.app/acme');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('chrome://newtab/'), 'chrome://newtab');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('tabUrl falls back to pendingUrl while loading', () => {
  assert.equal(tabUrl({ url: '', pendingUrl: 'https://a.example/' }), 'https://a.example/');
  assert.equal(tabUrl({ url: 'https://b.example/' }), 'https://b.example/');
  assert.equal(tabUrl({}), '');
});
