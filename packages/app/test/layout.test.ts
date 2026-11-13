import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode } from '@oc/core';
import type { Measure } from '../src/view/layout.ts';
import { displayText, hitTest, layoutRoots, neighbour } from '../src/view/layout.ts';

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

test('display text carries icons for links, notes, prompts and reminders', () => {
  const { doc, kids } = build();
  const [a, b, c] = kids as [Id, Id, Id];
  applyOps(doc, [
    { t: 'patchNode', id: a, patch: { link: { type: 'url', url: 'https://example.com' }, notes: 'n' } },
    { t: 'patchNode', id: b, patch: { prompt: { text: 'p', status: 'queued', scope: 'subtree' } } },
    { t: 'patchNode', id: c, patch: { link: { type: 'node', nodeId: a }, reminders: [{ id: 'r', at: '2026-11-12T09:00:00Z' }] } },
  ]);
  assert.equal(displayText(doc, a), 'A 🔗 📝');
  assert.equal(displayText(doc, b), 'B ⏳');
  assert.equal(displayText(doc, c), 'C ↗ ⏰');
  assert.equal(displayText(doc, kids[3]!), 'D');
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

test('relation curves start and end on the boxes borders and bend away from the straight line', async () => {
  const { relationCurve } = await import('../src/view/layout.ts');
  const box = (x: number, y: number) => ({ id: 'b', parentId: null, x, y, w: 100, h: 40, depth: 1, dir: 1 as const, lines: [], attrs: [], childCount: 0, collapsed: false });
  const a = box(0, 0);
  const b = box(300, 200);
  const c = relationCurve(a, b);
  const onBorder = (bx: typeof a, x: number, y: number) =>
    (Math.abs(x - bx.x) < 1e-9 || Math.abs(x - bx.x - bx.w) < 1e-9) && y >= bx.y - 1e-9 && y <= bx.y + bx.h + 1e-9
    || (Math.abs(y - bx.y) < 1e-9 || Math.abs(y - bx.y - bx.h) < 1e-9) && x >= bx.x - 1e-9 && x <= bx.x + bx.w + 1e-9;
  assert.ok(onBorder(a, c.x1, c.y1), 'starts on the source border');
  assert.ok(onBorder(b, c.x2, c.y2), 'ends on the target border');
  // The midpoint lies off the straight segment.
  const cross = (c.x2 - c.x1) * (c.my - c.y1) - (c.y2 - c.y1) * (c.mx - c.x1);
  assert.ok(Math.abs(cross) / Math.hypot(c.x2 - c.x1, c.y2 - c.y1) > 10);
  const loop = relationCurve(a, a);
  assert.ok(loop.my < a.y);
});

test('attribute lines make room under the topic text without overlaps', async () => {
  const { attributeLines, MAX_ATTR_LINES } = await import('../src/view/layout.ts');
  // Like the real measure: attribute lines add their height and may widen the box.
  const withAttrs: Measure = (text, _depth, attrs) => ({
    w: 20 + Math.max(text.length, ...(attrs ?? []).map((a) => a.length)) * 7,
    h: 24 + (attrs ? 3 + attrs.length * 15 : 0),
    lines: [text],
    ...(attrs ? { attrs } : {}),
  });
  const { doc, kids } = build();
  applyOps(doc, [
    { t: 'putAttrDef', def: { id: 'a1', name: 'Статус', type: 'select', options: ['готово'] } },
    { t: 'putAttrDef', def: { id: 'a2', name: 'Срок', type: 'date' } },
    { t: 'putAttrDef', def: { id: 'a3', name: 'Важно', type: 'bool' } },
    { t: 'setAttr', id: kids[0]!, defId: 'a2', value: '2026-12-01' },
    { t: 'setAttr', id: kids[0]!, defId: 'a1', value: 'готово' },
    { t: 'setAttr', id: kids[0]!, defId: 'a3', value: true },
  ] as Op[]);
  // Order of definitions, not of assignment; booleans read as words.
  assert.deepEqual(attributeLines(doc, kids[0]!), ['Статус: готово', 'Срок: 2026-12-01', 'Важно: да']);

  const root = doc.sheets[0]!.rootIds[0]!;
  const { boxes, byId } = layoutRoots(doc, [root], 'map', withAttrs);
  const box = byId.get(kids[0]!)!;
  assert.equal(box.h, 24 + 3 + 3 * 15);
  assert.deepEqual(box.attrs, ['Статус: готово', 'Срок: 2026-12-01', 'Важно: да']);
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }

  for (let i = 0; i < 4; i++) {
    applyOps(doc, [
      { t: 'putAttrDef', def: { id: `x${i}`, name: `Поле ${i}`, type: 'text' } },
      { t: 'setAttr', id: kids[0]!, defId: `x${i}`, value: `значение ${i}` },
    ] as Op[]);
  }
  const lines = attributeLines(doc, kids[0]!);
  assert.equal(lines.length, MAX_ATTR_LINES);
  assert.equal(lines.at(-1), 'ещё 3…');
});

test('drops land before, after or into a topic, and never into the dragged branch', async () => {
  const { dropAt, dropDestination } = await import('../src/view/layout.ts');
  const { doc, root, kids, grand } = build();
  const layout = layoutRoots(doc, [root], 'map', measure);
  const at = (id: Id, rel: number) => {
    const b = layout.byId.get(id)!;
    return [b.x + b.w / 2, b.y + b.h * rel] as const;
  };
  const [a, b, c] = kids as [Id, Id, Id];
  // Into the middle of another topic: becomes its last child.
  assert.deepEqual(dropAt(doc, layout, a, ...at(c, 0.5)), { targetId: c, place: 'child' });
  // Upper part of C drops between B and C; index counts without A.
  const before = dropAt(doc, layout, a, ...at(c, 0.1))!;
  assert.deepEqual(before, { targetId: c, place: 'before' });
  assert.deepEqual(dropDestination(doc, a, before), { parentId: root, index: 1 });
  const after = dropAt(doc, layout, a, ...at(c, 0.9))!;
  assert.deepEqual(dropDestination(doc, a, after), { parentId: root, index: 2 });
  // No-ops: right after itself, onto its own parent, into its own branch.
  assert.equal(dropAt(doc, layout, a, ...at(b, 0.1)), null);
  assert.equal(dropAt(doc, layout, a, ...at(root, 0.5)), null);
  if (grand[0]) {
    const child = grand[0];
    const parentOfChild = doc.nodes[child]!.parentId!;
    assert.equal(dropAt(doc, layout, parentOfChild, ...at(child, 0.5)), null);
  }
  // The root only takes children.
  assert.deepEqual(dropAt(doc, layout, grand[0] ?? a, ...at(root, 0.05)), { targetId: root, place: 'child' });
});
