import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_PICK, pickRow, pickedRows, type RowPick } from './rowSelect.js';

const of = (rows: number[], anchor: number | null = null): RowPick => ({ rows: new Set(rows), anchor });
const list = (p: RowPick) => [...p.rows].sort((a, b) => a - b);

test('a plain click replaces the pick', () => {
  assert.deepEqual(list(pickRow(of([1, 2, 3]), 7, {})), [7]);
  assert.equal(pickRow(NO_PICK, 7, {}).anchor, 7);
});

test('ctrl adds a row without disturbing the others', () => {
  const p = pickRow(of([5], 5), 9, { ctrl: true });
  assert.deepEqual(list(p), [5, 9]);
  assert.deepEqual(list(pickRow(p, 2, { ctrl: true })), [2, 5, 9]);
});

test('ctrl on an already-picked row removes just that one', () => {
  assert.deepEqual(list(pickRow(of([2, 5, 9], 9), 5, { ctrl: true })), [2, 9]);
  // and picking the last one out leaves nothing, which falls back to the cell rectangle
  assert.deepEqual(list(pickRow(of([5], 5), 5, { ctrl: true })), []);
});

test('shift extends from the anchor, in either direction', () => {
  assert.deepEqual(list(pickRow(of([4], 4), 7, { shift: true })), [4, 5, 6, 7]);
  assert.deepEqual(list(pickRow(of([4], 4), 1, { shift: true })), [1, 2, 3, 4]);
});

test('the anchor survives shift so the far end can be dragged around', () => {
  const first = pickRow(of([4], 4), 8, { shift: true });
  assert.equal(first.anchor, 4);
  assert.deepEqual(list(pickRow(first, 6, { shift: true })), [4, 5, 6]);
});

test('shift with no anchor cannot extend, so it selects the one row', () => {
  assert.deepEqual(list(pickRow(NO_PICK, 3, { shift: true })), [3]);
});

test('ctrl retargets the anchor so a later shift extends from there', () => {
  const p = pickRow(of([1], 1), 5, { ctrl: true });
  assert.equal(p.anchor, 5);
  assert.deepEqual(list(pickRow(p, 7, { shift: true })), [5, 6, 7]);
});

test('an empty pick falls back to the cell rectangle rows', () => {
  assert.deepEqual(pickedRows(NO_PICK, { r0: 2, r1: 5 }), [2, 3, 4, 5]);
  assert.deepEqual(pickedRows(NO_PICK, null), []);
  // a pick always wins over the rectangle, and comes back sorted
  assert.deepEqual(pickedRows(of([9, 2, 5]), { r0: 0, r1: 100 }), [2, 5, 9]);
});
