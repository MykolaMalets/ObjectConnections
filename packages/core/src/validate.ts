import type { Doc, Id } from './model.ts';

/** Checks the invariants listed in docs/FORMAT.md. Returns human-readable problems; empty means valid. */
export function validate(doc: Doc): string[] {
  const errors: string[] = [];
  if (doc.format !== 'ocmap') errors.push(`unexpected format: ${String(doc.format)}`);
  if (doc.version !== 1) errors.push(`unsupported version: ${String(doc.version)}`);

  const seen = new Set<Id>();
  const claim = (id: Id, what: string) => {
    if (seen.has(id)) errors.push(`duplicate id ${id} (${what})`);
    seen.add(id);
  };
  for (const s of doc.sheets) claim(s.id, 'sheet');
  for (const [key, n] of Object.entries(doc.nodes)) {
    if (key !== n.id) errors.push(`node key ${key} does not match id ${n.id}`);
    claim(n.id, 'node');
  }
  for (const [key, r] of Object.entries(doc.relations)) {
    if (key !== r.id) errors.push(`relation key ${key} does not match id ${r.id}`);
    claim(r.id, 'relation');
  }
  for (const [key, d] of Object.entries(doc.attrDefs)) {
    if (key !== d.id) errors.push(`attribute key ${key} does not match id ${d.id}`);
    claim(d.id, 'attrDef');
  }

  const has = (id: Id) => Object.hasOwn(doc.nodes, id);
  const reached = new Set<Id>();
  const rootSeen = new Set<Id>();
  for (const sheet of doc.sheets) {
    for (const rootId of sheet.rootIds) {
      if (!has(rootId)) {
        errors.push(`sheet ${sheet.id} lists missing root ${rootId}`);
        continue;
      }
      if (rootSeen.has(rootId)) errors.push(`root ${rootId} is listed more than once`);
      rootSeen.add(rootId);
      if (doc.nodes[rootId]!.parentId !== null) errors.push(`root ${rootId} has a parent`);
      const stack = [rootId];
      while (stack.length) {
        const id = stack.pop()!;
        if (reached.has(id)) {
          errors.push(`node ${id} is reachable more than once`);
          continue;
        }
        reached.add(id);
        for (const childId of doc.nodes[id]!.children) {
          if (!has(childId)) errors.push(`node ${id} lists missing child ${childId}`);
          else if (doc.nodes[childId]!.parentId !== id) errors.push(`child ${childId} has wrong parentId`);
          else stack.push(childId);
        }
      }
    }
  }

  for (const node of Object.values(doc.nodes)) {
    if (!reached.has(node.id)) errors.push(`node ${node.id} is not reachable from any sheet`);
    if (typeof node.text !== 'string') errors.push(`node ${node.id} has no text`);
    for (const defId of Object.keys(node.attrs ?? {})) {
      if (!Object.hasOwn(doc.attrDefs, defId)) errors.push(`node ${node.id} uses unknown attribute ${defId}`);
    }
  }
  for (const r of Object.values(doc.relations)) {
    if (!has(r.from)) errors.push(`relation ${r.id} starts at missing node ${r.from}`);
    if (!has(r.to)) errors.push(`relation ${r.id} ends at missing node ${r.to}`);
  }
  return errors;
}
