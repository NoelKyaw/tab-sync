import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlight, hostname, timeAgo } from '../src/lib/text.ts';

test('highlight marks every occurrence of every term', () => {
  assert.deepEqual(highlight('Vite config fig', ['fig']), [
    { text: 'Vite con', hit: false },
    { text: 'fig', hit: true },
    { text: ' ', hit: false },
    { text: 'fig', hit: true },
  ]);
  assert.deepEqual(highlight('Figma', ['fi', 'ig']), [
    { text: 'Fig', hit: true },
    { text: 'ma', hit: false },
  ]);
  assert.deepEqual(highlight('abc', []), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlight('', ['a']), []);
});

test('hostname strips www and tolerates junk', () => {
  assert.equal(hostname('https://www.github.com/a/b'), 'github.com');
  assert.equal(hostname('nope'), '');
});

test('timeAgo buckets', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 5_000, now), 'just now');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5m ago');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(timeAgo(now - 2 * 86_400_000, now), '2d ago');
  assert.equal(timeAgo(now - 21 * 86_400_000, now), '3w ago');
});
