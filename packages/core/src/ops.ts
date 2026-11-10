// Operations: the only way to mutate a Doc. See docs/FORMAT.md.
// applyOp checks every precondition before the first mutation, so a thrown
// OpError always leaves the document untouched.

import type { AttrDef, AttrValue, Doc, Id, MapNode, Relation, Sheet } from './model.ts';
import { getNode, getSheet, isAncestorOrSelf, sheetOf, subtreeIds } from './model.ts';

export type Patch = Record<string, unknown>;

export type Op =
  | {
      t: 'insertSubtree';
      nodes: MapNode[];
      rootId: Id;
      parentId: Id | null;
      sheetId?: Id;
      index?: number;
      relations?: Relation[];
    }
  | { t: 'removeSubtree'; id: Id }
  | { t: 'moveNode'; id: Id; parentId: Id | null; sheetId?: Id; index?: number }
  | { t: 'patchNode'; id: Id; patch: Patch }
  | { t: 'setAttr'; id: Id; defId: Id; value: AttrValue | null }
  | { t: 'putAttrDef'; def: AttrDef }
  | { t: 'removeAttrDef'; id: Id }
  | { t: 'insertSheet'; sheet: Sheet; index?: number }
  | { t: 'removeSheet'; id: Id }
  | { t: 'patchSheet'; id: Id; patch: Patch }
  | { t: 'putRelation'; relation: Relation }
  | { t: 'removeRelation'; id: Id }
  | { t: 'patchDoc'; patch: Patch };

export class OpError extends Error {}

function fail(message: string): never {
  throw new OpError(message);
}

const NODE_STRUCTURAL_KEYS = new Set(['id', 'parentId', 'children', 'attrs']);
const SHEET_PATCH_KEYS = new Set(['title', 'structure', 'ext']);
const DOC_PATCH_KEYS = new Set(['title', 'ext']);

type Kind = 'node' | 'sheet' | 'relation' | 'attrDef';

function kindOfId(doc: Doc, id: Id): Kind | undefined {
  if (Object.hasOwn(doc.nodes, id)) return 'node';
  if (Object.hasOwn(doc.relations, id)) return 'relation';
  if (Object.hasOwn(doc.attrDefs, id)) return 'attrDef';
  if (doc.sheets.some((s) => s.id === id)) return 'sheet';
  return undefined;
}

function requireNode(doc: Doc, id: Id): MapNode {
  return getNode(doc, id) ?? fail(`node not found: ${id}`);
}

function requireSheet(doc: Doc, id: Id | undefined): Sheet {
  if (id === undefined) fail('sheetId is required when parentId is null');
  return getSheet(doc, id) ?? fail(`sheet not found: ${id}`);
}

/** Sibling list a node lives in: parent's children or the sheet's roots. */
function siblingList(doc: Doc, parentId: Id | null, sheetId: Id | undefined): Id[] {
  return parentId !== null ? requireNode(doc, parentId).children : requireSheet(doc, sheetId).rootIds;
}

function checkIndex(index: number | undefined, length: number): number {
  if (index === undefined) return length;
  if (!Number.isInteger(index) || index < 0 || index > length) fail(`index out of range: ${index}`);
  return index;
}

/** Applies a patch (null deletes a key) and returns the patch that reverts it. */
function patchObject(target: object, patch: Patch): Patch {
  const obj = target as Record<string, unknown>;
  const inverse: Patch = {};
  for (const [key, value] of Object.entries(patch)) {
    inverse[key] = obj[key] === undefined ? null : structuredClone(obj[key]);
    if (value === null || value === undefined) delete obj[key];
    else obj[key] = structuredClone(value);
  }
  return inverse;
}

function checkPatchKeys(patch: Patch, allowed: (key: string) => boolean): void {
  if (typeof patch !== 'object' || patch === null) fail('patch must be an object');
  for (const key of Object.keys(patch)) if (!allowed(key)) fail(`field cannot be patched: ${key}`);
}

function checkSubtreeShape(doc: Doc, nodes: MapNode[], rootId: Id): void {
  if (nodes.length === 0) fail('insertSubtree: no nodes');
  const byId = new Map<Id, MapNode>();
  for (const n of nodes) {
    if (typeof n.id !== 'string' || !n.id) fail('insertSubtree: node without id');
    if (byId.has(n.id)) fail(`insertSubtree: duplicate id ${n.id}`);
    if (kindOfId(doc, n.id)) fail(`insertSubtree: id already used: ${n.id}`);
    if (typeof n.text !== 'string') fail(`insertSubtree: node ${n.id} has no text`);
    if (!Array.isArray(n.children)) fail(`insertSubtree: node ${n.id} has no children array`);
    for (const defId of Object.keys(n.attrs ?? {})) {
      if (!Object.hasOwn(doc.attrDefs, defId)) fail(`insertSubtree: unknown attribute ${defId}`);
    }
    byId.set(n.id, n);
  }
  if (!byId.has(rootId)) fail('insertSubtree: rootId is not among nodes');
  let reached = 0;
  const stack = [rootId];
  while (stack.length) {
    const node = byId.get(stack.pop()!)!;
    reached++;
    for (const childId of node.children) {
      const child = byId.get(childId) ?? fail(`insertSubtree: missing child ${childId}`);
      if (child.parentId !== node.id) fail(`insertSubtree: wrong parentId on ${childId}`);
      if (childId === rootId) fail('insertSubtree: root listed as a child');
      stack.push(childId);
    }
    if (reached > nodes.length) fail('insertSubtree: nodes do not form a tree');
  }
  if (reached !== nodes.length) fail('insertSubtree: nodes do not form a single tree');
}

/** Mutates the document and returns the operations that revert the change. */
export function applyOp(doc: Doc, op: Op): Op[] {
  switch (op.t) {
    case 'insertSubtree': {
      checkSubtreeShape(doc, op.nodes, op.rootId);
      const list = siblingList(doc, op.parentId, op.sheetId);
      const index = checkIndex(op.index, list.length);
      const incoming = new Set(op.nodes.map((n) => n.id));
      const relIds = new Set<Id>();
      for (const r of op.relations ?? []) {
        if (kindOfId(doc, r.id) || incoming.has(r.id) || relIds.has(r.id)) fail(`id already used: ${r.id}`);
        for (const end of [r.from, r.to]) {
          if (!incoming.has(end) && !getNode(doc, end)) fail(`relation end not found: ${end}`);
        }
        relIds.add(r.id);
      }
      for (const n of op.nodes) doc.nodes[n.id] = structuredClone(n);
      doc.nodes[op.rootId]!.parentId = op.parentId;
      list.splice(index, 0, op.rootId);
      for (const r of op.relations ?? []) doc.relations[r.id] = structuredClone(r);
      return [{ t: 'removeSubtree', id: op.rootId }];
    }

    case 'removeSubtree': {
      const node = requireNode(doc, op.id);
      const sheet = node.parentId === null ? sheetOf(doc, node.id) : undefined;
      const list = node.parentId !== null ? requireNode(doc, node.parentId).children : sheet!.rootIds;
      const index = list.indexOf(node.id);
      const ids = subtreeIds(doc, op.id);
      const idSet = new Set(ids);
      const relations = Object.values(doc.relations).filter((r) => idSet.has(r.from) || idSet.has(r.to));
      const inverse: Op = {
        t: 'insertSubtree',
        nodes: ids.map((id) => doc.nodes[id]!),
        rootId: op.id,
        parentId: node.parentId,
        index,
        relations,
      };
      if (sheet) inverse.sheetId = sheet.id;
      list.splice(index, 1);
      for (const id of ids) delete doc.nodes[id];
      for (const r of relations) delete doc.relations[r.id];
      return [inverse];
    }

    case 'moveNode': {
      const node = requireNode(doc, op.id);
      if (op.parentId !== null && isAncestorOrSelf(doc, op.id, op.parentId)) {
        fail('moveNode: cannot move a node into its own subtree');
      }
      const oldSheet = node.parentId === null ? sheetOf(doc, node.id) : undefined;
      const oldList = node.parentId !== null ? requireNode(doc, node.parentId).children : oldSheet!.rootIds;
      const oldIndex = oldList.indexOf(node.id);
      const newList = siblingList(doc, op.parentId, op.sheetId);
      const index = checkIndex(op.index, newList.length - (newList === oldList ? 1 : 0));
      const inverse: Op = { t: 'moveNode', id: op.id, parentId: node.parentId, index: oldIndex };
      if (oldSheet) inverse.sheetId = oldSheet.id;
      oldList.splice(oldIndex, 1);
      newList.splice(index, 0, op.id);
      node.parentId = op.parentId;
      return [inverse];
    }

    case 'patchNode': {
      const node = requireNode(doc, op.id);
      checkPatchKeys(op.patch, (k) => !NODE_STRUCTURAL_KEYS.has(k));
      if ('text' in op.patch && typeof op.patch.text !== 'string') fail('patchNode: text must be a string');
      return [{ t: 'patchNode', id: op.id, patch: patchObject(node, op.patch) }];
    }

    case 'setAttr': {
      const node = requireNode(doc, op.id);
      if (op.value !== null && !Object.hasOwn(doc.attrDefs, op.defId)) fail(`attribute not defined: ${op.defId}`);
      const old = node.attrs?.[op.defId];
      if (op.value === null) {
        if (node.attrs) {
          delete node.attrs[op.defId];
          if (Object.keys(node.attrs).length === 0) delete node.attrs;
        }
      } else {
        (node.attrs ??= {})[op.defId] = structuredClone(op.value);
      }
      return [{ t: 'setAttr', id: op.id, defId: op.defId, value: old === undefined ? null : old }];
    }

    case 'putAttrDef': {
      const kind = kindOfId(doc, op.def.id);
      if (kind && kind !== 'attrDef') fail(`id already used: ${op.def.id}`);
      const old = doc.attrDefs[op.def.id];
      doc.attrDefs[op.def.id] = structuredClone(op.def);
      return [old && kind ? { t: 'putAttrDef', def: old } : { t: 'removeAttrDef', id: op.def.id }];
    }

    case 'removeAttrDef': {
      const def = Object.hasOwn(doc.attrDefs, op.id) ? doc.attrDefs[op.id]! : fail(`attribute not defined: ${op.id}`);
      const inverse: Op[] = [{ t: 'putAttrDef', def }];
      for (const node of Object.values(doc.nodes)) {
        const value = node.attrs?.[op.id];
        if (value === undefined) continue;
        inverse.push({ t: 'setAttr', id: node.id, defId: op.id, value });
        delete node.attrs![op.id];
        if (Object.keys(node.attrs!).length === 0) delete node.attrs;
      }
      delete doc.attrDefs[op.id];
      return inverse;
    }

    case 'insertSheet': {
      if (kindOfId(doc, op.sheet.id)) fail(`id already used: ${op.sheet.id}`);
      if (!Array.isArray(op.sheet.rootIds) || op.sheet.rootIds.length) fail('insertSheet: sheet must be empty');
      const index = checkIndex(op.index, doc.sheets.length);
      doc.sheets.splice(index, 0, structuredClone(op.sheet));
      return [{ t: 'removeSheet', id: op.sheet.id }];
    }

    case 'removeSheet': {
      const sheet = requireSheet(doc, op.id);
      if (sheet.rootIds.length) fail('removeSheet: sheet is not empty');
      const index = doc.sheets.indexOf(sheet);
      doc.sheets.splice(index, 1);
      return [{ t: 'insertSheet', sheet, index }];
    }

    case 'patchSheet': {
      const sheet = requireSheet(doc, op.id);
      checkPatchKeys(op.patch, (k) => SHEET_PATCH_KEYS.has(k));
      return [{ t: 'patchSheet', id: op.id, patch: patchObject(sheet, op.patch) }];
    }

    case 'putRelation': {
      const r = op.relation;
      const kind = kindOfId(doc, r.id);
      if (kind && kind !== 'relation') fail(`id already used: ${r.id}`);
      requireNode(doc, r.from);
      requireNode(doc, r.to);
      const old = kind ? doc.relations[r.id] : undefined;
      doc.relations[r.id] = structuredClone(r);
      return [old ? { t: 'putRelation', relation: old } : { t: 'removeRelation', id: r.id }];
    }

    case 'removeRelation': {
      const old = Object.hasOwn(doc.relations, op.id) ? doc.relations[op.id]! : fail(`relation not found: ${op.id}`);
      delete doc.relations[op.id];
      return [{ t: 'putRelation', relation: old }];
    }

    case 'patchDoc': {
      checkPatchKeys(op.patch, (k) => DOC_PATCH_KEYS.has(k));
      return [{ t: 'patchDoc', patch: patchObject(doc, op.patch) }];
    }

    default:
      return fail(`unknown operation: ${(op as { t?: unknown }).t}`);
  }
}

/**
 * Applies operations as one atomic unit. Returns the operations that revert
 * the whole unit, in the order they must be applied. If any operation fails,
 * everything already applied is rolled back and the error is rethrown.
 */
export function applyOps(doc: Doc, ops: Op[]): Op[] {
  const inverse: Op[] = [];
  try {
    for (const op of ops) inverse.unshift(...applyOp(doc, op));
  } catch (error) {
    for (const op of inverse) applyOp(doc, op);
    throw error;
  }
  return inverse;
}
