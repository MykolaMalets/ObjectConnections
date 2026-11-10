import type { Doc, Id } from './model.ts';
import { getNode } from './model.ts';
import type { Op } from './ops.ts';
import { applyOps } from './ops.ts';

interface Entry {
  label: string;
  /** Operations that revert (on the undo stack) or re-apply (on the redo stack) the change. */
  ops: Op[];
}

export interface HistoryOptions {
  /** Returns the timestamp written to `modified` of touched nodes. Omit to disable stamping. */
  now?: () => string;
  /** Maximum number of undo steps kept. */
  limit?: number;
}

export type HistoryListener = (label: string) => void;

/** Owns a document and is the single entry point for changing it. */
export class History {
  readonly doc: Doc;
  readonly options: HistoryOptions;
  undoStack: Entry[] = [];
  redoStack: Entry[] = [];
  listeners = new Set<HistoryListener>();
  /** Increases on every change; views use it to invalidate caches. */
  revision = 0;

  constructor(doc: Doc, options: HistoryOptions = {}) {
    this.doc = doc;
    this.options = options;
  }

  /** Applies the operations atomically as one undo step. Throws OpError and changes nothing on failure. */
  apply(ops: Op[], label = ''): void {
    if (ops.length === 0) return;
    let inverse = applyOps(this.doc, ops);
    const stamps = this.stampOps(ops);
    if (stamps.length) inverse = [...applyOps(this.doc, stamps), ...inverse];
    this.undoStack.push({ label, ops: inverse });
    const limit = this.options.limit ?? 500;
    if (this.undoStack.length > limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit(label);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    return this.shift(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.shift(this.redoStack, this.undoStack);
  }

  subscribe(listener: HistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shift(from: Entry[], to: Entry[]): boolean {
    const entry = from.pop();
    if (!entry) return false;
    to.push({ label: entry.label, ops: applyOps(this.doc, entry.ops) });
    this.emit(entry.label);
    return true;
  }

  emit(label: string): void {
    this.revision++;
    for (const listener of this.listeners) listener(label);
  }

  stampOps(ops: Op[]): Op[] {
    if (!this.options.now) return [];
    const touched = new Set<Id>();
    for (const op of ops) {
      if (op.t === 'patchNode' || op.t === 'setAttr' || op.t === 'moveNode') touched.add(op.id);
      else if (op.t === 'insertSubtree') touched.add(op.rootId);
    }
    const modified = this.options.now();
    return [...touched]
      .filter((id) => getNode(this.doc, id))
      .map((id) => ({ t: 'patchNode', id, patch: { modified } }) satisfies Op);
  }
}
