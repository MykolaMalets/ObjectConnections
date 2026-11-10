import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode, newId } from '@oc/core';
import { exportFreeMind } from '../src/ext/builtin/exportFreeMind.ts';
import { exportMarkdown } from '../src/ext/builtin/exportMarkdown.ts';

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

function build() {
  const doc = createDoc('Project "X" & Co');
  const sheet = doc.sheets[0]!;
  const root = sheet.rootIds[0]!;
  const a = add(doc, root, 'Plan');
  const b = add(doc, root, 'Risks <high>');
  const a1 = add(doc, a, 'Step 1');
  const a11 = add(doc, a1, 'Detail');
  const def = { id: newId(), name: 'Owner', type: 'text' as const };
  applyOps(doc, [
    { t: 'putAttrDef', def },
    { t: 'setAttr', id: a1, defId: def.id, value: 'Ann' },
    { t: 'patchNode', id: a, patch: { notes: 'First line\nSecond line', collapsed: true } },
    { t: 'patchNode', id: b, patch: { link: { type: 'url', url: 'https://example.com/?a=1&b=2' } } },
    { t: 'putRelation', relation: { id: newId(), from: a1, to: b } },
  ]);
  return { doc, sheet, root, a, b, a1, a11 };
}

test('markdown: headings for two levels, nested list below, notes, links, attributes', () => {
  const { doc, sheet, root } = build();
  const md = exportMarkdown({ doc, sheet, rootIds: [root], name: 'x' });
  assert.equal(
    md,
    [
      '# Project "X" & Co',
      '',
      '## Plan',
      '',
      'First line',
      'Second line',
      '',
      '- Step 1 *(Owner: Ann)*',
      '  - Detail',
      '',
      '## [Risks <high>](https://example.com/?a=1&b=2)',
      '',
    ].join('\n'),
  );
});

test('freemind: escaped, well nested, keeps folding, sides, notes, attributes and relations', () => {
  const { doc, sheet, root, a, b, a1 } = build();
  const mm = exportFreeMind({ doc, sheet, rootIds: [root], name: 'x' });
  assert.match(mm, /^<map version="1\.0\.1">\n <node ID="ID_\w+" TEXT="Project &quot;X&quot; &amp; Co">/);
  assert.ok(mm.includes(`<node ID="ID_${a}" TEXT="Plan" POSITION="right" FOLDED="true">`));
  assert.ok(mm.includes(`ID="ID_${b}" TEXT="Risks &lt;high&gt;" POSITION="left" LINK="https://example.com/?a=1&amp;b=2"/>`));
  assert.ok(mm.includes('<richcontent TYPE="NOTE"><html><head/><body><p>First line</p><p>Second line</p></body></html></richcontent>'));
  assert.ok(mm.includes('<attribute NAME="Owner" VALUE="Ann"/>'));
  assert.ok(mm.includes(`<arrowlink DESTINATION="ID_${b}" ENDARROW="Default"/>`));
  assert.ok(mm.indexOf(`ID_${a1}`) > mm.indexOf(`ID_${a}"`));
  const opened = (mm.match(/<node [^>]*[^/]>/g) ?? []).length;
  const closed = (mm.match(/<\/node>/g) ?? []).length;
  assert.equal(opened, closed);
  assert.ok(mm.endsWith('</map>\n'));
});

test('freemind: several maps are wrapped in one root; outside relations are dropped', () => {
  const { doc, sheet, root, a, b } = build();
  const second = createNode('Second map');
  applyOps(doc, [{ t: 'insertSubtree', nodes: [second], rootId: second.id, parentId: null, sheetId: sheet.id }]);
  const both = exportFreeMind({ doc, sheet, rootIds: [root, second.id], name: 'x' });
  assert.ok(both.includes(`<node TEXT="${sheet.title}">`));
  assert.ok(both.includes('TEXT="Second map"/>'));
  const branch = exportFreeMind({ doc, sheet, rootIds: [a], name: 'x' });
  assert.equal(branch.includes('arrowlink'), false);
  assert.equal(branch.includes(`ID_${b}`), false);
});
