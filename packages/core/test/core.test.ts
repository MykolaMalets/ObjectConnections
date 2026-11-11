import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '../src/index.ts';
import {
  History,
  OpError,
  applyOps,
  createDoc,
  createNode,
  extractFragment,
  newId,
  opsExtractToSheet,
  opsImportFragment,
  opsMergeSheetInto,
  serializeDoc,
  sheetOf,
  subtreeIds,
  validate,
} from '../src/index.ts';

function addChild(history: History, parentId: Id, text: string, index?: number): Id {
  const node = createNode(text);
  node.parentId = parentId;
  const op: Op = { t: 'insertSubtree', nodes: [node], rootId: node.id, parentId };
  if (index !== undefined) op.index = index;
  history.apply([op]);
  return node.id;
}

function sample(): { history: History; doc: Doc; root: Id; a: Id; b: Id; a1: Id } {
  const doc = createDoc('Root');
  const history = new History(doc);
  const root = doc.sheets[0]!.rootIds[0]!;
  const a = addChild(history, root, 'A');
  const b = addChild(history, root, 'B');
  const a1 = addChild(history, a, 'A1');
  return { history, doc, root, a, b, a1 };
}

const snapshot = (doc: Doc) => JSON.parse(JSON.stringify(doc)) as Doc;

test('new document is valid and serializable', () => {
  const doc = createDoc('Hello');
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(JSON.parse(serializeDoc(doc)), doc);
});

test('insert, move, remove and undo restore the document', () => {
  const { history, doc, root, a, b, a1 } = sample();
  const before = snapshot(doc);

  history.apply([{ t: 'moveNode', id: a, parentId: b }]);
  assert.deepEqual(doc.nodes[b]!.children, [a]);
  assert.deepEqual(doc.nodes[root]!.children, [b]);

  history.apply([{ t: 'putRelation', relation: { id: newId(), from: a1, to: root } }]);
  history.apply([{ t: 'removeSubtree', id: b }]);
  assert.deepEqual(Object.keys(doc.nodes), [root]);
  assert.deepEqual(doc.relations, {});
  assert.deepEqual(validate(doc), []);

  history.undo();
  assert.equal(Object.keys(doc.relations).length, 1);
  history.undo();
  history.undo();
  assert.deepEqual(snapshot(doc), before);
  assert.equal(history.redo(), true);
  assert.deepEqual(doc.nodes[b]!.children, [a]);
});

test('reorder within the same parent uses the index after removal', () => {
  const { history, doc, root, a, b } = sample();
  history.apply([{ t: 'moveNode', id: a, parentId: root, index: 1 }]);
  assert.deepEqual(doc.nodes[root]!.children, [b, a]);
  assert.throws(() => history.apply([{ t: 'moveNode', id: a, parentId: root, index: 2 }]), OpError);
});

test('failed operations change nothing, including partially applied batches', () => {
  const { history, doc, root, a, a1 } = sample();
  const before = snapshot(doc);
  const bad: Op[][] = [
    [{ t: 'moveNode', id: a, parentId: a1 }],
    [{ t: 'moveNode', id: a, parentId: a }],
    [{ t: 'removeSubtree', id: 'missing' }],
    [{ t: 'patchNode', id: a, patch: { children: [] } }],
    [{ t: 'patchNode', id: a, patch: { text: null } }],
    [{ t: 'setAttr', id: a, defId: 'nope', value: 1 }],
    [{ t: 'removeSheet', id: doc.sheets[0]!.id }],
    [{ t: 'insertSubtree', nodes: [createNode('x', a)], rootId: a, parentId: root }],
    [{ t: 'insertSubtree', nodes: [createNode('x')], rootId: 'other', parentId: root }],
    [{ t: 'putRelation', relation: { id: newId(), from: a, to: 'missing' } }],
    [
      { t: 'patchNode', id: a, patch: { text: 'changed' } },
      { t: 'removeSubtree', id: a1 },
      { t: 'removeSubtree', id: a1 },
    ],
  ];
  for (const ops of bad) {
    assert.throws(() => history.apply(ops), OpError);
    assert.deepEqual(snapshot(doc), before);
  }
  assert.equal(history.undoStack.length, 3);
});

test('attributes: define, set, remove definition, undo', () => {
  const { history, doc, a, b } = sample();
  const def = { id: newId(), name: 'Priority', type: 'number' as const };
  history.apply([{ t: 'putAttrDef', def }]);
  history.apply([
    { t: 'setAttr', id: a, defId: def.id, value: 1 },
    { t: 'setAttr', id: b, defId: def.id, value: 2 },
  ]);
  const withValues = snapshot(doc);
  history.apply([{ t: 'removeAttrDef', id: def.id }]);
  assert.equal(doc.nodes[a]!.attrs, undefined);
  assert.deepEqual(validate(doc), []);
  history.undo();
  assert.deepEqual(snapshot(doc), withValues);
});

test('patch with null deletes a field and undo restores it', () => {
  const { history, doc, a } = sample();
  history.apply([{ t: 'patchNode', id: a, patch: { notes: 'note', labels: ['x'] } }]);
  history.apply([{ t: 'patchNode', id: a, patch: { notes: null, text: 'A2' } }]);
  assert.equal('notes' in doc.nodes[a]!, false);
  history.undo();
  assert.equal(doc.nodes[a]!.notes, 'note');
  assert.equal(doc.nodes[a]!.text, 'A');
});

test('modified stamp is written and reverted by undo', () => {
  const doc = createDoc('Root');
  const history = new History(doc, { now: () => '2026-11-10T00:00:00Z' });
  const root = doc.sheets[0]!.rootIds[0]!;
  const before = snapshot(doc);
  history.apply([{ t: 'patchNode', id: root, patch: { text: 'New' } }]);
  assert.equal(doc.nodes[root]!.modified, '2026-11-10T00:00:00Z');
  history.undo();
  assert.deepEqual(snapshot(doc), before);
});

test('extract a branch to a sheet with a link, then merge it back', () => {
  const { history, doc, root, a, a1 } = sample();
  const { ops, sheetId } = opsExtractToSheet(doc, a, { leaveLink: true });
  history.apply(ops);
  assert.equal(doc.sheets.length, 2);
  assert.equal(sheetOf(doc, a1)!.id, sheetId);
  const stubId = doc.nodes[root]!.children[0]!;
  assert.deepEqual(doc.nodes[stubId]!.link, { type: 'node', nodeId: a });
  assert.deepEqual(validate(doc), []);

  history.apply(opsMergeSheetInto(doc, sheetId, stubId));
  assert.equal(doc.sheets.length, 1);
  assert.deepEqual(doc.nodes[stubId]!.children, [a]);
  assert.deepEqual(validate(doc), []);
  assert.throws(() => opsMergeSheetInto(doc, doc.sheets[0]!.id, a), OpError);
});

test('moveSheet reorders sheets and undo restores the order', () => {
  const { history, doc } = sample();
  const ids = ['s2', 's3'];
  for (const id of ids) history.apply([{ t: 'insertSheet', sheet: { id, title: id, rootIds: [] } }]);
  const first = doc.sheets[0]!.id;
  const before = snapshot(doc);
  history.apply([{ t: 'moveSheet', id: first, index: 2 }]);
  assert.deepEqual(doc.sheets.map((s) => s.id), ['s2', 's3', first]);
  history.apply([{ t: 'moveSheet', id: 's3', index: 0 }]);
  assert.deepEqual(doc.sheets.map((s) => s.id), ['s3', 's2', first]);
  history.undo();
  history.undo();
  assert.deepEqual(snapshot(doc), before);
  assert.throws(() => history.apply([{ t: 'moveSheet', id: first, index: 3 }]), OpError);
  assert.throws(() => history.apply([{ t: 'moveSheet', id: 'missing', index: 0 }]), OpError);
  assert.deepEqual(snapshot(doc), before);
});

test('fragment moves a branch into another document with fresh ids', () => {
  const { history, doc, a, a1 } = sample();
  const def = { id: newId(), name: 'Owner', type: 'text' as const };
  history.apply([
    { t: 'putAttrDef', def },
    { t: 'setAttr', id: a1, defId: def.id, value: 'me' },
    { t: 'putRelation', relation: { id: newId(), from: a, to: a1 } },
  ]);
  const fragment = extractFragment(doc, a);
  assert.equal(fragment.nodes.length, 2);
  assert.equal(fragment.relations.length, 1);

  const other = createDoc('Other');
  const target = other.sheets[0]!.rootIds[0]!;
  const imported = opsImportFragment(other, fragment, { parentId: target });
  applyOps(other, imported.ops);
  assert.deepEqual(validate(other), []);
  assert.notEqual(imported.rootId, a);
  assert.deepEqual(
    subtreeIds(other, imported.rootId).map((id) => other.nodes[id]!.text),
    ['A', 'A1'],
  );
  assert.equal(Object.keys(other.relations).length, 1);
  assert.equal(other.attrDefs[def.id]!.name, 'Owner');

  // Importing into the source document makes an independent copy.
  const copy = opsImportFragment(doc, fragment, { parentId: null, sheetId: doc.sheets[0]!.id });
  history.apply(copy.ops);
  assert.equal(doc.sheets[0]!.rootIds.length, 2);
  assert.deepEqual(validate(doc), []);
});

test('random operations keep the document valid; undo and redo are exact', () => {
  let seed = 20261110;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)]!;

  const doc = createDoc('Fuzz');
  let tick = 0;
  const history = new History(doc, { now: () => `t${tick++}`, limit: 100000 });
  const initial = snapshot(doc);
  const defId = newId();
  history.apply([{ t: 'putAttrDef', def: { id: defId, name: 'N', type: 'number' } }]);

  let applied = 0;
  let rejected = 0;
  for (let i = 0; i < 3000; i++) {
    const nodeIds = Object.keys(doc.nodes);
    const anyNode = () => pick(nodeIds);
    let ops: Op[];
    const roll = rnd();
    try {
      if (nodeIds.length === 0 || roll < 0.35) {
        const node = createNode(`n${i}`);
        const asRoot = nodeIds.length === 0 || rnd() < 0.05;
        node.parentId = asRoot ? null : anyNode();
        ops = [
          asRoot
            ? { t: 'insertSubtree', nodes: [node], rootId: node.id, parentId: null, sheetId: pick(doc.sheets).id }
            : { t: 'insertSubtree', nodes: [node], rootId: node.id, parentId: node.parentId },
        ];
      } else if (roll < 0.5) {
        const parentId = rnd() < 0.1 ? null : anyNode();
        ops = [{ t: 'moveNode', id: anyNode(), parentId, sheetId: pick(doc.sheets).id, index: Math.floor(rnd() * 3) }];
      } else if (roll < 0.6) {
        ops = [{ t: 'removeSubtree', id: anyNode() }];
      } else if (roll < 0.7) {
        ops = [{ t: 'patchNode', id: anyNode(), patch: { text: `t${i}`, notes: rnd() < 0.5 ? null : 'note' } }];
      } else if (roll < 0.78) {
        ops = [{ t: 'setAttr', id: anyNode(), defId, value: rnd() < 0.3 ? null : i }];
      } else if (roll < 0.86) {
        ops = [{ t: 'putRelation', relation: { id: newId(), from: anyNode(), to: anyNode() } }];
      } else if (roll < 0.9) {
        const relIds = Object.keys(doc.relations);
        ops = [{ t: 'removeRelation', id: relIds.length ? pick(relIds) : 'none' }];
      } else if (roll < 0.95) {
        ops = opsExtractToSheet(doc, anyNode(), { leaveLink: rnd() < 0.5 }).ops;
      } else {
        ops = opsMergeSheetInto(doc, pick(doc.sheets).id, anyNode());
      }
      const before = serializeDoc(doc);
      try {
        history.apply(ops);
        applied++;
      } catch (error) {
        assert.equal(serializeDoc(doc), before, 'a rejected batch must not change the document');
        throw error;
      }
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      rejected++;
    }
    assert.deepEqual(validate(doc), [], `invalid after step ${i}`);
  }
  assert.ok(applied > 2000, `applied ${applied}, rejected ${rejected}`);
  assert.ok(rejected > 50, `rejected ${rejected}`);

  const final = snapshot(doc);
  while (history.undo());
  assert.deepEqual(snapshot(doc), initial);
  while (history.redo());
  assert.deepEqual(snapshot(doc), final);
});
