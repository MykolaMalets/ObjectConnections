import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode } from '@oc/core';
import type { Measure } from '../src/view/layout.ts';
import { hitTest, layoutRoots, neighbour } from '../src/view/layout.ts';

const measure: Measure = (text) => ({ w: 20 + text.length * 7, h: 24, lines: [text] });

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

function build(): { doc: Doc; root: Id; kids: Id[]; grand: Id[] } {
  const doc = createDoc('Root');
  const root = doc.sheets[0]!.rootIds[0]!;
  const kids = ['A', 'B', 'C', 'D'].map((t) => add(doc, root, t));
  const grand = ['A1', 'A2', 'A3'].map((t) => add(doc, kids[0]!, t));
  return { doc, root, kids, grand };
}

function assertNoOverlap(boxes: { x: number; y: number; w: number; h: number; id: string }[]): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `boxes ${a.id} and ${b.id} overlap`);
    }
  }
}

test('map structure splits branches to both sides without overlaps', () => {
  const { doc, root, kids, grand } = build();
  const layout = layoutRoots(doc, [root], 'map', measure);
  assert.equal(layout.boxes.length, 8);
  assertNoOverlap(layout.boxes);
  const rootBox = layout.byId.get(root)!;
  assert.equal(rootBox.x + rootBox.w / 2, 0);
  assert.deepEqual(kids.map((id) => layout.byId.get(id)!.dir), [1, 1, -1, -1]);
  assert.ok(layout.byId.get(kids[0]!)!.x > rootBox.x + rootBox.w);
  assert.ok(layout.byId.get(kids[2]!)!.x + layout.byId.get(kids[2]!)!.w < rootBox.x);
  // A parent is vertically centred on its children.
  const a = layout.byId.get(kids[0]!)!;
  const first = layout.byId.get(grand[0]!)!;
  const last = layout.byId.get(grand[2]!)!;
  assert.equal(a.y + a.h / 2, (first.y + last.y + last.h) / 2);
});

test('logic-right keeps every branch on the right', () => {
  const { doc, root } = build();
  const layout = layoutRoots(doc, [root], 'logic-right', measure);
  assert.ok(layout.boxes.every((b) => b.dir === 1));
  assertNoOverlap(layout.boxes);
});

test('collapsed branches hide descendants; a collapsed view root still shows children', () => {
  const { doc, root, kids, grand } = build();
  doc.nodes[kids[0]!]!.collapsed = true;
  const layout = layoutRoots(doc, [root], 'map', measure);
  assert.equal(layout.byId.has(grand[0]!), false);
  assert.equal(layout.byId.get(kids[0]!)!.collapsed, true);
  const drilled = layoutRoots(doc, [kids[0]!], 'map', measure, true);
  assert.equal(drilled.boxes.length, 4);
  assert.equal(drilled.byId.get(kids[0]!)!.depth, 0);
});

test('several maps on one sheet do not overlap', () => {
  const { doc, root } = build();
  const sheetId = doc.sheets[0]!.id;
  const second = createNode('Second');
  applyOps(doc, [{ t: 'insertSubtree', nodes: [second], rootId: second.id, parentId: null, sheetId }]);
  add(doc, second.id, 'S1');
  add(doc, second.id, 'S2');
  const layout = layoutRoots(doc, [root, second.id], 'map', measure);
  assertNoOverlap(layout.boxes);
});

test('hit test and keyboard neighbours', () => {
  const { doc, root, kids, grand } = build();
  const layout = layoutRoots(doc, [root], 'map', measure);
  const a = layout.byId.get(kids[0]!)!;
  assert.equal(hitTest(layout, a.x + 1, a.y + 1)!.id, kids[0]);
  assert.equal(hitTest(layout, a.x - 5, a.y - 5), undefined);
  assert.equal(neighbour(doc, layout, root, 'right'), kids[0]);
  assert.equal(neighbour(doc, layout, root, 'left'), kids[2]);
  assert.equal(neighbour(doc, layout, kids[0]!, 'left'), root);
  assert.equal(neighbour(doc, layout, kids[2]!, 'right'), root);
  assert.equal(neighbour(doc, layout, kids[0]!, 'right'), grand[1]);
  assert.equal(neighbour(doc, layout, kids[0]!, 'down'), kids[1]);
  assert.equal(neighbour(doc, layout, grand[0]!, 'down'), grand[1]);
  assert.equal(neighbour(doc, layout, grand[1]!, 'up'), grand[0]);
});

test('layout of 5000 nodes is fast', () => {
  const doc = createDoc('Big');
  const root = doc.sheets[0]!.rootIds[0]!;
  const ids = [root];
  for (let i = 0; i < 5000; i++) ids.push(add(doc, ids[Math.floor(i / 4)]!, `node ${i}`));
  layoutRoots(doc, [root], 'map', measure);
  const start = performance.now();
  const layout = layoutRoots(doc, [root], 'map', measure);
  const elapsed = performance.now() - start;
  assert.equal(layout.boxes.length, 5001);
  assert.ok(elapsed < 50, `layout took ${elapsed.toFixed(1)} ms`);
});
