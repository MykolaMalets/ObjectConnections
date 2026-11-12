import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode } from '@oc/core';
import { docLabels, searchDoc } from '../src/state/search.ts';

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

function build() {
  const doc = createDoc('Семья');
  const root = doc.sheets[0]!.rootIds[0]!;
  const mum = add(doc, root, 'Мама');
  const granny = add(doc, mum, 'Бабушка Алёна');
  const dad = add(doc, root, 'Папа');
  applyOps(doc, [
    { t: 'putAttrDef', def: { id: 'born', name: 'Год рождения', type: 'number' } },
    { t: 'patchNode', id: mum, patch: { collapsed: true, labels: ['родня'] } },
    { t: 'setAttr', id: mum, defId: 'born', value: 1960 },
    { t: 'patchNode', id: dad, patch: { notes: 'Любит рыбалку', labels: ['родня', 'важно'] } },
    { t: 'patchNode', id: granny, patch: { link: { type: 'url', url: 'https://example.com/alena' } } },
  ]);
  const second = { t: 'insertSheet', sheet: { id: 's2', title: 'Лист 2', rootIds: [] }, index: 1 } as Op;
  applyOps(doc, [second]);
  const other = createNode('Алёна на втором листе');
  applyOps(doc, [{ t: 'insertSubtree', nodes: [other], rootId: other.id, parentId: null, sheetId: 's2' } as Op]);
  return { doc, root, mum, granny, dad, other: other.id };
}

test('finds text in reading order across sheets, ignoring case and ё', () => {
  const { doc, granny, other } = build();
  const found = searchDoc(doc, { query: 'АЛЕНА' });
  assert.deepEqual(
    found.map((m) => m.id),
    [granny, other],
  );
  assert.equal(found[1]!.sheetId, 's2');
});

test('finds notes, labels, attribute values and links, and names the field', () => {
  const { doc, mum, dad, granny } = build();
  assert.deepEqual(searchDoc(doc, { query: 'рыбалк' }), [{ id: dad, sheetId: doc.sheets[0]!.id, field: 'notes' }]);
  assert.deepEqual(
    searchDoc(doc, { query: 'важно' }).map((m) => [m.id, m.field]),
    [[dad, 'label']],
  );
  assert.deepEqual(
    searchDoc(doc, { query: '1960' }).map((m) => [m.id, m.field]),
    [[mum, 'attr']],
  );
  assert.deepEqual(
    searchDoc(doc, { query: 'example.com' }).map((m) => [m.id, m.field]),
    [[granny, 'link']],
  );
});

test('every word must be present; empty query without filters finds nothing', () => {
  const { doc, granny } = build();
  assert.deepEqual(
    searchDoc(doc, { query: 'бабушка алёна' }).map((m) => m.id),
    [granny],
  );
  assert.deepEqual(searchDoc(doc, { query: 'бабушка папа' }), []);
  assert.deepEqual(searchDoc(doc, { query: '   ' }), []);
});

test('label and attribute filters narrow the result', () => {
  const { doc, mum, dad } = build();
  assert.deepEqual(
    searchDoc(doc, { query: '', label: 'родня' }).map((m) => m.id),
    [mum, dad],
  );
  assert.deepEqual(
    searchDoc(doc, { query: 'папа', label: 'родня' }).map((m) => m.id),
    [dad],
  );
  assert.deepEqual(
    searchDoc(doc, { query: '', attrId: 'born' }).map((m) => m.id),
    [mum],
  );
  assert.deepEqual(searchDoc(doc, { query: 'мама', attrId: 'born' }), []);
  assert.deepEqual(docLabels(doc), ['важно', 'родня']);
});
