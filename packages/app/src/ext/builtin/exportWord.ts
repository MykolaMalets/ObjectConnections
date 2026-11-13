// Word export (.docx). Topics become headings of their level (Heading 1–6), so
// Word's navigation pane shows the map's structure; deeper topics become
// indented lines. Notes follow their topic as paragraphs, attributes as an
// italic line, URL links as hyperlinks. Not exported: relations, labels,
// reminders, prompts, layout. No DOM: tested in Node.

import type { Doc, Id } from '@oc/core';
import type { ExportInput, Extension } from '../api.ts';
import { markerGlyphs } from '../../view/markers.ts';
import { zip } from './zip.ts';

const HEADING_LEVELS = 6;
const INDENT_TWIPS = 360;

const escapeXml = (text: string) =>
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;

const paragraph = (content: string, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;

function attributesLine(doc: Doc, id: Id): string {
  const attrs = doc.nodes[id]!.attrs;
  if (!attrs) return '';
  return Object.entries(attrs)
    .map(([defId, value]) => `${doc.attrDefs[defId]?.name ?? defId}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('; ');
}

/** The .docx file as bytes. */
export function buildDocx({ doc, rootIds, name }: ExportInput): Uint8Array {
  const body: string[] = [];
  const links: string[] = [];

  const walk = (id: Id, depth: number): void => {
    const node = doc.nodes[id]!;
    const markers = markerGlyphs(node).join('');
    const text = (markers ? `${markers} ` : '') + (oneLine(node.text) || '…');
    let content = run(depth < HEADING_LEVELS ? text : `• ${text}`);
    if (node.link?.type === 'url') {
      const rid = `rIdLink${links.length + 1}`;
      links.push(
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(node.link.url)}" TargetMode="External"/>`,
      );
      content = `<w:hyperlink r:id="${rid}">${run(depth < HEADING_LEVELS ? text : `• ${text}`, '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>`;
    }
    const indent = depth < HEADING_LEVELS ? '' : `<w:ind w:left="${INDENT_TWIPS * (depth - HEADING_LEVELS + 1)}"/>`;
    body.push(paragraph(content, depth < HEADING_LEVELS ? `<w:pStyle w:val="Heading${depth + 1}"/>` : indent));
    const attrs = [(node.labels ?? []).map((l) => `#${l}`).join(' '), attributesLine(doc, id)].filter(Boolean).join(' · ');
    if (attrs) body.push(paragraph(run(attrs, '<w:i/>'), indent));
    for (const line of node.notes?.trim().split('\n') ?? []) {
      if (line.trim()) body.push(paragraph(run(line), indent));
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const rootId of rootIds) walk(rootId, 0);

  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const document =
    header +
    `<w:document ${w} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>` +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const headingStyle = (level: number) => {
    const size = [32, 28, 26, 24, 22, 22][level - 1]!;
    return (
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 360 : 200}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
      `<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${size}"/></w:rPr></w:style>`
    );
  };
  const styles =
    header +
    `<w:styles ${w}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    Array.from({ length: HEADING_LEVELS }, (_, i) => headingStyle(i + 1)).join('') +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
    '</w:styles>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    header +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(name)}</dc:title><dc:creator>ObjectConnections</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;

  return zip([
    {
      name: '[Content_Types].xml',
      data:
        header +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        header +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    },
    { name: 'docProps/core.xml', data: core },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        header +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        links.join('') +
        '</Relationships>',
    },
  ]);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const exportWordExtension: Extension = {
  id: 'builtin.export-word',
  name: 'Экспорт в Word',
  activate(ctx) {
    ctx.exporters.register({
      id: 'docx',
      title: 'Документ Word (.docx)',
      extension: 'docx',
      mime: DOCX_MIME,
      run: (input) => new Blob([buildDocx(input) as BlobPart], { type: DOCX_MIME }),
    });
  },
};
