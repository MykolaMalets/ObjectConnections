// Canvas renderer. Draws only what intersects the viewport.

import type { Id } from '@oc/core';
import type { LayoutResult, NodeBox } from './layout.ts';
import { TOGGLE_RADIUS, togglePoint } from './layout.ts';
import { COLORS, levelStyle } from './style.ts';

/** screen = world * scale + (x, y) */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface RenderState {
  selection: Id | null;
  dropTarget: Id | null;
  /** Box being edited: its text is hidden under the editor overlay. */
  editing: Id | null;
}

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
    const x1 = box.dir > 0 ? parent.x + parent.w : parent.x;
    const y1 = parent.y + parent.h / 2;
    const x2 = box.dir > 0 ? box.x : box.x + box.w;
    const y2 = box.y + box.h / 2;
    if (Math.max(x1, x2) < left || Math.min(x1, x2) > right) continue;
    const mid = (x1 + x2) / 2;
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(mid, y1, mid, y2, x2, y2);
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
    if (style.fill) {
      ctx.fillStyle = style.fill;
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
      if (box.id === state.selection || box.id === state.dropTarget) {
        ctx.fillStyle = box.id === state.dropTarget ? COLORS.dropTarget : COLORS.selection;
        ctx.fillRect(box.x - 3, box.y - 3, box.w + 6, box.h + 6);
      }
      continue;
    }
    if (box.id !== state.editing) {
      ctx.fillStyle = style.color;
      ctx.font = style.font;
      let y = box.y + style.padY + style.lineHeight / 2;
      for (const line of box.lines) {
        ctx.fillText(line, box.x + style.padX, y);
        y += style.lineHeight;
      }
    }
    if (box.id === state.selection || box.id === state.dropTarget) {
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
}

/** Text smaller than this many screen pixels is not drawn. */
const MIN_TEXT_PX = 3.5;
/** Collapse toggles are hidden below this zoom. */
const MIN_TOGGLE_SCALE = 0.35;
