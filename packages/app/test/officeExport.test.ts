import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Doc, Id, Op } from '@oc/core';
import { applyOps, createDoc, createNode } from '@oc/core';
import { buildPdf, pageSize } from '../src/ext/builtin/exportPdf.ts';
import { buildDocx } from '../src/ext/builtin/exportWord.ts';
import { crc32 } from '../src/ext/builtin/zip.ts';

function add(doc: Doc, parentId: Id, text: string): Id {
  const node = createNode(text);
  node.parentId = parentId;
  applyOps(doc, [{ t: 'insertSubtree', nodes: [node], rootId: node.id, parentId } satisfies Op]);
  return node.id;
}

/** Reads a stored (uncompressed) zip into name → text. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    assert.equal(view.getUint16(at + 8, true), 0, 'stored');
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files.set(name, new TextDecoder().decode(data));
    at += 30 + nameLength + size;
  }
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  assert.equal(view.getUint16(end + 10, true), files.size);
  assert.equal(view.getUint32(end + 16, true), at, 'central directory offset');
  return files;
}

test('crc32 matches the reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('docx has headings by level, notes, attributes and links', () => {
  const doc = createDoc('Проект <X> & Co');
  const sheet = doc.sheets[0]!;
  const root = sheet.rootIds[0]!;
  const a = add(doc, root, 'Ветка');
  applyOps(doc, [
    { t: 'patchNode', id: a, patch: { notes: 'Первая строка\nВторая', link: { type: 'url', url: 'https://example.com/?a=1&b=2' } } },
  ]);
  let deep = a;
  for (let i = 0; i < 6; i++) deep = add(doc, deep, `Уровень ${i + 2}`);

  const files = unzip(buildDocx({ doc, sheet, rootIds: [root], name: 'Карта' }));
  assert.deepEqual(
    [...files.keys()].sort(),
    ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'],
  );
  const body = files.get('word/document.xml')!;
  assert.match(body, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Проект &lt;X&gt; &amp; Co</);
  assert.match(body, /Heading2[\s\S]*<w:hyperlink r:id="rIdLink1">[\s\S]*Ветка/);
  assert.match(body, /Первая строка[\s\S]*Вторая/);
  assert.match(body, /Heading6"\/><\/w:pPr><w:r><w:t xml:space="preserve">Уровень 5</);
  assert.match(body, /<w:ind w:left="360"\/><\/w:pPr><w:r><w:t xml:space="preserve">• Уровень 6/);
  assert.match(body, /<w:ind w:left="720"\/><\/w:pPr><w:r><w:t xml:space="preserve">• Уровень 7/);
  assert.match(files.get('word/_rels/document.xml.rels')!, /Target="https:\/\/example.com\/\?a=1&amp;b=2" TargetMode="External"/);
  assert.match(files.get('docProps/core.xml')!, /<dc:title>Карта<\/dc:title>/);
  for (const [name, xml] of files) assert.ok(xml.startsWith('<?xml'), name);
});

test('pdf cross-reference table points at its objects', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
  const pdf = buildPdf(jpeg, { width: 3, height: 2 }, pageSize(400, 300), 'Карта');
  const text = new TextDecoder('latin1').decode(pdf);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
  assert.ok(text.slice(startxref).startsWith('xref\n0 7\n'));
  const offsets = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 6);
  offsets.forEach((offset, index) => assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`), `object ${index + 1}`));
  assert.match(text, /\/MediaBox \[0 0 300 225\]/);
  assert.match(text, /\/Title <FEFF041A0430044004420430>/);
});

test('pdf page stays within the size readers accept', () => {
  const page = pageSize(40_000, 1000);
  assert.ok(page.width <= 14_400 && page.width > 14_399);
  assert.equal(Math.round((page.width / page.height) * 100) / 100, 40);
});
