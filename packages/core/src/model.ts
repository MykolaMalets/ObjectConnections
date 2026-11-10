// Document model. Meaning and invariants are described in docs/FORMAT.md.

import { newId } from './ids.ts';

export type Id = string;
export type Ext = Record<string, unknown>;

export type AttrType = 'text' | 'number' | 'date' | 'bool' | 'url' | 'select' | 'multiselect';
export type AttrValue = string | number | boolean | string[];

export interface AttrDef {
  id: Id;
  name: string;
  type: AttrType;
  options?: string[];
  ext?: Ext;
}

export type Link =
  | { type: 'url'; url: string }
  | { type: 'file'; path: string }
  | { type: 'node'; nodeId: Id; docId?: Id; path?: string };

export interface Prompt {
  text: string;
  status: 'draft' | 'queued' | 'running' | 'done' | 'error';
  scope: 'node' | 'subtree' | 'sheet';
  message?: string;
}

export interface Reminder {
  id: Id;
  at: string;
  text?: string;
  calendarEventId?: string;
}

export interface MapNode {
  id: Id;
  parentId: Id | null;
  children: Id[];
  text: string;
  notes?: string;
  labels?: string[];
  markers?: string[];
  attrs?: Record<Id, AttrValue>;
  link?: Link;
  prompt?: Prompt;
  reminders?: Reminder[];
  collapsed?: boolean;
  structure?: string;
  position?: { x: number; y: number };
  style?: Record<string, unknown>;
  modified?: string;
  ext?: Ext;
}

export interface Sheet {
  id: Id;
  title: string;
  rootIds: Id[];
  structure?: string;
  ext?: Ext;
}

export interface Relation {
  id: Id;
  from: Id;
  to: Id;
  text?: string;
  type?: string;
  style?: Record<string, unknown>;
  ext?: Ext;
}

export interface Doc {
  format: 'ocmap';
  version: 1;
  id: Id;
  title: string;
  sheets: Sheet[];
  nodes: Record<Id, MapNode>;
  relations: Record<Id, Relation>;
  attrDefs: Record<Id, AttrDef>;
  ext?: Ext;
}

export function createNode(text: string, id: Id = newId()): MapNode {
  return { id, parentId: null, children: [], text };
}

/** New document with one sheet holding one central node. */
export function createDoc(title: string): Doc {
  const root = createNode(title);
  const sheet: Sheet = { id: newId(), title: 'Sheet 1', rootIds: [root.id] };
  return {
    format: 'ocmap',
    version: 1,
    id: newId(),
    title,
    sheets: [sheet],
    nodes: { [root.id]: root },
    relations: {},
    attrDefs: {},
  };
}

export function getNode(doc: Doc, id: Id): MapNode | undefined {
  return Object.hasOwn(doc.nodes, id) ? doc.nodes[id] : undefined;
}

export function getSheet(doc: Doc, id: Id): Sheet | undefined {
  return doc.sheets.find((s) => s.id === id);
}

/** Root of the tree the node belongs to. */
export function rootOf(doc: Doc, id: Id): MapNode | undefined {
  let node = getNode(doc, id);
  while (node && node.parentId !== null) node = getNode(doc, node.parentId);
  return node;
}

export function sheetOf(doc: Doc, nodeId: Id): Sheet | undefined {
  const root = rootOf(doc, nodeId);
  return root && doc.sheets.find((s) => s.rootIds.includes(root.id));
}

/** Ids of the node and all its descendants, in pre-order. */
export function subtreeIds(doc: Doc, id: Id): Id[] {
  const out: Id[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    const node = getNode(doc, cur);
    if (node) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

export function isAncestorOrSelf(doc: Doc, ancestorId: Id, nodeId: Id): boolean {
  let cur: Id | null = nodeId;
  while (cur !== null) {
    if (cur === ancestorId) return true;
    cur = getNode(doc, cur)?.parentId ?? null;
  }
  return false;
}

/** Stable serialization for *.ocmap files. */
export function serializeDoc(doc: Doc): string {
  return JSON.stringify(doc, null, 1) + '\n';
}
