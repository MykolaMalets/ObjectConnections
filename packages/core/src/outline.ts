// Plain-text outline: how people and agents read a map and describe new branches.

import { newId } from './ids.ts';
import type { Doc, Id, MapNode } from './model.ts';
import { createNode, getNode, getSheet } from './model.ts';
import type { Op } from './ops.ts';
import { OpError } from './ops.ts';

export interface OutlineOptions {
  /** Only this sheet. Default: every sheet. */
  sheetId?: Id;
  /** Only this node's subtree. */
  nodeId?: Id;
  /** Levels below the starting nodes to print; deeper branches are summarised. */
  depth?: number;
}

function flags(doc: Doc, node: MapNode): string {
  const parts: string[] = [];
  if (node.collapsed) parts.push('collapsed');
  if (node.notes) parts.push('note');
  if (node.prompt) parts.push(`prompt:${node.prompt.status}`);
  if (node.link?.type === 'url') parts.push(`link:${node.link.url}`);
  if (node.link?.type === 'file') parts.push(`file:${node.link.path}`);
  if (node.link?.type === 'node') parts.push(`link->${node.link.nodeId}`);
  for (const label of node.labels ?? []) parts.push(`#${label}`);
  for (const [defId, value] of Object.entries(node.attrs ?? {})) {
    parts.push(`${doc.attrDefs[defId]?.name ?? defId}=${Array.isArray(value) ? value.join(',') : String(value)}`);
  }
  if (node.reminders?.length) parts.push(`reminders:${node.reminders.length}`);
  return parts.length ? ` {${parts.join('; ')}}` : '';
}

/** One line per node: `- text [id] {flags}`, indented by two spaces per level. */
export function renderOutline(doc: Doc, options: OutlineOptions = {}): string {
  const out: string[] = [];
  const walk = (id: Id, level: number): void => {
    const node = doc.nodes[id]!;
    const indent = '  '.repeat(level);
    out.push(`${indent}- ${node.text.replace(/\s*\n\s*/g, ' / ')} [${id}]${flags(doc, node)}`);
    if (options.depth !== undefined && level >= options.depth && node.children.length) {
      out.push(`${indent}  … ${node.children.length} more below; use --node ${id}`);
      return;
    }
    for (const child of node.children) walk(child, level + 1);
  };
  if (options.nodeId !== undefined) {
    if (!getNode(doc, options.nodeId)) throw new OpError(`node not found: ${options.nodeId}`);
    walk(options.nodeId, 0);
    return out.join('\n') + '\n';
  }
  if (options.sheetId !== undefined && !getSheet(doc, options.sheetId)) {
    throw new OpError(`sheet not found: ${options.sheetId}`);
  }
  for (const sheet of doc.sheets) {
    if (options.sheetId !== undefined && sheet.id !== options.sheetId) continue;
    out.push(`# Sheet: ${sheet.title} [${sheet.id}]`);
    for (const rootId of sheet.rootIds) walk(rootId, 0);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

export interface OutlineItem {
  text: string;
  children: OutlineItem[];
}

/**
 * Parses an indented list. A deeper indent makes a child; `- `, `* ` and
 * `+ ` bullets are optional; a trailing ` [id]` or ` {flags}` copied from
 * renderOutline output is ignored.
 */
export function parseOutline(text: string): OutlineItem[] {
  const roots: OutlineItem[] = [];
  const stack: { indent: number; item: OutlineItem }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const body = line
      .trim()
      .replace(/^[-*+]\s+/, '')
      .replace(/\s*\{[^{}]*\}$/, '')
      .replace(/\s*\[[0-9A-Za-z]{12}\]$/, '')
      .trim();
    if (!body) continue;
    const item: OutlineItem = { text: body, children: [] };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    (parent ? parent.item.children : roots).push(item);
    stack.push({ indent, item });
  }
  return roots;
}

export interface OutlineTarget {
  parentId: Id | null;
  /** Required when parentId is null: the items become new maps on this sheet. */
  sheetId?: Id;
  index?: number;
}

/** Builds one insertSubtree per top-level item. Returns the ids of the new top-level nodes. */
export function opsFromOutline(
  items: OutlineItem[],
  target: OutlineTarget,
  makeId: () => Id = newId,
): { ops: Op[]; rootIds: Id[] } {
  const ops: Op[] = [];
  const rootIds: Id[] = [];
  items.forEach((top, offset) => {
    const nodes: MapNode[] = [];
    const build = (item: OutlineItem, parentId: Id | null): Id => {
      const node = createNode(item.text, makeId());
      node.parentId = parentId;
      nodes.push(node);
      node.children = item.children.map((child) => build(child, node.id));
      return node.id;
    };
    const rootId = build(top, target.parentId);
    const op: Op = { t: 'insertSubtree', nodes, rootId, parentId: target.parentId };
    if (target.sheetId !== undefined) op.sheetId = target.sheetId;
    if (target.index !== undefined) op.index = target.index + offset;
    ops.push(op);
    rootIds.push(rootId);
  });
  return { ops, rootIds };
}

/** Texts from the map root down to the node. */
export function pathOf(doc: Doc, id: Id): string[] {
  const path: string[] = [];
  for (let node = getNode(doc, id); node; node = node.parentId === null ? undefined : getNode(doc, node.parentId)) {
    path.unshift(node.text);
  }
  return path;
}
