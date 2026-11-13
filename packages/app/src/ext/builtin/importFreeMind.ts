// FreeMind / Freeplane import (.mm). Kept: topic text (plain or rich), folding,
// links (web addresses, files, links to other topics), notes and details as
// plain text, attributes (as text attributes), arrow links as relations.
// Dropped: icons, styles, fonts, clouds, edge looks, positions of free nodes.
// No DOM: tested in Node.

import type { AttrValue, Doc, Id, Link, MapNode, Relation } from '@oc/core';
import { createDoc, createNode, newId } from '@oc/core';
import type { Extension } from '../api.ts';
import type { XmlElement } from './xml.ts';
import { elements, htmlToText, parseXml } from './xml.ts';

function richText(node: XmlElement, type: string): string {
  const rich = elements(node, 'richcontent').find((r) => (r.attrs.TYPE ?? '').toUpperCase() === type);
  return rich ? htmlToText(rich) : '';
}

/** A link to another topic ('#ID') can be resolved only after all topics are read: 'pending'. */
function linkOf(raw: string): Link | 'pending' | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('#')) return 'pending';
  if (/^(https?|mailto|ftp):/i.test(raw)) return { type: 'url', url: raw };
  const path = raw.replace(/^file:(\/\/)?/i, '');
  try {
    return { type: 'file', path: decodeURI(path) };
  } catch {
    return { type: 'file', path };
  }
}

function linkToNode(raw: string, ids: Map<string, Id>): Link | undefined {
  const target = ids.get(raw.slice(1));
  return target ? { type: 'node', nodeId: target } : undefined;
}

export function importFreeMind(text: string, fileName = 'map.mm'): Doc {
  const map = parseXml(text);
  if (map.name !== 'map') throw new Error('это не файл FreeMind: нет элемента <map>');
  const rootElement = elements(map, 'node')[0];
  if (!rootElement) throw new Error('в файле FreeMind нет ни одной темы');

  const topicText = (element: XmlElement) => element.attrs.TEXT ?? richText(element, 'NODE');
  const doc = createDoc(topicText(rootElement) || fileName.replace(/\.[^.]+$/, ''));
  doc.title = doc.nodes[doc.sheets[0]!.rootIds[0]!]!.text;
  const rootId = doc.sheets[0]!.rootIds[0]!;

  /** FreeMind ID → our id, for links between topics and arrow links. */
  const ids = new Map<string, Id>();
  const attrIdByName = new Map<string, Id>();
  const arrows: { from: Id; to: string; text?: string }[] = [];
  const nodeLinks: { id: Id; raw: string }[] = [];

  const fill = (element: XmlElement, node: MapNode): void => {
    if (element.attrs.ID) ids.set(element.attrs.ID, node.id);
    const notes = [richText(element, 'NOTE'), richText(element, 'DETAILS')].filter(Boolean).join('\n\n');
    if (notes) node.notes = notes;
    const link = linkOf(element.attrs.LINK ?? '');
    if (link === 'pending') nodeLinks.push({ id: node.id, raw: element.attrs.LINK! });
    else if (link) node.link = link;

    for (const attribute of elements(element, 'attribute')) {
      const name = attribute.attrs.NAME?.trim();
      if (!name) continue;
      let defId = attrIdByName.get(name);
      if (!defId) {
        defId = newId();
        attrIdByName.set(name, defId);
        doc.attrDefs[defId] = { id: defId, name, type: 'text' };
      }
      (node.attrs ??= {})[defId] = (attribute.attrs.VALUE ?? '') satisfies AttrValue;
    }
    for (const arrow of elements(element, 'arrowlink')) {
      const to = arrow.attrs.DESTINATION;
      if (!to) continue;
      const label = arrow.attrs.MIDDLE_LABEL || arrow.attrs.SOURCE_LABEL || arrow.attrs.TARGET_LABEL;
      arrows.push({ from: node.id, to, ...(label ? { text: label } : {}) });
    }

    for (const childElement of elements(element, 'node')) {
      const child = createNode(topicText(childElement));
      child.parentId = node.id;
      doc.nodes[child.id] = child;
      node.children.push(child.id);
      fill(childElement, child);
    }
    if ((element.attrs.FOLDED ?? '').toLowerCase() === 'true' && node.children.length && node.parentId !== null) {
      node.collapsed = true;
    }
  };
  fill(rootElement, doc.nodes[rootId]!);

  for (const { id, raw } of nodeLinks) {
    const link = linkToNode(raw, ids);
    if (link) doc.nodes[id]!.link = link;
  }
  for (const arrow of arrows) {
    const to = ids.get(arrow.to);
    if (!to) continue;
    const relation: Relation = { id: newId(), from: arrow.from, to };
    if (arrow.text) relation.text = arrow.text;
    doc.relations[relation.id] = relation;
  }
  return doc;
}

export const importFreeMindExtension: Extension = {
  id: 'builtin.import-freemind',
  name: 'Импорт из FreeMind',
  activate(ctx) {
    ctx.importers.register({
      id: 'freemind',
      title: 'FreeMind / Freeplane (.mm)',
      extensions: ['.mm'],
      run: importFreeMind,
    });
  },
};
