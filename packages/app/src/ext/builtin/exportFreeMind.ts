import type { Doc, Id, Relation } from '@oc/core';
import { isAncestorOrSelf } from '@oc/core';
import type { ExportInput, Extension } from '../api.ts';

const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');

/**
 * FreeMind 1.0 `.mm`. FreeMind has one root per file, so several maps are
 * wrapped in a root named after the sheet. Kept: text, folding, side of the
 * main branches, URL links, notes, attributes, relations inside the export.
 * Dropped: styles, markers, labels, prompts, reminders, links between nodes.
 */
export function exportFreeMind({ doc, sheet, rootIds }: ExportInput): string {
  const exported = (id: Id) => rootIds.some((rootId) => isAncestorOrSelf(doc, rootId, id));
  const outgoing = new Map<Id, Relation[]>();
  for (const relation of Object.values(doc.relations)) {
    if (!exported(relation.from) || !exported(relation.to)) continue;
    const list = outgoing.get(relation.from);
    if (list) list.push(relation);
    else outgoing.set(relation.from, [relation]);
  }

  const out: string[] = ['<map version="1.0.1">'];
  const walk = (id: Id, indent: string, position?: 'left' | 'right'): void => {
    const node = doc.nodes[id]!;
    let tag = `${indent}<node ID="ID_${id}" TEXT="${escapeXml(node.text)}"`;
    if (position) tag += ` POSITION="${position}"`;
    if (node.collapsed && node.children.length) tag += ' FOLDED="true"';
    if (node.link?.type === 'url') tag += ` LINK="${escapeXml(node.link.url)}"`;
    const inner: string[] = [];
    if (node.notes) {
      const paragraphs = node.notes.split('\n').map((line) => `<p>${escapeXml(line)}</p>`).join('');
      inner.push(`${indent} <richcontent TYPE="NOTE"><html><head/><body>${paragraphs}</body></html></richcontent>`);
    }
    for (const [defId, value] of Object.entries(node.attrs ?? {})) {
      const shown = Array.isArray(value) ? value.join(', ') : String(value);
      inner.push(
        `${indent} <attribute NAME="${escapeXml(doc.attrDefs[defId]?.name ?? defId)}" VALUE="${escapeXml(shown)}"/>`,
      );
    }
    for (const relation of outgoing.get(id) ?? []) {
      inner.push(`${indent} <arrowlink DESTINATION="ID_${relation.to}" ENDARROW="Default"/>`);
    }
    if (inner.length === 0 && node.children.length === 0) {
      out.push(`${tag}/>`);
      return;
    }
    out.push(`${tag}>`, ...inner);
    for (const child of node.children) walk(child, `${indent} `);
    out.push(`${indent}</node>`);
  };

  /** Main branches go right then left, the same split the editor's map structure uses. */
  const walkRoot = (id: Id, indent: string): void => {
    const node = doc.nodes[id]!;
    out.push(`${indent}<node ID="ID_${id}" TEXT="${escapeXml(node.text)}">`);
    const split = node.children.length > 1 ? Math.ceil(node.children.length / 2) : node.children.length;
    node.children.forEach((child, index) => walk(child, `${indent} `, index < split ? 'right' : 'left'));
    out.push(`${indent}</node>`);
  };

  if (rootIds.length === 1) {
    walkRoot(rootIds[0]!, ' ');
  } else {
    out.push(` <node TEXT="${escapeXml(sheet.title)}">`);
    for (const rootId of rootIds) walk(rootId, '  ');
    out.push(' </node>');
  }
  out.push('</map>');
  return out.join('\n') + '\n';
}

export const exportFreeMindExtension: Extension = {
  id: 'builtin.export-freemind',
  name: 'Экспорт в FreeMind',
  activate(ctx) {
    ctx.exporters.register({
      id: 'freemind',
      title: 'FreeMind (.mm)',
      extension: 'mm',
      mime: 'application/x-freemind',
      run: exportFreeMind,
    });
  },
};
