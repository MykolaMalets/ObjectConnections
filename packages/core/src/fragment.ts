// Self-contained pieces of a map: clipboard, moving a branch between files, splitting a file.

import { newId } from './ids.ts';
import type { AttrDef, Doc, Id, MapNode, Relation } from './model.ts';
import { getNode, subtreeIds } from './model.ts';
import type { Op } from './ops.ts';
import { OpError } from './ops.ts';

export interface Fragment {
  format: 'ocmap-fragment';
  version: 1;
  rootId: Id;
  /** Nodes in pre-order; the root has parentId null. */
  nodes: MapNode[];
  /** Relations with both ends inside the fragment. */
  relations: Relation[];
  /** Definitions of every attribute used by the nodes. */
  attrDefs: AttrDef[];
}

export function extractFragment(doc: Doc, nodeId: Id): Fragment {
  if (!getNode(doc, nodeId)) throw new OpError(`node not found: ${nodeId}`);
  const ids = subtreeIds(doc, nodeId);
  const idSet = new Set(ids);
  const nodes = ids.map((id) => structuredClone(doc.nodes[id]!));
  nodes[0]!.parentId = null;
  const defIds = new Set(nodes.flatMap((n) => Object.keys(n.attrs ?? {})));
  return {
    format: 'ocmap-fragment',
    version: 1,
    rootId: nodeId,
    nodes,
    relations: Object.values(doc.relations)
      .filter((r) => idSet.has(r.from) && idSet.has(r.to))
      .map((r) => structuredClone(r)),
    attrDefs: [...defIds].map((id) => structuredClone(doc.attrDefs[id]!)),
  };
}

export interface ImportTarget {
  parentId: Id | null;
  sheetId?: Id;
  index?: number;
}

/**
 * Builds operations that insert the fragment with fresh ids. An attribute
 * definition whose id already exists in the document is treated as the same
 * attribute and left as is.
 */
export function opsImportFragment(
  doc: Doc,
  fragment: Fragment,
  target: ImportTarget,
  makeId: () => Id = newId,
): { ops: Op[]; rootId: Id } {
  const map = new Map<Id, Id>();
  for (const n of fragment.nodes) map.set(n.id, makeId());
  const remap = (id: Id) => map.get(id) ?? id;

  const nodes = fragment.nodes.map((source) => {
    const node = structuredClone(source);
    node.id = remap(node.id);
    node.parentId = node.parentId === null ? null : remap(node.parentId);
    node.children = node.children.map(remap);
    if (node.link?.type === 'node' && !node.link.docId) node.link.nodeId = remap(node.link.nodeId);
    return node;
  });
  const relations = fragment.relations.map((r) => ({
    ...structuredClone(r),
    id: makeId(),
    from: remap(r.from),
    to: remap(r.to),
  }));

  const ops: Op[] = [];
  for (const def of fragment.attrDefs) {
    if (!Object.hasOwn(doc.attrDefs, def.id)) ops.push({ t: 'putAttrDef', def });
  }
  const rootId = remap(fragment.rootId);
  const insert: Op = { t: 'insertSubtree', nodes, rootId, parentId: target.parentId, relations };
  if (target.sheetId !== undefined) insert.sheetId = target.sheetId;
  if (target.index !== undefined) insert.index = target.index;
  ops.push(insert);
  return { ops, rootId };
}
