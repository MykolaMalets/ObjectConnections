// Layout: pure function from a document to positioned boxes. No DOM here;
// text measurement is injected so the same code runs in tests and exports.

import type { Doc, Id } from '@oc/core';
import { getNode } from '@oc/core';
import { attrText } from '../state/search.ts';
import { markerGlyphs } from './markers.ts';

export interface TextSize {
  w: number;
  h: number;
  lines: string[];
  /** Attribute lines under the text, already shortened to fit; their height is part of `h`. */
  attrs?: string[];
}

/** Measures a topic: its text in the style of its depth, plus optional attribute lines in a small font. */
export type Measure = (text: string, depth: number, attrs?: string[]) => TextSize;

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
  /** How the structure grows: sideways (map), down (org chart) or as an indented list (tree). */
  flow: Flow;
  lines: string[];
  /** Lines drawn under the text in a small font: labels, then attributes. */
  attrs: string[];
  /** Fill chosen by the user (`style.color`), replacing the level's look. */
  color?: string;
  childCount: number;
  collapsed: boolean;
}

export interface LayoutResult {
  boxes: NodeBox[];
  byId: Map<Id, NodeBox>;
}

/** Structure ids understood by layoutRoots. Unknown values fall back to 'map'. */
export type Structure = 'map' | 'logic-right' | 'org-chart' | 'tree';

export type Flow = 'map' | 'org' | 'tree';

/** Structures offered in the editor, in menu order. */
export const STRUCTURES: { id: Structure; title: string }[] = [
  { id: 'map', title: 'Карта (в обе стороны)' },
  { id: 'logic-right', title: 'Логическая схема (вправо)' },
  { id: 'org-chart', title: 'Оргсхема (вниз)' },
  { id: 'tree', title: 'Дерево (список с отступами)' },
];

export const flowOf = (structure: string | undefined): Flow =>
  structure === 'org-chart' ? 'org' : structure === 'tree' ? 'tree' : 'map';

/** Org chart: space between neighbours in a row and between rows. */
export const ORG_GAP_X = 16;
export const ORG_GAP_Y = 36;
/** Tree: indent of each level and space between rows. */
export const TREE_INDENT = 28;
export const TREE_GAP = 8;

export const H_GAP = 44;
export const V_GAP = 10;
const ROOT_GAP = 70;

interface Sized {
  size: TextSize;
  /** Height of the node together with its visible subtree. */
  block: number;
  children: Id[];
}

const PROMPT_ICONS = { draft: '💬', queued: '⏳', running: '🤖', done: '✅', error: '⚠️' } as const;

/** Icons for what a node carries, in a fixed order. Shown after the text, so layout reserves room for them. */
export function nodeIcons(doc: Doc, id: Id): string[] {
  const node = doc.nodes[id]!;
  const icons: string[] = [];
  if (node.link?.type === 'node') icons.push('↗');
  if (node.link?.type === 'url') icons.push('🔗');
  if (node.link?.type === 'file') icons.push('📄');
  if (node.notes) icons.push('📝');
  if (node.prompt) icons.push(PROMPT_ICONS[node.prompt.status] ?? '💬');
  if (node.reminders?.length) icons.push('⏰');
  return icons;
}

/** At most this many attribute lines are shown on a topic; the rest are counted in one more line. */
export const MAX_ATTR_LINES = 5;

/** "Name: value" for each attribute the topic has, in the order the attributes were defined. */
export function attributeLines(doc: Doc, id: Id): string[] {
  const attrs = doc.nodes[id]!.attrs;
  if (!attrs) return [];
  const lines: string[] = [];
  for (const def of Object.values(doc.attrDefs)) {
    const value = attrs[def.id];
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') continue;
    lines.push(`${def.name}: ${attrText(value)}`);
  }
  if (lines.length > MAX_ATTR_LINES) {
    const rest = lines.length - (MAX_ATTR_LINES - 1);
    return [...lines.slice(0, MAX_ATTR_LINES - 1), `ещё ${rest}…`];
  }
  return lines;
}

/** Text shown for a node: its title followed by its icons. */
export function displayText(doc: Doc, id: Id): string {
  const node = doc.nodes[id]!;
  const icons = nodeIcons(doc, id);
  const markers = markerGlyphs(node);
  const text = markers.length ? `${markers.join('')} ${node.text}` : node.text;
  return icons.length ? `${text} ${icons.join(' ')}` : text;
}

/** Labels as one line of #tags, or nothing. */
export function labelLine(doc: Doc, id: Id): string[] {
  const labels = doc.nodes[id]!.labels;
  return labels?.length ? [labels.map((label) => `#${label}`).join(' ')] : [];
}

/** A user colour from `style.color`, when it is a valid #rrggbb value. */
export function topicColor(doc: Doc, id: Id): string | undefined {
  const color = doc.nodes[id]!.style?.color;
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
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
    const attrs = [...labelLine(doc, id), ...attributeLines(doc, id)];
    const size = measure(displayText(doc, id), depth, attrs.length ? attrs : undefined);
    let block = 0;
    for (const child of children) block += measureTree(child, depth + 1);
    block = Math.max(size.h, block + V_GAP * Math.max(0, children.length - 1));
    sized.set(id, { size, block, children });
    return block;
  };

  const blockOf = (ids: Id[]) =>
    ids.reduce((sum, id) => sum + sized.get(id)!.block, 0) + V_GAP * Math.max(0, ids.length - 1);

  const flow = flowOf(structure);
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
      flow,
      lines: size.lines,
      attrs: size.attrs ?? [],
      childCount: node.children.length,
      collapsed: !!node.collapsed && depth > 0 && node.children.length > 0,
    };
    const color = topicColor(doc, id);
    if (color) box.color = color;
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

  /** Org chart: width of a node together with its visible subtree. */
  const widths = new Map<Id, number>();
  const orgWidth = (id: Id): number => {
    const s = sized.get(id)!;
    const below = s.children.reduce((sum, c) => sum + orgWidth(c), 0) + ORG_GAP_X * Math.max(0, s.children.length - 1);
    const width = Math.max(s.size.w, below);
    widths.set(id, width);
    return width;
  };

  /** Org chart: the node centred at `cx` with its top at `top`, children in a row below. */
  const placeOrg = (id: Id, parentId: Id | null, cx: number, top: number, depth: number): void => {
    if (depth === 0) orgWidth(id);
    const s = sized.get(id)!;
    const box = emit(id, parentId, cx - s.size.w / 2, top, depth, 1);
    let left = cx - (s.children.reduce((sum, c) => sum + widths.get(c)!, 0) + ORG_GAP_X * Math.max(0, s.children.length - 1)) / 2;
    for (const child of s.children) {
      const w = widths.get(child)!;
      placeOrg(child, id, left + w / 2, box.y + box.h + ORG_GAP_Y, depth + 1);
      left += w + ORG_GAP_X;
    }
  };

  /** Tree: rows from top to bottom, each level indented. Returns the bottom of the subtree. */
  const placeTree = (id: Id, parentId: Id | null, x: number, top: number, depth: number): number => {
    const s = sized.get(id)!;
    const box = emit(id, parentId, x, top, depth, 1);
    let bottom = box.y + box.h;
    for (const child of s.children) bottom = placeTree(child, id, x + TREE_INDENT, bottom + TREE_GAP, depth + 1);
    return bottom;
  };

  let nextTop = 0;
  rootIds.forEach((rootId, rootIndex) => {
    const node = getNode(doc, rootId);
    if (!node) return;
    measureTree(rootId, 0);
    const s = sized.get(rootId)!;
    const position = ignorePositions ? undefined : node.position;
    if (flow !== 'map') {
      const first = boxes.length;
      const cx = position?.x ?? 0;
      const top = position ? position.y - s.size.h / 2 : rootIndex === 0 ? -s.size.h / 2 : nextTop;
      if (flow === 'org') placeOrg(rootId, null, cx, top, 0);
      else placeTree(rootId, null, cx - s.size.w / 2, top, 0);
      let bottom = -Infinity;
      for (let i = first; i < boxes.length; i++) bottom = Math.max(bottom, boxes[i]!.y + boxes[i]!.h);
      nextTop = Math.max(nextTop, bottom + ROOT_GAP);
      return;
    }
    const twoSided = structure !== 'logic-right' && s.children.length > 1;
    const split = twoSided ? Math.ceil(s.children.length / 2) : s.children.length;
    const right = s.children.slice(0, split);
    const left = s.children.slice(split);
    const height = Math.max(s.size.h, blockOf(right), blockOf(left));

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

/** Where a dragged topic would land: as a child of the target, or as its sibling just before or after it. */
export interface Drop {
  targetId: Id;
  place: 'child' | 'before' | 'after';
}

/** The upper and lower parts of a box (this share of its height) drop next to it; the middle drops into it. */
const SIBLING_ZONE = 0.3;

/**
 * Drop under the point for a topic being dragged, or null where the drop would
 * be impossible (into its own branch) or change nothing.
 */
export function dropAt(doc: Doc, layout: LayoutResult, draggedId: Id, x: number, y: number): Drop | null {
  const box = hitTest(layout, x, y);
  if (!box || isInBranch(doc, draggedId, box.id)) return null;
  const dragged = doc.nodes[draggedId];
  const target = doc.nodes[box.id];
  if (!dragged || !target) return null;
  // In an org chart neighbours stand side by side, so the left and right parts drop next to a topic.
  const rel = box.flow === 'org' ? (x - box.x) / box.w : (y - box.y) / box.h;
  // A root of the view has no siblings to stand between.
  const place: Drop['place'] =
    box.parentId === null || target.parentId === null ? 'child' : rel < SIBLING_ZONE ? 'before' : rel > 1 - SIBLING_ZONE ? 'after' : 'child';
  if (place === 'child') return dragged.parentId === box.id ? null : { targetId: box.id, place };
  const siblings = doc.nodes[target.parentId!]!.children;
  if (dragged.parentId === target.parentId) {
    const from = siblings.indexOf(draggedId);
    const at = siblings.indexOf(box.id);
    if ((place === 'before' && at === from + 1) || (place === 'after' && at === from - 1)) return null;
  }
  return { targetId: box.id, place };
}

/** Parent and index (as `moveNode` expects them) for a drop. */
export function dropDestination(doc: Doc, draggedId: Id, drop: Drop): { parentId: Id; index?: number } {
  if (drop.place === 'child') return { parentId: drop.targetId };
  const parentId = doc.nodes[drop.targetId]!.parentId!;
  const siblings = doc.nodes[parentId]!.children.filter((id) => id !== draggedId);
  return { parentId, index: siblings.indexOf(drop.targetId) + (drop.place === 'after' ? 1 : 0) };
}

function isInBranch(doc: Doc, branchId: Id, id: Id): boolean {
  for (let cur: Id | null = id; cur !== null; cur = doc.nodes[cur]?.parentId ?? null) if (cur === branchId) return true;
  return false;
}

/** Line from a parent to a child: a curve (map, org chart) or right-angled segments (tree). */
export type Connector =
  | { kind: 'curve'; x1: number; y1: number; c1x: number; c1y: number; c2x: number; c2y: number; x2: number; y2: number }
  | { kind: 'lines'; points: [number, number][] };

export function connector(parent: NodeBox, box: NodeBox): Connector {
  if (box.flow === 'org') {
    const x1 = parent.x + parent.w / 2;
    const y1 = parent.y + parent.h;
    const x2 = box.x + box.w / 2;
    const y2 = box.y;
    const mid = (y1 + y2) / 2;
    return { kind: 'curve', x1, y1, c1x: x1, c1y: mid, c2x: x2, c2y: mid, x2, y2 };
  }
  if (box.flow === 'tree') {
    const x = parent.x + TREE_INDENT / 2;
    const y = box.y + box.h / 2;
    return { kind: 'lines', points: [[x, parent.y + parent.h], [x, y], [box.x, y]] };
  }
  const x1 = box.dir > 0 ? parent.x + parent.w : parent.x;
  const y1 = parent.y + parent.h / 2;
  const x2 = box.dir > 0 ? box.x : box.x + box.w;
  const y2 = box.y + box.h / 2;
  const mid = (x1 + x2) / 2;
  return { kind: 'curve', x1, y1, c1x: mid, c1y: y1, c2x: mid, c2y: y2, x2, y2 };
}

export const TOGGLE_RADIUS = 7;

/** Centre of the collapse toggle of a box, or undefined when it has none. */
export function togglePoint(box: NodeBox): { x: number; y: number } | undefined {
  if (box.depth === 0 || box.childCount === 0) return undefined;
  const offset = TOGGLE_RADIUS + 3;
  if (box.flow === 'org') return { x: box.x + box.w / 2, y: box.y + box.h + offset };
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
  const visibleChildren = () => doc.nodes[from]!.children.filter((id) => layout.byId.has(id));
  if (box.flow === 'tree') {
    // Up and down follow the rows; left goes to the parent, right into the branch.
    const index = layout.boxes.indexOf(box);
    if (direction === 'up') return layout.boxes[index - 1]?.id;
    if (direction === 'down') return layout.boxes[index + 1]?.id;
    if (direction === 'left') return box.parentId ?? undefined;
    return visibleChildren()[0];
  }
  if (box.flow === 'org') {
    if (direction === 'up') return box.parentId ?? undefined;
    if (direction === 'down') {
      const children = visibleChildren();
      return children[Math.floor((children.length - 1) / 2)];
    }
    // Left and right: the nearest topic in the same row.
    const sign = direction === 'right' ? 1 : -1;
    let best: NodeBox | undefined;
    for (const other of layout.boxes) {
      if (other.depth !== box.depth || other.id === from) continue;
      const dx = (other.x - box.x) * sign;
      if (dx > 0 && (!best || dx < (best.x - box.x) * sign)) best = other;
    }
    return best?.id;
  }
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

export interface RelationCurve {
  /** Cubic Bézier: start, two control points, end. */
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
  /** Point on the curve halfway along it, for the label. */
  mx: number;
  my: number;
}

/** Point where the ray from the box centre towards (tx, ty) leaves the box. */
function borderPoint(b: NodeBox, tx: number, ty: number): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: b.y };
  const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/**
 * Curve of a relation between two boxes: from border to border, bent to one
 * side so it does not run along the tree's own connectors. A relation of a
 * box to itself is drawn as a loop above it.
 */
/** The bend the user gave a relation (`style.bend`, map pixels across the line), or undefined for the default. */
export function relationBend(relation: { style?: Record<string, unknown> }): number | undefined {
  const bend = relation.style?.bend;
  return typeof bend === 'number' && Number.isFinite(bend) ? bend : undefined;
}

/**
 * Curve of a relation. `bend` moves both control points across the straight
 * line by that many pixels; without it the bend grows with the distance.
 */
export function relationCurve(from: NodeBox, to: NodeBox, bend?: number): RelationCurve {
  if (from === to) {
    const x1 = from.x + from.w * 0.3;
    const x2 = from.x + from.w * 0.7;
    const y = from.y;
    const lift = Math.max(40, from.h);
    return { x1, y1: y, c1x: x1 - 20, c1y: y - lift, c2x: x2 + 20, c2y: y - lift, x2, y2: y, mx: (x1 + x2) / 2, my: y - lift * 0.75 };
  }
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const p0 = borderPoint(from, tc.x, tc.y);
  const p3 = borderPoint(to, fc.x, fc.y);
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const length = Math.hypot(dx, dy) || 1;
  // Unit normal; the default bend is proportional to the distance, within limits.
  const offset = bend ?? Math.min(90, Math.max(24, length * 0.25));
  const nx = (-dy / length) * offset;
  const ny = (dx / length) * offset;
  const c1x = p0.x + dx / 3 + nx;
  const c1y = p0.y + dy / 3 + ny;
  const c2x = p0.x + (dx * 2) / 3 + nx;
  const c2y = p0.y + (dy * 2) / 3 + ny;
  return {
    x1: p0.x,
    y1: p0.y,
    c1x,
    c1y,
    c2x,
    c2y,
    x2: p3.x,
    y2: p3.y,
    mx: 0.125 * p0.x + 0.375 * c1x + 0.375 * c2x + 0.125 * p3.x,
    my: 0.125 * p0.y + 0.375 * c1y + 0.375 * c2y + 0.125 * p3.y,
  };
}

/**
 * The bend that puts the middle of the curve at (x, y): the middle of a cubic
 * lies three quarters of the control points' offset away from the straight line.
 */
export function bendThrough(from: NodeBox, to: NodeBox, x: number, y: number): number {
  const straight = relationCurve(from, to, 0);
  const dx = straight.x2 - straight.x1;
  const dy = straight.y2 - straight.y1;
  const length = Math.hypot(dx, dy) || 1;
  const across = ((x - straight.x1) * -dy + (y - straight.y1) * dx) / length;
  return Math.round(across / 0.75);
}

/** Point of a cubic Bézier at t. */
function cubicAt(c: RelationCurve, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * c.x1 + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x2,
    u * u * u * c.y1 + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y2,
  ];
}

/** Relation whose line (or label) passes within `tolerance` of the point, nearest first. */
export function hitRelation(
  layout: LayoutResult,
  relations: { id: Id; from: Id; to: Id; style?: Record<string, unknown> }[],
  x: number,
  y: number,
  tolerance: number,
): Id | undefined {
  let best: Id | undefined;
  let bestDistance = tolerance;
  for (const relation of relations) {
    const from = layout.byId.get(relation.from);
    const to = layout.byId.get(relation.to);
    if (!from || !to) continue;
    const c = relationCurve(from, to, from === to ? undefined : relationBend(relation));
    let [px, py] = [c.x1, c.y1];
    for (let i = 1; i <= 24; i++) {
      const [qx, qy] = cubicAt(c, i / 24);
      // Distance from the point to the segment p–q.
      const sx = qx - px;
      const sy = qy - py;
      const t = Math.max(0, Math.min(1, ((x - px) * sx + (y - py) * sy) / (sx * sx + sy * sy || 1)));
      const d = Math.hypot(x - (px + sx * t), y - (py + sy * t));
      if (d < bestDistance) {
        bestDistance = d;
        best = relation.id;
      }
      [px, py] = [qx, qy];
    }
  }
  return best;
}

/** The two other corners of an arrowhead pointing at (x2, y2) from the direction of (fromX, fromY). */
export function arrowHead(fromX: number, fromY: number, x2: number, y2: number, size = 9): [number, number, number, number] {
  const angle = Math.atan2(y2 - fromY, x2 - fromX);
  const spread = 0.45;
  return [
    x2 - size * Math.cos(angle - spread),
    y2 - size * Math.sin(angle - spread),
    x2 - size * Math.cos(angle + spread),
    y2 - size * Math.sin(angle + spread),
  ];
}
