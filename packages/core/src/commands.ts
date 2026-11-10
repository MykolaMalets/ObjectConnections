// Composite actions. Each builds the operations for one History.apply call
// from the current document; nothing here mutates the document.

import { newId } from './ids.ts';
import type { Doc, Id } from './model.ts';
import { createNode, getNode, getSheet, sheetOf } from './model.ts';
import type { Op } from './ops.ts';
import { OpError } from './ops.ts';

export interface ExtractOptions {
  /** Leave a node at the old place that links to the extracted branch. */
  leaveLink?: boolean;
  makeId?: () => Id;
}

/** Moves a branch to a new sheet placed right after its current sheet. */
export function opsExtractToSheet(
  doc: Doc,
  nodeId: Id,
  options: ExtractOptions = {},
): { ops: Op[]; sheetId: Id } {
  const node = getNode(doc, nodeId) ?? raise(`node not found: ${nodeId}`);
  const makeId = options.makeId ?? newId;
  const current = sheetOf(doc, nodeId)!;
  const sheetId = makeId();
  const ops: Op[] = [
    {
      t: 'insertSheet',
      sheet: { id: sheetId, title: node.text || 'Sheet', rootIds: [] },
      index: doc.sheets.indexOf(current) + 1,
    },
    { t: 'moveNode', id: nodeId, parentId: null, sheetId },
  ];
  if (options.leaveLink && node.parentId !== null) {
    const stub = createNode(node.text, makeId());
    stub.link = { type: 'node', nodeId };
    ops.push({
      t: 'insertSubtree',
      nodes: [stub],
      rootId: stub.id,
      parentId: node.parentId,
      index: getNode(doc, node.parentId)!.children.indexOf(nodeId),
    });
  }
  return { ops, sheetId };
}

/** Turns every map of a sheet into a branch of the target node and removes the sheet. */
export function opsMergeSheetInto(doc: Doc, sheetId: Id, targetNodeId: Id): Op[] {
  const sheet = getSheet(doc, sheetId) ?? raise(`sheet not found: ${sheetId}`);
  if (!getNode(doc, targetNodeId)) raise(`node not found: ${targetNodeId}`);
  if (sheetOf(doc, targetNodeId) === sheet) raise('target node is on the sheet being merged');
  const ops: Op[] = [];
  for (const rootId of sheet.rootIds) {
    ops.push({ t: 'moveNode', id: rootId, parentId: targetNodeId });
    if (doc.nodes[rootId]!.position) ops.push({ t: 'patchNode', id: rootId, patch: { position: null } });
  }
  ops.push({ t: 'removeSheet', id: sheetId });
  return ops;
}

function raise(message: string): never {
  throw new OpError(message);
}
