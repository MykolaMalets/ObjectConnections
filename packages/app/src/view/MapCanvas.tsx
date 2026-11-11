import type { Id } from '@oc/core';
import { getNode, isAncestorOrSelf } from '@oc/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Workspace } from '../state/store.ts';
import {
  addChild,
  addFloating,
  addSibling,
  drillDown,
  drillUp,
  finishEdit,
  moveSibling,
  redo,
  removeSelected,
  reparent,
  select,
  setRootPosition,
  startEdit,
  toggleCollapse,
  undo,
  FRAGMENT_MIME,
  copySelection,
  cutSelection,
  pasteClipboard,
} from '../state/store.ts';
import type { ClipboardData } from '../state/store.ts';
import type { Direction, LayoutResult, NodeBox } from './layout.ts';
import { hitTest, hitToggle, layoutRoots, neighbour } from './layout.ts';
import { render } from './render.ts';
import { createMeasure, levelStyle } from './style.ts';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'node'; id: Id; sx: number; sy: number; moved: boolean };

const MIN_SCALE = 0.15;
const MAX_SCALE = 4;
const REVEAL_MARGIN = 48;
const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

export function MapCanvas({ ws, session }: { ws: Workspace; session: Session }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<Drag | null>(null);
  const dropTarget = useRef<Id | null>(null);
  const cache = useRef<{ key: string; layout: LayoutResult } | null>(null);

  const measure = useMemo(() => {
    const canvas = document.createElement('canvas');
    return createMeasure(canvas.getContext('2d')!);
  }, []);

  const getLayout = (): LayoutResult => {
    const key = `${session.id}|${session.epoch}|${session.history.revision}|${session.sheetId}|${session.focusId}`;
    if (cache.current?.key !== key) {
      const layout = layoutRoots(session.doc, session.viewRoots, session.sheet?.structure, measure, !!session.focusId);
      cache.current = { key, layout };
    }
    return cache.current.layout;
  };

  const layout = getLayout();
  const view = session.view;

  // Requests made by actions are resolved here, before anything reads the view.
  if (size.w > 0) {
    if (session.needsCenter) {
      const box = layout.byId.get(session.viewRoots[0] ?? '');
      if (box) {
        view.x = size.w / 2 - (box.x + box.w / 2) * view.scale;
        view.y = size.h / 2 - (box.y + box.h / 2) * view.scale;
      }
      session.needsCenter = false;
      session.reveal = false;
    }
    if (session.reveal) {
      const box = session.selection ? layout.byId.get(session.selection) : undefined;
      if (box) {
        const left = box.x * view.scale + view.x;
        const top = box.y * view.scale + view.y;
        const right = left + box.w * view.scale;
        const bottom = top + box.h * view.scale;
        const mx = Math.min(REVEAL_MARGIN, size.w / 4);
        const my = Math.min(REVEAL_MARGIN, size.h / 4);
        if (left < mx) view.x += mx - left;
        else if (right > size.w - mx) view.x -= right - (size.w - mx);
        if (top < my) view.y += my - top;
        else if (bottom > size.h - my) view.y -= bottom - (size.h - my);
      }
      session.reveal = false;
    }
  }

  useEffect(() => {
    const container = containerRef.current!;
    const observer = new ResizeObserver(() => setSize({ w: container.clientWidth, h: container.clientHeight }));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Redraw after every state change.
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!size.w || !size.h) return;
    const frame = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(size.w * dpr);
      const h = Math.round(size.h * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      render(canvas.getContext('2d')!, getLayout(), session.view, size.w, size.h, dpr, {
        selection: session.selection,
        dropTarget: dropTarget.current,
        editing: session.editing?.id ?? null,
      });
    });
    return () => cancelAnimationFrame(frame);
  });

  // Keyboard focus lives on the container whenever the text editor is closed.
  const editingId = session.editing?.id ?? null;
  useEffect(() => {
    if (!editingId) containerRef.current?.focus();
  }, [editingId, session.id]);

  // Wheel needs a non-passive listener to stop the browser's own zoom.
  useEffect(() => {
    const container = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = session.view;
      if (e.ctrlKey || e.metaKey) {
        const rect = container.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * Math.exp(-e.deltaY * 0.0015)));
        v.x = sx - ((sx - v.x) * scale) / v.scale;
        v.y = sy - ((sy - v.y) * scale) / v.scale;
        v.scale = scale;
      } else {
        v.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        v.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      }
      ws.notify();
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [ws, session]);

  const locate = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return { sx, sy, x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    containerRef.current!.focus();
    const p = locate(e);
    const toggle = e.button === 0 ? hitToggle(layout, p.x, p.y) : undefined;
    if (toggle) {
      toggleCollapse(ws, toggle.id);
      return;
    }
    const box = e.button === 0 ? hitTest(layout, p.x, p.y) : undefined;
    if (box) {
      drag.current = { kind: 'node', id: box.id, sx: p.sx, sy: p.sy, moved: false };
      select(ws, box.id);
    } else {
      drag.current = { kind: 'pan', sx: p.sx, sy: p.sy, vx: view.x, vy: view.y };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = locate(e);
    if (d.kind === 'pan') {
      view.x = d.vx + p.sx - d.sx;
      view.y = d.vy + p.sy - d.sy;
      ws.notify();
      return;
    }
    if (!d.moved && Math.hypot(p.sx - d.sx, p.sy - d.sy) < 6) return;
    d.moved = true;
    const target = hitTest(layout, p.x, p.y);
    const node = getNode(session.doc, d.id);
    const valid =
      target && node && target.id !== node.parentId && !isAncestorOrSelf(session.doc, d.id, target.id);
    const next = valid ? target.id : null;
    if (next !== dropTarget.current) {
      dropTarget.current = next;
      ws.notify();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.kind !== 'node' || !d.moved) return;
    const target = dropTarget.current;
    dropTarget.current = null;
    const box = layout.byId.get(d.id);
    if (target) {
      reparent(ws, d.id, target);
    } else if (box && box.parentId === null && !session.focusId) {
      const p = locate(e);
      setRootPosition(ws, d.id, {
        x: Math.round(box.x + box.w / 2 + (p.sx - d.sx) / view.scale),
        y: Math.round(box.y + box.h / 2 + (p.sy - d.sy) / view.scale),
      });
    } else {
      ws.notify();
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const p = locate(e);
    if (hitToggle(layout, p.x, p.y)) return;
    const box = hitTest(layout, p.x, p.y);
    if (box) {
      select(ws, box.id);
      startEdit(ws);
    } else {
      addFloating(ws, { x: Math.round(p.x), y: Math.round(p.y) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (session.editing || e.target !== containerRef.current) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const selection = session.selection;
    let handled = true;
    if (ctrl && !e.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'z') (e.shiftKey ? redo : undo)(ws);
      else if (lower === 'y') redo(ws);
      else handled = false;
    } else if (key in ARROWS) {
      if (e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) moveSibling(ws, key === 'ArrowUp' ? -1 : 1);
      else if (selection) {
        const next = neighbour(session.doc, layout, selection, ARROWS[key]!);
        if (next) select(ws, next, true);
      }
    } else if (e.altKey) handled = false;
    else if (key === 'Tab' || key === 'Insert') addChild(ws);
    else if (key === 'Enter') addSibling(ws, e.shiftKey);
    else if (key === 'F2' || key === ' ') startEdit(ws);
    else if (key === 'Delete' || key === 'Backspace') removeSelected(ws);
    else if (key === 'F6') (e.shiftKey ? drillUp : drillDown)(ws);
    else if ((key === '+' || key === '=') && selection) toggleCollapse(ws, selection, false);
    else if (key === '-' && selection) toggleCollapse(ws, selection, true);
    else if (key.length === 1) startEdit(ws, key);
    else handled = false;
    if (handled) e.preventDefault();
  };

  // Clipboard events (not key handlers) give access to the system clipboard without a permission prompt.
  const onClipboardOut = (e: React.ClipboardEvent, data: ClipboardData | null) => {
    if (session.editing || e.target !== containerRef.current || !data) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', data.text);
    e.clipboardData.setData(FRAGMENT_MIME, JSON.stringify(data.fragment));
  };

  const editing = session.editing;
  const editBox =editing ? layout.byId.get(editing.id) : undefined;

  return (
    <div
      ref={containerRef}
      className="map-canvas"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={(e) => onClipboardOut(e, copySelection(ws))}
      onCut={(e) => onClipboardOut(e, cutSelection(ws))}
      onPaste={(e) => {
        if (session.editing || e.target !== containerRef.current) return;
        e.preventDefault();
        pasteClipboard(ws, {
          fragmentJson: e.clipboardData.getData(FRAGMENT_MIME),
          text: e.clipboardData.getData('text/plain'),
        });
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
      {editing && editBox && (
        <NodeEditor
          key={editing.id}
          box={editBox}
          text={editing.text}
          selectAll={editing.selectAll}
          scale={view.scale}
          left={editBox.x * view.scale + view.x}
          top={editBox.y * view.scale + view.y}
          onDone={(text) => finishEdit(ws, text)}
        />
      )}
    </div>
  );
}

interface NodeEditorProps {
  box: NodeBox;
  text: string;
  selectAll: boolean;
  scale: number;
  left: number;
  top: number;
  /** Called with the new text, or null when the edit is cancelled. */
  onDone: (text: string | null) => void;
}

function NodeEditor({ box, text, selectAll, scale, left, top, onDone }: NodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const style = levelStyle(box.depth);

  useEffect(() => {
    const el = ref.current!;
    el.focus();
    if (selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, [selectAll]);

  return (
    <textarea
      ref={ref}
      className="node-editor"
      defaultValue={text}
      rows={1}
      style={{
        left,
        top,
        minWidth: box.w * scale,
        minHeight: box.h * scale,
        font: style.font,
        fontSize: style.fontSize * scale,
        lineHeight: `${style.lineHeight * scale}px`,
        padding: `${style.padY * scale}px ${style.padX * scale}px`,
        borderRadius: style.radius * scale,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onDone(null);
        else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          e.preventDefault();
          onDone(e.currentTarget.value);
        }
      }}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  );
}
