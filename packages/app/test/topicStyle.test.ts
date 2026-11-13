import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Op } from '@oc/core';
import { applyOps, createDoc } from '@oc/core';
import type { Measure } from '../src/view/layout.ts';
import { displayText, labelLine, layoutRoots, topicColor } from '../src/view/layout.ts';
import { markerGlyphs, toggleMarker } from '../src/view/markers.ts';
import { isLight, topicLook } from '../src/view/style.ts';

test('exclusive marker groups keep one marker; others accumulate', () => {
  let m = toggleMarker(undefined, 'priority-1');
  m = toggleMarker(m, 'flag');
  m = toggleMarker(m, 'priority-3');
  assert.deepEqual(m, ['flag', 'priority-3']);
  m = toggleMarker(m, 'star');
  assert.deepEqual(m, ['flag', 'priority-3', 'star']);
  assert.deepEqual(toggleMarker(m, 'flag'), ['priority-3', 'star']);
  // Unknown ids are kept as they are: another tool may have written them.
  assert.deepEqual(toggleMarker(['custom'], 'priority-2'), ['custom', 'priority-2']);
});

test('markers come before the text, labels go under it, colour must be #rrggbb', () => {
  const doc = createDoc('Задача');
  const id = doc.sheets[0]!.rootIds[0]!;
  applyOps(doc, [
    { t: 'patchNode', id, patch: { markers: ['flag', 'custom', 'priority-2'], labels: ['дом', 'срочно'], style: { color: '#2f9e44' } } },
  ] as Op[]);
  const node = doc.nodes[id]!;
  // Table order: priority before symbols; unknown ids are not drawn.
  assert.deepEqual(markerGlyphs(node), ['2️⃣', '🚩']);
  assert.equal(displayText(doc, id), '2️⃣🚩 Задача');
  assert.deepEqual(labelLine(doc, id), ['#дом #срочно']);
  assert.equal(topicColor(doc, id), '#2f9e44');

  const measure: Measure = (text, _d, attrs) => ({ w: 100, h: 24 + (attrs?.length ?? 0) * 15, lines: [text], ...(attrs ? { attrs } : {}) });
  const box = layoutRoots(doc, [id], 'map', measure).byId.get(id)!;
  assert.equal(box.color, '#2f9e44');
  assert.deepEqual(box.attrs, ['#дом #срочно']);

  applyOps(doc, [{ t: 'patchNode', id, patch: { style: { color: 'red; drop table' } } }] as Op[]);
  assert.equal(topicColor(doc, id), undefined);
});

test('text on a user colour stays readable', () => {
  assert.equal(isLight('#ffe8a3'), true);
  assert.equal(isLight('#2f6fed'), false);
  assert.equal(topicLook({ depth: 2, color: '#ffe8a3' }).color, '#1f2733');
  assert.equal(topicLook({ depth: 2, color: '#e03131' }).color, '#ffffff');
  assert.equal(topicLook({ depth: 2 }).fill, null);
});
