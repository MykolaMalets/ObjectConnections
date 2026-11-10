// Layout: pure function from a document to positioned boxes. No DOM here;
// text measurement is injected so the same code runs in tests and exports.

import type { Doc, Id } from '@oc/core';
import { getNode } from '@oc/core';

export interface TextSize {
  w: number;
  h: number;
  lines: string[];
}

export type Measure = (text: string, depth: number) => TextSize;

export interface NodeBox {
  id: Id;
  parentId: Id | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 for the root of the view. */
  depth: number;
  /** Side of the root the branch grows to: 1 right, -1 left. */
  dir: 1 | -1;
  lines: string[];
  childCount: number;
  collapsed: boolean;
}

export interface LayoutResult {
  boxes: NodeBox[];
  byId: Map<Id, NodeBox>;
}

/** Structure ids understood by layoutRoots. Unknown values fall back to 'map'. */
export type Structure = 'map' | 'logic-right';

export const H_GAP = 44;
export const V_GAP = 10;
const ROOT_GAP = 70;

interface Sized {
  size: TextSize;
  /** Height of the node together with its visible subtree. */
  block: number;
  children: Id[];
}

/** Text shown for a node; nodes that link to another node get a marker. */
export function displayText(doc: Doc, id: Id): string {
  const node = doc.nodes[id]!;
  return node.link?.type === 'node' ? `${node.text} ↗` : node.text;
}

/**
 * Lays out the given roots. The first root is centred at its `position` (or
 * the origin); roots without a position are stacked below the previous one.
 * `ignorePositions` is used by drill-down, where the focused node is shown alone.
 */
export function layoutRoots(
  doc: Doc,
  rootIds: Id[],
  structure: string | undefined,
  measure: Measure,
  ignorePositions = false,
): LayoutResult {
  const boxes: NodeBox[] = [];
  const byId = new Map<Id, NodeBox>();
  const sized = new Map<Id, Sized>();

  const measureTree = (id: Id, depth: number): number => {
    const node = doc.nodes[id]!;
    const children = node.collapsed && depth > 0 ? [] : node.children;
    const size = measure(displayText(doc, id), depth);
    let block = 0;
    for (const child of children) block += measureTree(child, depth + 1);
    block = Math.max(size.h, block + V_GAP * Math.max(0, children.length - 1));
    sized.set(id, { size, block, children });
    return block;
  };

  const blockOf = (ids: Id[]) =>
    ids.reduce((sum, id) => sum + sized.get(id)!.block, 0) + V_GAP * Math.max(0, ids.length - 1);

  const emit = (id: Id, parentId: Id | null, x: number, y: number, depth: number, dir: 1 | -1): NodeBox => {
    const node = doc.nodes[id]!;
    const { size } = sized.get(id)!;
    const box: NodeBox = {
      id,
      parentId,
      x,
      y,
      w: size.w,
      h: size.h,
      depth,
      dir,
      lines: size.lines,
      childCount: node.children.length,
      collapsed: !!node.collapsed && depth > 0 && node.children.length > 0,
    };
    boxes.push(box);
    byId.set(id, box);
    return box;
  };

  /** Places children in a column next to `parent`, centred on its middle. */
  const placeChildren = (parent: NodeBox, children: Id[], dir: 1 | -1): void => {
    let top = parent.y + parent.h / 2 - blockOf(children) / 2;
    const edge = dir > 0 ? parent.x + parent.w + H_GAP : parent.x - H_GAP;
    for (const id of children) {
      const s = sized.get(id)!;
      const x = dir > 0 ? edge : edge - s.size.w;
      const box = emit(id, parent.id, x, top + (s.block - s.size.h) / 2, parent.depth + 1, dir);
      placeChildren(box, s.children, dir);
      top += s.block + V_GAP;
    }
  };

  let nextTop = 0;
  rootIds.forEach((rootId, rootIndex) => {
    const node = getNode(doc, rootId);
    if (!node) return;
    measureTree(rootId, 0);
    const s = sized.get(rootId)!;
    const twoSided = structure !== 'logic-right' && s.children.length > 1;
    const split = twoSided ? Math.ceil(s.children.length / 2) : s.children.length;
    const right = s.children.slice(0, split);
    const left = s.children.slice(split);
    const height = Math.max(s.size.h, blockOf(right), blockOf(left));

    const position = ignorePositions ? undefined : node.position;
    const cx = position?.x ?? 0;
    const cy = position?.y ?? (rootIndex === 0 ? 0 : nextTop + height / 2);
    const first = boxes.length;
    const root = emit(rootId, null, cx - s.size.w / 2, cy - s.size.h / 2, 0, 1);
    placeChildren(root, right, 1);
    placeChildren(root, left, -1);

    let bottom = -Infinity;
    for (let i = first; i < boxes.length; i++) bottom = Math.max(bottom, boxes[i]!.y + boxes[i]!.h);
    nextTop = Math.max(nextTop, bottom + ROOT_GAP);
  });

  return { boxes, byId };
}

/** Topmost box containing the point, or undefined. */
export function hitTest(layout: LayoutResult, x: number, y: number): NodeBox | undefined {
  for (let i = layout.boxes.length - 1; i >= 0; i--) {
    const b = layout.boxes[i]!;
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
  }
  return undefined;
}

export const TOGGLE_RADIUS = 7;

/** Centre of the collapse toggle of a box, or undefined when it has none. */
export function togglePoint(box: NodeBox): { x: number; y: number } | undefined {
  if (box.depth === 0 || box.childCount === 0) return undefined;
  const offset = TOGGLE_RADIUS + 3;
  return { x: box.dir > 0 ? box.x + box.w + offset : box.x - offset, y: box.y + box.h / 2 };
}

export function hitToggle(layout: LayoutResult, x: number, y: number): NodeBox | undefined {
  const r = TOGGLE_RADIUS + 2;
  for (const box of layout.boxes) {
    const p = togglePoint(box);
    if (p && Math.abs(x - p.x) <= r && Math.abs(y - p.y) <= r) return box;
  }
  return undefined;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** Keyboard navigation target from a box, following the tree horizontally and geometry vertically. */
export function neighbour(doc: Doc, layout: LayoutResult, from: Id, direction: Direction): Id | undefined {
  const box = layout.byId.get(from);
  if (!box) return undefined;
  if (direction === 'left' || direction === 'right') {
    const side = direction === 'right' ? 1 : -1;
    const children = doc.nodes[from]!.children.filter((id) => layout.byId.has(id));
    if (box.depth === 0) return children.find((id) => layout.byId.get(id)!.dir === side);
    if (box.dir === side) return children[Math.floor((children.length - 1) / 2)];
    return box.parentId ?? undefined;
  }
  const sign = direction === 'down' ? 1 : -1;
  const centre = box.y + box.h / 2;
  let best: NodeBox | undefined;
  let bestScore = Infinity;
  for (const other of layout.boxes) {
    if (other.id === from || (box.depth > 0 && other.dir !== box.dir)) continue;
    const dy = (other.y + other.h / 2 - centre) * sign;
    if (dy <= 0) continue;
    const dx = Math.abs(other.x + other.w / 2 - (box.x + box.w / 2));
    const score = dy + dx * 3 + (other.depth === box.depth ? 0 : 40);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best?.id;
}
