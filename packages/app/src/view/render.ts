// Canvas renderer. Draws only what intersects the viewport.

import type { Id } from '@oc/core';
import type { LayoutResult, NodeBox } from './layout.ts';
import { ORG_GAP_X, TOGGLE_RADIUS, V_GAP, arrowHead, connector, relationBend, relationCurve, togglePoint } from './layout.ts';
import { ATTR_STYLE, COLORS, levelStyle, topicLook } from './style.ts';

/** screen = world * scale + (x, y) */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface RenderState {
  selection: Id | null;
  dropTarget: Id | null;
  /** Other topics of a group selection, outlined like the primary one. */
  selected?: ReadonlySet<Id>;
  /** Selection frame being drawn, in map coordinates. */
  band?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Insertion line for a drop between topics: drawn above or below this box. */
  dropLine?: { id: Id; place: 'before' | 'after' } | null;
  /** Box being edited: its text is hidden under the editor overlay. */
  editing: Id | null;
  /** Topics found by a search. */
  highlights?: Set<Id> | null;
  /** Relations whose both ends are laid out. */
  relations: { id: Id; from: Id; to: Id; text?: string; style?: Record<string, unknown> }[];
  /** Relation picked by the user: drawn thicker with a handle in the middle. */
  selectedRelation?: Id | null;
  /** Bend shown while the handle is dragged, before it is saved. */
  bendPreview?: { id: Id; bend: number } | null;
}

/** Draws relations: dashed curves with an arrowhead and an optional label. */
function renderRelations(ctx: CanvasRenderingContext2D, layout: LayoutResult, view: View, state: RenderState): void {
  if (state.relations.length === 0) return;
  ctx.save();
  ctx.strokeStyle = COLORS.relation;
  ctx.fillStyle = COLORS.relation;
  ctx.lineWidth = 1.5;
  const readable = RELATION_FONT_SIZE * view.scale >= MIN_TEXT_PX;
  for (const relation of state.relations) {
    const from = layout.byId.get(relation.from);
    const to = layout.byId.get(relation.to);
    if (!from || !to) continue;
    const bend = state.bendPreview?.id === relation.id ? state.bendPreview.bend : relationBend(relation);
    const c = relationCurve(from, to, from === to ? undefined : bend);
    const picked = relation.id === state.selectedRelation;
    ctx.lineWidth = picked ? 3 : 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(c.x1, c.y1);
    ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x2, c.y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const [ax, ay, bx, by] = arrowHead(c.c2x, c.c2y, c.x2, c.y2);
    ctx.beginPath();
    ctx.moveTo(c.x2, c.y2);
    ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.closePath();
    ctx.fill();
    if (relation.text && readable) {
      ctx.font = `${RELATION_FONT_SIZE}px system-ui, "Segoe UI", sans-serif`;
      const w = ctx.measureText(relation.text).width + 10;
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(c.mx - w / 2, c.my - 9, w, 18);
      ctx.fillStyle = COLORS.relation;
      ctx.fillText(relation.text, c.mx - w / 2 + 5, c.my);
    }
    if (picked && from !== to) {
      // Handle for changing the bend, kept the same size on screen.
      ctx.beginPath();
      ctx.arc(c.mx, c.my, RELATION_HANDLE_PX / view.scale, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2 / view.scale;
      ctx.strokeStyle = COLORS.relation;
      ctx.stroke();
      ctx.fillStyle = COLORS.relation;
      ctx.strokeStyle = COLORS.relation;
    }
  }
  ctx.restore();
}

const RELATION_FONT_SIZE = 12;
/** Radius of the bend handle of a picked relation, in screen pixels. */
export const RELATION_HANDLE_PX = 7;

export function render(
  ctx: CanvasRenderingContext2D,
  layout: LayoutResult,
  view: View,
  width: number,
  height: number,
  dpr: number,
  state: RenderState,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);

  const left = -view.x / view.scale;
  const top = -view.y / view.scale;
  const right = left + width / view.scale;
  const bottom = top + height / view.scale;
  const visible = (b: NodeBox) => b.x <= right && b.x + b.w >= left && b.y <= bottom && b.y + b.h >= top;

  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const box of layout.boxes) {
    const parent = box.parentId && layout.byId.get(box.parentId);
    if (!parent) continue;
    if (Math.max(box.y, parent.y) > bottom || Math.min(box.y + box.h, parent.y + parent.h) < top) continue;
    if (Math.max(box.x + box.w, parent.x + parent.w) < left || Math.min(box.x, parent.x) > right) continue;
    const c = connector(parent, box);
    if (c.kind === 'curve') {
      ctx.moveTo(c.x1, c.y1);
      ctx.bezierCurveTo(c.c1x, c.c1y, c.c2x, c.c2y, c.x2, c.y2);
    } else {
      c.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    }
  }
  ctx.stroke();

  // Level of detail: when zoomed far out, thousands of boxes are visible but
  // text and toggles are below a readable size, and drawing them dominates the frame.
  const showToggles = view.scale >= MIN_TOGGLE_SCALE;
  const underlines = new Path2D();

  ctx.textBaseline = 'middle';
  for (const box of layout.boxes) {
    if (!visible(box)) continue;
    const style = levelStyle(box.depth);
    const readable = style.fontSize * view.scale >= MIN_TEXT_PX;
    if (state.highlights?.has(box.id)) {
      ctx.fillStyle = COLORS.match;
      ctx.beginPath();
      ctx.roundRect(box.x - 5, box.y - 5, box.w + 10, box.h + 10, style.radius + 5);
      ctx.fill();
    }
    const look = topicLook(box);
    if (look.fill) {
      ctx.fillStyle = look.fill;
      if (readable) {
        ctx.beginPath();
        ctx.roundRect(box.x, box.y, box.w, box.h, style.radius);
        ctx.fill();
      } else {
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
    } else {
      underlines.moveTo(box.x, box.y + box.h);
      underlines.lineTo(box.x + box.w, box.y + box.h);
    }
    if (!readable) {
      if (box.id === state.selection || box.id === state.dropTarget || state.selected?.has(box.id)) {
        ctx.fillStyle = box.id === state.dropTarget ? COLORS.dropTarget : COLORS.selection;
        ctx.fillRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
      }
      continue;
    }
    if (box.id !== state.editing) {
      ctx.fillStyle = look.color;
      ctx.font = style.font;
      let y = box.y + style.padY + style.lineHeight / 2;
      for (const line of box.lines) {
        ctx.fillText(line, box.x + style.padX, y);
        y += style.lineHeight;
      }
      if (box.attrs.length) {
        ctx.fillStyle = look.attr;
        ctx.font = ATTR_STYLE.font;
        y += ATTR_STYLE.gap - style.lineHeight / 2 + ATTR_STYLE.lineHeight / 2;
        for (const line of box.attrs) {
          ctx.fillText(line, box.x + style.padX, y);
          y += ATTR_STYLE.lineHeight;
        }
      }
    }
    if (box.id === state.selection || box.id === state.dropTarget || state.selected?.has(box.id)) {
      ctx.strokeStyle = box.id === state.dropTarget ? COLORS.dropTarget : COLORS.selection;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6, style.radius + 3);
      ctx.stroke();
    }
    const toggle = showToggles ? togglePoint(box) : undefined;
    if (toggle) {
      ctx.fillStyle = COLORS.toggleFill;
      ctx.strokeStyle = COLORS.toggleStroke;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(toggle.x, toggle.y, TOGGLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COLORS.toggleStroke;
      if (box.collapsed) {
        ctx.font = '9px system-ui, sans-serif';
        const label = box.childCount > 99 ? '…' : String(box.childCount);
        ctx.fillText(label, toggle.x - ctx.measureText(label).width / 2, toggle.y + 0.5);
      } else {
        ctx.fillRect(toggle.x - 3.5, toggle.y - 0.5, 7, 1);
      }
    }
  }
  ctx.strokeStyle = COLORS.edge;
  ctx.lineWidth = 1.5;
  ctx.stroke(underlines);
  if (state.band) {
    const b = state.band;
    ctx.fillStyle = 'rgba(47, 111, 237, 0.08)';
    ctx.strokeStyle = 'rgba(47, 111, 237, 0.7)';
    ctx.lineWidth = 1 / view.scale;
    ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
  }
  const line = state.dropLine && layout.byId.get(state.dropLine.id);
  if (line) {
    ctx.strokeStyle = COLORS.dropTarget;
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (line.flow === 'org') {
      // Neighbours stand side by side: a vertical line left or right of the topic.
      const x = state.dropLine!.place === 'before' ? line.x - ORG_GAP_X / 2 : line.x + line.w + ORG_GAP_X / 2;
      ctx.moveTo(x, line.y - 6);
      ctx.lineTo(x, line.y + line.h + 6);
    } else {
      const y = state.dropLine!.place === 'before' ? line.y - V_GAP / 2 : line.y + line.h + V_GAP / 2;
      ctx.moveTo(line.x - 6, y);
      ctx.lineTo(line.x + line.w + 6, y);
    }
    ctx.stroke();
  }
  renderRelations(ctx, layout, view, state);
}

/** Text smaller than this many screen pixels is not drawn. */
const MIN_TEXT_PX = 3.5;
/** Collapse toggles are hidden below this zoom. */
const MIN_TOGGLE_SCALE = 0.35;
