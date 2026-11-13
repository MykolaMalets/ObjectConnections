import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode, validate } from '@oc/core';
import {
  Session,
  Workspace,
  copySelection,
  moveBranches,
  pasteClipboard,
  removeSelected,
  select,
  selectAllVisible,
  selectedBranches,
  selectedIds,
  toggleSelected,
  undo,
} from '../src/state/store.ts';

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

function setup() {
  const doc = createDoc('Root');
  const root = doc.sheets[0]!.rootIds[0]!;
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((t) => add(doc, root, t)) as [Id, Id, Id, Id];
  const a1 = add(doc, a, 'A1');
  const ws = new Workspace();
  const s = new Session(doc, 'test');
  ws.add(s);
  const texts = (ids: Id[]) => ids.map((id) => s.doc.nodes[id]!.text);
  const children = (id: Id) => texts(s.doc.nodes[id]!.children);
  return { ws, s, root, a, b, c, d, a1, texts, children };
}

test('toggling builds a group; a plain selection ends it', () => {
  const { ws, s, a, b, c, texts } = setup();
  select(ws, a);
  toggleSelected(ws, b);
  toggleSelected(ws, c);
  // The topic touched last is the primary one; the rest follow, newest first.
  assert.deepEqual(texts(selectedIds(s)), ['C', 'B', 'A']);
  toggleSelected(ws, c);
  assert.deepEqual(texts(selectedIds(s)), ['B', 'A']);
  select(ws, b);
  assert.deepEqual(texts(selectedIds(s)), ['B']);
});

test('a branch inside another selected branch is not acted on twice', () => {
  const { ws, s, a, a1, b, texts } = setup();
  select(ws, a1);
  toggleSelected(ws, a);
  toggleSelected(ws, b);
  // Map order, not the order of picking.
  assert.deepEqual(texts(selectedBranches(s)), ['A', 'B']);
});

test('delete removes the whole group as one undo step', () => {
  const { ws, s, root, a, c, children } = setup();
  select(ws, a);
  toggleSelected(ws, c);
  removeSelected(ws);
  assert.deepEqual(children(root), ['B', 'D']);
  assert.deepEqual(validate(s.doc), []);
  undo(ws);
  assert.deepEqual(children(root), ['A', 'B', 'C', 'D']);
});

test('the root and the last map are kept when they are in a group', () => {
  const { ws, root, b, children } = setup();
  select(ws, root);
  toggleSelected(ws, b);
  removeSelected(ws);
  assert.deepEqual(children(root), ['A', 'C', 'D']);
});

test('a dragged group lands together, in order', () => {
  const { ws, s, root, a, b, d, children } = setup();
  select(ws, b);
  toggleSelected(ws, d);
  // Into A (as children), then back between A and C.
  moveBranches(ws, d, a);
  assert.deepEqual(children(a), ['A1', 'B', 'D']);
  assert.equal(s.multi.size, 1, 'the group stays selected after the move');
  moveBranches(ws, d, root, 1);
  assert.deepEqual(children(root), ['A', 'B', 'D', 'C']);
  // Never into its own branch.
  moveBranches(ws, d, d);
  assert.deepEqual(children(root), ['A', 'B', 'D', 'C']);
  assert.deepEqual(validate(s.doc), []);
});

test('copy and paste carry every selected branch', () => {
  const { ws, s, a, c, d, children } = setup();
  select(ws, a);
  toggleSelected(ws, c);
  const data = copySelection(ws)!;
  assert.equal(data.fragments.length, 2);
  assert.equal(data.text, 'A\n  A1\nC\n');
  select(ws, d);
  pasteClipboard(ws, { fragmentJson: JSON.stringify(data.fragments), text: data.text });
  assert.deepEqual(children(d), ['A', 'C']);
  assert.deepEqual(validate(s.doc), []);
});

test('select all takes the visible topics', () => {
  const { ws, s, a } = setup();
  applyOps(s.doc, [{ t: 'patchNode', id: a, patch: { collapsed: true } }]);
  selectAllVisible(ws);
  assert.equal(selectedIds(s).length, 5); // root, A, B, C, D — not A1 inside the collapsed A
});
