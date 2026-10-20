import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVisitPopup, notifyVisited } from '../dist/visit/index.js';

function fakeWindow(withOpener) {
  const opener = { sent: [], postMessage(msg, origin) { this.sent.push({ msg, origin }); } };
  return {
    opener: withOpener ? opener : null,
    location: { origin: 'https://widget.example' },
    closed: false,
    close() { this.closed = true; },
    sent: opener.sent,
  };
}

test('notifies the opener on our own origin and closes', () => {
  const win = fakeWindow(true);
  assert.equal(isVisitPopup(win), true);
  assert.equal(notifyVisited({}, win), true);
  assert.deepEqual(win.sent, [{ msg: { ns: 'framepass', kind: 'visited' }, origin: 'https://widget.example' }]);
  assert.equal(win.closed, true);
});

test('close: false keeps the popup open', () => {
  const win = fakeWindow(true);
  notifyVisited({ close: false }, win);
  assert.equal(win.closed, false);
});

test('does nothing without an opener', () => {
  const win = fakeWindow(false);
  assert.equal(isVisitPopup(win), false);
  assert.equal(notifyVisited({}, win), false);
  assert.equal(win.closed, false);
});
