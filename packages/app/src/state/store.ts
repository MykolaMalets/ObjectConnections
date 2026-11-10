// Editor state: open files (sessions), selection, drill-down, and every user
// action. Actions are the only code that calls History.apply in the app.

import type { Doc, Id, MapNode, Op, Sheet } from '@oc/core';
import {
  History,
  OpError,
  createDoc,
  createNode,
  getNode,
  getSheet,
  isAncestorOrSelf,
  newId,
  opsExtractToSheet,
  sheetOf,
} from '@oc/core';
import type { FileRef } from '../storage/provider.ts';
import type { View } from '../view/render.ts';

export const NEW_TOPIC_TEXT = 'Подтема';
export const NEW_ROOT_TEXT = 'Новая карта';

export interface Editing {
  id: Id;
  /** Initial content of the editor. */
  text: string;
  /** Select the whole text (F2) instead of placing the caret at the end (typing). */
  selectAll: boolean;
}

/** One open file with its view state. View state is not part of undo history. */
export class Session {
  readonly id = newId();
  history: History;
  /** Increases when the whole document is replaced; part of every view cache key. */
  epoch = 0;
  name: string;
  sheetId: Id;
  selection: Id | null;
  /** Drill-down stack: the last id is the node currently shown as the root. */
  focusPath: Id[] = [];
  view: View = { scale: 1, x: 0, y: 0 };
  /** Ask the canvas to centre the view root on the next frame. */
  needsCenter = true;
  /** Ask the canvas to scroll the selection into view on the next frame. */
  reveal = false;
  editing: Editing | null = null;
  file: FileRef | null = null;
  fileVersion = '';
  savedRevision = 0;
  saving = false;
  /** Why the last save failed. While set, autosave waits for a successful manual save. */
  saveError: string | null = null;
  /** The file changed outside the editor since it was read; autosave is paused. */
  conflict = false;

  constructor(doc: Doc, name: string) {
    this.history = Session.historyFor(doc);
    this.name = name;
    this.sheetId = doc.sheets[0]?.id ?? '';
    this.selection = doc.sheets[0]?.rootIds[0] ?? null;
  }

  static historyFor(doc: Doc): History {
    return new History(doc, { now: () => new Date().toISOString() });
  }

  /**
   * Swaps in a document read again from storage. Undo history starts over;
   * selection and drill-down survive where the same node ids still exist.
   */
  replaceDoc(doc: Doc): void {
    this.history = Session.historyFor(doc);
    this.savedRevision = 0;
    this.editing = null;
    this.epoch++;
  }

  get doc(): Doc {
    return this.history.doc;
  }

  get sheet(): Sheet | undefined {
    return getSheet(this.doc, this.sheetId);
  }

  get focusId(): Id | null {
    return this.focusPath[this.focusPath.length - 1] ?? null;
  }

  get dirty(): boolean {
    return this.history.revision !== this.savedRevision;
  }

  /** Roots shown by the canvas: the drill-down focus, or every map of the sheet. */
  get viewRoots(): Id[] {
    return this.focusId ? [this.focusId] : (this.sheet?.rootIds ?? []);
  }

  /** Repairs view state after the document changed under it (undo, delete, external edits). */
  normalize(): void {
    const doc = this.doc;
    if (!this.sheet) this.sheetId = doc.sheets[0]?.id ?? '';
    const sheet = this.sheet;
    const valid = (id: Id) => !!getNode(doc, id) && sheetOf(doc, id) === sheet;
    const firstBad = this.focusPath.findIndex((id) => !valid(id));
    if (firstBad >= 0) this.focusPath.length = firstBad;
    const focus = this.focusId;
    let selection = this.selection;
    if (selection && (!valid(selection) || (focus && !isAncestorOrSelf(doc, focus, selection)))) selection = null;
    if (selection) {
      // A node hidden inside a collapsed branch cannot stay selected.
      let hiddenUnder: Id | null = null;
      for (let cur = getNode(doc, selection)?.parentId ?? null; cur !== null; ) {
        const node: MapNode = doc.nodes[cur]!;
        if (cur === focus) break;
        if (node.collapsed && node.parentId !== null) hiddenUnder = cur;
        cur = node.parentId;
      }
      if (hiddenUnder) selection = hiddenUnder;
    }
    this.selection = selection ?? focus ?? sheet?.rootIds[0] ?? null;
    if (this.editing && !getNode(doc, this.editing.id)) this.editing = null;
  }
}

export class Workspace {
  sessions: Session[] = [];
  active = 0;
  version = 0;
  listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  get session(): Session | undefined {
    return this.sessions[this.active];
  }

  notify(): void {
    for (const s of this.sessions) s.normalize();
    this.version++;
    for (const listener of this.listeners) listener();
  }

  add(session: Session): void {
    this.sessions.push(session);
    this.active = this.sessions.length - 1;
    this.notify();
  }

  close(session: Session): void {
    const index = this.sessions.indexOf(session);
    if (index < 0) return;
    this.sessions.splice(index, 1);
    this.active = Math.max(0, Math.min(this.active, this.sessions.length - 1));
    this.notify();
  }

  activate(session: Session): void {
    this.active = Math.max(0, this.sessions.indexOf(session));
    this.notify();
  }
}

export function newSession(ws: Workspace): void {
  const count = ws.sessions.filter((s) => !s.file).length + 1;
  const doc = createDoc('Центральная тема');
  doc.sheets[0]!.title = 'Лист 1';
  ws.add(new Session(doc, `Карта ${count}`));
}

/** Applies operations as one undo step. Returns false when the document rejected them. */
function run(s: Session, ops: Op[], label: string): boolean {
  try {
    s.history.apply(ops, label);
    return true;
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    console.warn(`${label}: ${error.message}`);
    return false;
  }
}

/** Applies operations coming from outside the built-in actions (extensions, panels). */
export function execute(ws: Workspace, ops: Op[], label: string): boolean {
  const s = ws.session;
  const ok = !!s && run(s, ops, label);
  ws.notify();
  return ok;
}

function insertOp(node: MapNode, parentId: Id, index?: number): Op {
  node.parentId = parentId;
  const op: Op = { t: 'insertSubtree', nodes: [node], rootId: node.id, parentId };
  if (index !== undefined) op.index = index;
  return op;
}

export function select(ws: Workspace, id: Id | null, reveal = false): void {
  const s = ws.session;
  if (!s) return;
  s.selection = id;
  s.reveal = reveal;
  ws.notify();
}

export function addChild(ws: Workspace): void {
  const s = ws.session;
  const parent = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !parent) return;
  const node = createNode(NEW_TOPIC_TEXT);
  const ops: Op[] = [insertOp(node, parent.id)];
  if (parent.collapsed) ops.push({ t: 'patchNode', id: parent.id, patch: { collapsed: null } });
  if (run(s, ops, 'Добавить подтему')) {
    s.selection = node.id;
    s.reveal = true;
  }
  ws.notify();
}

export function addSibling(ws: Workspace, before = false): void {
  const s = ws.session;
  const current = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !current) return;
  if (current.parentId === null || current.id === s.focusId) return addChild(ws);
  const siblings = s.doc.nodes[current.parentId]!.children;
  const node = createNode(NEW_TOPIC_TEXT);
  const index = siblings.indexOf(current.id) + (before ? 0 : 1);
  if (run(s, [insertOp(node, current.parentId, index)], 'Добавить тему')) {
    s.selection = node.id;
    s.reveal = true;
  }
  ws.notify();
}

export function addFloating(ws: Workspace, position: { x: number; y: number }): void {
  const s = ws.session;
  if (!s || !s.sheet || s.focusId) return;
  const node = createNode(NEW_ROOT_TEXT);
  node.position = position;
  const op: Op = { t: 'insertSubtree', nodes: [node], rootId: node.id, parentId: null, sheetId: s.sheet.id };
  if (run(s, [op], 'Добавить карту')) s.selection = node.id;
  ws.notify();
}

export function removeSelected(ws: Workspace): void {
  const s = ws.session;
  const node = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !node || node.id === s.focusId) return;
  const siblings = node.parentId === null ? (s.sheet?.rootIds ?? []) : s.doc.nodes[node.parentId]!.children;
  if (node.parentId === null && siblings.length <= 1) return;
  const index = siblings.indexOf(node.id);
  const next = siblings[index + 1] ?? siblings[index - 1] ?? node.parentId;
  if (run(s, [{ t: 'removeSubtree', id: node.id }], 'Удалить')) {
    s.selection = next;
    s.reveal = true;
  }
  ws.notify();
}

export function startEdit(ws: Workspace, typed?: string): void {
  const s = ws.session;
  const node = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !node) return;
  s.editing = { id: node.id, text: typed ?? node.text, selectAll: typed === undefined };
  s.reveal = true;
  ws.notify();
}

export function finishEdit(ws: Workspace, text: string | null): void {
  const s = ws.session;
  const editing = s?.editing;
  if (!s || !editing) return;
  s.editing = null;
  const node = getNode(s.doc, editing.id);
  if (node && text !== null && text !== node.text) {
    run(s, [{ t: 'patchNode', id: node.id, patch: { text } }], 'Изменить текст');
  }
  ws.notify();
}

export function toggleCollapse(ws: Workspace, id: Id, collapsed?: boolean): void {
  const s = ws.session;
  const node = s && getNode(s.doc, id);
  if (!s || !node || node.children.length === 0) return;
  const value = collapsed ?? !node.collapsed;
  if (value === !!node.collapsed) return;
  run(s, [{ t: 'patchNode', id, patch: { collapsed: value ? true : null } }], value ? 'Свернуть' : 'Развернуть');
  ws.notify();
}

/** Moves the selected node among its siblings (Alt+Up / Alt+Down). */
export function moveSibling(ws: Workspace, delta: number): void {
  const s = ws.session;
  const node = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !node || node.parentId === null) return;
  const siblings = s.doc.nodes[node.parentId]!.children;
  const index = siblings.indexOf(node.id) + delta;
  if (index < 0 || index >= siblings.length) return;
  run(s, [{ t: 'moveNode', id: node.id, parentId: node.parentId, index }], 'Переместить');
  s.reveal = true;
  ws.notify();
}

export function reparent(ws: Workspace, id: Id, parentId: Id): void {
  const s = ws.session;
  if (!s || id === parentId) return;
  const node = getNode(s.doc, id);
  const parent = getNode(s.doc, parentId);
  if (!node || !parent || node.parentId === parentId) return;
  const ops: Op[] = [{ t: 'moveNode', id, parentId }];
  if (node.position) ops.push({ t: 'patchNode', id, patch: { position: null } });
  if (parent.collapsed) ops.push({ t: 'patchNode', id: parentId, patch: { collapsed: null } });
  run(s, ops, 'Перенести ветку');
  ws.notify();
}

export function setRootPosition(ws: Workspace, id: Id, position: { x: number; y: number }): void {
  const s = ws.session;
  if (!s) return;
  run(s, [{ t: 'patchNode', id, patch: { position } }], 'Передвинуть карту');
  ws.notify();
}

export function undo(ws: Workspace): void {
  ws.session?.history.undo();
  if (ws.session) ws.session.reveal = true;
  ws.notify();
}

export function redo(ws: Workspace): void {
  ws.session?.history.redo();
  if (ws.session) ws.session.reveal = true;
  ws.notify();
}

/** Node whose link points at the given node, if any (the "way up" from an extracted branch). */
function linkSource(doc: Doc, targetId: Id): MapNode | undefined {
  return Object.values(doc.nodes).find((n) => n.link?.type === 'node' && !n.link.docId && n.link.nodeId === targetId);
}

function goToNode(s: Session, id: Id): void {
  const sheet = sheetOf(s.doc, id);
  if (!sheet) return;
  s.sheetId = sheet.id;
  s.focusPath = [];
  s.selection = id;
  s.needsCenter = true;
}

/** F6: show the selected node as the root. On a link node, jump to the linked branch instead. */
export function drillDown(ws: Workspace): void {
  const s = ws.session;
  const node = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !node) return;
  if (node.link?.type === 'node' && !node.link.docId && getNode(s.doc, node.link.nodeId)) {
    goToNode(s, node.link.nodeId);
  } else if (node.id !== s.focusId && (node.parentId !== null || s.focusId)) {
    s.focusPath.push(node.id);
    s.needsCenter = true;
  }
  ws.notify();
}

/** Shift+F6: one level up. From a sheet root, jump to the node that links to it. */
export function drillUp(ws: Workspace): void {
  const s = ws.session;
  if (!s) return;
  const left = s.focusPath.pop();
  if (left) {
    s.selection = left;
    s.needsCenter = true;
  } else {
    const root = s.selection ? s.sheet?.rootIds.find((id) => isAncestorOrSelf(s.doc, id, s.selection!)) : undefined;
    const source = root && linkSource(s.doc, root);
    if (source) goToNode(s, source.id);
  }
  ws.notify();
}

/** Breadcrumb click: keep the first `depth` levels of the drill-down stack. */
export function drillTo(ws: Workspace, depth: number): void {
  const s = ws.session;
  if (!s || depth >= s.focusPath.length) return;
  s.selection = s.focusPath[depth] ?? null;
  s.focusPath.length = depth;
  s.needsCenter = true;
  ws.notify();
}

export function selectSheet(ws: Workspace, sheetId: Id): void {
  const s = ws.session;
  const sheet = s && getSheet(s.doc, sheetId);
  if (!s || !sheet) return;
  s.sheetId = sheetId;
  s.focusPath = [];
  s.selection = sheet.rootIds[0] ?? null;
  s.needsCenter = true;
  ws.notify();
}

export function addSheet(ws: Workspace): void {
  const s = ws.session;
  if (!s) return;
  const sheetId = newId();
  const root = createNode('Центральная тема');
  const ops: Op[] = [
    { t: 'insertSheet', sheet: { id: sheetId, title: `Лист ${s.doc.sheets.length + 1}`, rootIds: [] } },
    { t: 'insertSubtree', nodes: [root], rootId: root.id, parentId: null, sheetId },
  ];
  if (run(s, ops, 'Добавить лист')) selectSheet(ws, sheetId);
  else ws.notify();
}

export function renameSheet(ws: Workspace, sheetId: Id, title: string): void {
  const s = ws.session;
  if (!s || !title.trim()) return;
  run(s, [{ t: 'patchSheet', id: sheetId, patch: { title: title.trim() } }], 'Переименовать лист');
  ws.notify();
}

/** Moves the selected branch to its own sheet, leaving a link node behind. */
export function extractSelectedToSheet(ws: Workspace): void {
  const s = ws.session;
  const node = s?.selection ? getNode(s.doc, s.selection) : undefined;
  if (!s || !node || node.parentId === null) return;
  const { ops, sheetId } = opsExtractToSheet(s.doc, node.id, { leaveLink: true });
  if (run(s, ops, 'Вынести на лист')) {
    s.sheetId = sheetId;
    s.focusPath = [];
    s.selection = node.id;
    s.needsCenter = true;
  }
  ws.notify();
}
