import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode, renderOutline, validate } from '@oc/core';
import { exportFreeMind } from '../src/ext/builtin/exportFreeMind.ts';
import { importFreeMind } from '../src/ext/builtin/importFreeMind.ts';
import { htmlToText, parseXml } from '../src/ext/builtin/xml.ts';

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

const byText = (doc: Doc, text: string) => Object.values(doc.nodes).find((n) => n.text === text)!;

test('a map survives export to FreeMind and import back', () => {
  const doc = createDoc('Проект "X" & <Co>');
  const sheet = doc.sheets[0]!;
  const root = sheet.rootIds[0]!;
  const a = add(doc, root, 'Ветка А');
  const a1 = add(doc, a, 'Строка 1\nстрока 2');
  const b = add(doc, root, 'Ветка Б');
  applyOps(doc, [
    { t: 'putAttrDef', def: { id: 'st', name: 'Статус', type: 'text' } },
    { t: 'setAttr', id: a, defId: 'st', value: 'в работе' },
    { t: 'patchNode', id: a, patch: { collapsed: true, notes: 'Первая\nВторая строка' } },
    { t: 'patchNode', id: b, patch: { link: { type: 'url', url: 'https://example.com/?q=1&r=2' } } },
    { t: 'putRelation', relation: { id: 'r1', from: a1, to: b } },
  ] as Op[]);

  const back = importFreeMind(exportFreeMind({ doc, sheet, rootIds: [root], name: 'x' }), 'x.mm');
  assert.deepEqual(validate(back), []);
  // New ids are given on import; everything else in the outline matches.
  const withoutIds = (d: Doc) => renderOutline(d).replace(/ \[[^\]]+\]/g, '');
  assert.equal(withoutIds(back), withoutIds(doc));
  const ba = byText(back, 'Ветка А');
  assert.equal(ba.collapsed, true);
  assert.equal(ba.notes, 'Первая\nВторая строка');
  assert.deepEqual(Object.values(ba.attrs ?? {}), ['в работе']);
  assert.equal(Object.values(back.attrDefs)[0]!.name, 'Статус');
  assert.deepEqual(byText(back, 'Ветка Б').link, { type: 'url', url: 'https://example.com/?q=1&r=2' });
  const [relation] = Object.values(back.relations);
  assert.equal(back.nodes[relation!.from]!.text, 'Строка 1\nстрока 2');
  assert.equal(back.nodes[relation!.to]!.text, 'Ветка Б');
});

test('reads FreeMind and Freeplane features: rich text, details, links to topics, labels', () => {
  const mm = `<?xml version="1.0" encoding="UTF-8"?>
<!-- written by hand -->
<map version="freeplane 1.9.0">
<node TEXT="&#1050;&#1086;&#1088;&#1077;&#1085;&#1100;" ID="ID_1">
  <node ID="ID_2" POSITION="left" FOLDED="true">
    <richcontent TYPE="NODE"><html><head><style>p{}</style></head><body><p>Богатый <b>текст</b></p></body></html></richcontent>
    <richcontent TYPE="DETAILS"><html><body>Подробности<br>вторая строка</body></html></richcontent>
    <node TEXT="Лист" LINK="#ID_4"/>
    <icon BUILTIN="yes"/>
  </node>
  <node TEXT="Файл" LINK="file:///C:/Docs/plan%20v2.txt" ID="ID_3">
    <arrowlink DESTINATION="ID_2" MIDDLE_LABEL="зависит"/>
    <hook NAME="FirstGroupNode"/>
  </node>
  <node TEXT="Цель" ID="ID_4"><![CDATA[ignored text]]></node>
  <node TEXT="Пустая ветка" FOLDED="true"/>
</node>
</map>`;
  const doc = importFreeMind(mm, 'план.mm');
  assert.deepEqual(validate(doc), []);
  const root = doc.nodes[doc.sheets[0]!.rootIds[0]!]!;
  assert.equal(root.text, 'Корень');
  assert.equal(doc.title, 'Корень');
  const rich = byText(doc, 'Богатый текст');
  assert.equal(rich.collapsed, true);
  assert.equal(rich.notes, 'Подробности\nвторая строка');
  assert.deepEqual(byText(doc, 'Лист').link, { type: 'node', nodeId: byText(doc, 'Цель').id });
  assert.deepEqual(byText(doc, 'Файл').link, { type: 'file', path: '/C:/Docs/plan v2.txt' });
  // A folded topic without children is not collapsed.
  assert.equal(byText(doc, 'Пустая ветка').collapsed, undefined);
  const [relation] = Object.values(doc.relations);
  assert.deepEqual([doc.nodes[relation!.from]!.text, doc.nodes[relation!.to]!.text, relation!.text], ['Файл', 'Богатый текст', 'зависит']);
});

test('rejects files that are not FreeMind maps', () => {
  assert.throws(() => importFreeMind('<html><body/></html>'), /не файл FreeMind/);
  assert.throws(() => importFreeMind('просто текст'), /нет XML/);
  assert.throws(() => importFreeMind('<map version="1.0.1"></map>'), /ни одной темы/);
});

test('html to text keeps paragraphs, line breaks and list items', () => {
  const html = parseXml('<html><body><p>Один&nbsp;два</p><ul><li>a</li><li>b</li></ul>текст<br/>после</body></html>');
  assert.equal(htmlToText(html), 'Один два\n- a\n- b\nтекст\nпосле');
});
