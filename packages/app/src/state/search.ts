// Finding topics: by words in their text, note, labels, attribute values or
// link, optionally narrowed to a label or to one attribute. No DOM: tested in Node.

import type { AttrValue, Doc, Id } from '@oc/core';

export interface SearchFilter {
  /** Words to find; empty means "every topic that passes the filters". */
  query: string;
  /** Only topics with this label. */
  label?: string;
  /** Only topics that have a value for this attribute; the query is then looked for in that value. */
  attrId?: Id;
}

export type MatchField = 'text' | 'notes' | 'label' | 'attr' | 'link';

export interface SearchMatch {
  id: Id;
  sheetId: Id;
  /** Where the query was found; 'text' when only filters apply. */
  field: MatchField;
}

/** Case-insensitive, and «ё» is the same as «е». */
export const normalize = (text: string) => text.toLocaleLowerCase('ru').replace(/ё/g, 'е');

export function attrText(value: AttrValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

/**
 * Matches in reading order: sheets in order, each map from the root down,
 * collapsed branches included. Every word of the query must occur in the same field.
 */
export function searchDoc(doc: Doc, filter: SearchFilter): SearchMatch[] {
  const words = normalize(filter.query).split(/\s+/).filter(Boolean);
  if (words.length === 0 && !filter.label && !filter.attrId) return [];
  const has = (text: string | undefined) => {
    if (!text) return false;
    const n = normalize(text);
    return words.every((word) => n.includes(word));
  };

  const fieldOf = (id: Id): MatchField | null => {
    const node = doc.nodes[id]!;
    if (filter.label && !node.labels?.includes(filter.label)) return null;
    if (filter.attrId) {
      const value = node.attrs?.[filter.attrId];
      if (value === undefined) return null;
      return words.length === 0 ? 'text' : has(attrText(value)) ? 'attr' : null;
    }
    if (words.length === 0) return 'text';
    if (has(node.text)) return 'text';
    if (has(node.notes)) return 'notes';
    if (node.labels?.some((label) => has(label))) return 'label';
    if (Object.values(node.attrs ?? {}).some((value) => has(attrText(value)))) return 'attr';
    if (node.link?.type === 'url' && has(node.link.url)) return 'link';
    return null;
  };

  const matches: SearchMatch[] = [];
  for (const sheet of doc.sheets) {
    const walk = (id: Id): void => {
      const field = fieldOf(id);
      if (field) matches.push({ id, sheetId: sheet.id, field });
      for (const child of doc.nodes[id]!.children) walk(child);
    };
    for (const rootId of sheet.rootIds) walk(rootId);
  }
  return matches;
}

/** Labels used in the document, sorted. */
export function docLabels(doc: Doc): string[] {
  const labels = new Set<string>();
  for (const node of Object.values(doc.nodes)) for (const label of node.labels ?? []) labels.add(label);
  return [...labels].sort((a, b) => a.localeCompare(b, 'ru'));
}
