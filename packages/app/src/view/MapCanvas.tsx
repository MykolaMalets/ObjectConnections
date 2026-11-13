import type { Id } from '@oc/core';
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
  clearMulti,
  moveBranches,
  select,
  selectAllVisible,
  selectMany,
  selectedBranches,
  selectedIds,
  toggleSelected,
  setRootPosition,
  startEdit,
  toggleCollapse,
  undo,
  FRAGMENT_MIME,
  copySelection,
  cutSelection,
  pasteClipboard,
  openLink,
  cancelLinking,
  finishLinking,
  removeRelation,
  selectRelation,
  setRelationBend,
  setRelationText,
} from '../state/store.ts';
import { showMenu } from '../ui/menu.tsx';
import { nodeMenuItems } from './nodeMenu.ts';
import type { ClipboardData } from '../state/store.ts';
import type { Direction, Drop, LayoutResult, NodeBox } from './layout.ts';
import { bendThrough, dropAt, dropDestination, hitRelation, hitTest, hitToggle, layoutRoots, neighbour, relationBend, relationCurve } from './layout.ts';
import { RELATION_HANDLE_PX, render } from './render.ts';
import { promptDialog } from '../ui/dialogs.tsx';
import { createMeasure, levelStyle } from './style.ts';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  /** `group`: the topic was already part of a group selection; a click without moving selects it alone. */
  | { kind: 'node'; id: Id; sx: number; sy: number; moved: boolean; group?: boolean }
  /** Shift+drag on empty space: selection frame, in map coordinates. */
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number }
  /** Dragging the handle of the picked relation. */
  | { kind: 'bend'; id: Id; bend: number; moved: boolean };

/** Two fingers on the screen: zoom around their midpoint and pan with it. */
interface Pinch {
  dist: number;
  mx: number;
  my: number;
  scale: number;
  vx: number;
  vy: number;
}

/** A finger that may still turn out to be a tap or a long press. */
interface Press {
  id: Id | null;
  sx: number;
  sy: number;
  clientX: number;
  clientY: number;
  timer: number;
}

const LONG_PRESS_MS = 500;
/** A finger that moves farther than this is panning, not tapping. */
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 350;
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
  const dropTarget = useRef<Drop | null>(null);
  const cache = useRef<{ key: string; layout: LayoutResult } | null>(null);
  // Touch: fingers on the screen (container coordinates), the gesture they make, the previous tap.
  const fingers = useRef(new Map<number, { sx: number; sy: number }>());
  const pinch = useRef<Pinch | null>(null);
  const press = useRef<Press | null>(null);
  const lastTap = useRef<{ at: number; sx: number; sy: number } | null>(null);
  const lastPointerType = useRef('mouse');
  /** Where a long press picked a topic up; its menu opens there if the finger lifts without moving. */
  const held = useRef<{ clientX: number; clientY: number } | null>(null);

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
        // Structures that grow downwards start near the top, so the branches below fit.
        view.y = box.flow === 'map' ? size.h / 2 - (box.y + box.h / 2) * view.scale : Math.min(size.h * 0.12, 48) - box.y * view.scale;
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
        selected: session.multi,
        band: drag.current?.kind === 'band' ? drag.current : null,
        dropTarget: dropTarget.current?.place === 'child' ? dropTarget.current.targetId : null,
        dropLine:
          dropTarget.current && dropTarget.current.place !== 'child'
            ? { id: dropTarget.current.targetId, place: dropTarget.current.place }
            : null,
        editing: session.editing?.id ?? null,
        highlights: session.highlights,
        relations: Object.values(session.doc.relations),
        selectedRelation: session.selectedRelation,
        bendPreview: drag.current?.kind === 'bend' ? { id: drag.current.id, bend: drag.current.bend } : null,
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

  /** The picked relation's handle under the point, if any. */
  const onBendHandle = (p: { x: number; y: number }, slack: number): boolean => {
    const relation = session.selectedRelation ? session.doc.relations[session.selectedRelation] : undefined;
    const from = relation && layout.byId.get(relation.from);
    const to = relation && layout.byId.get(relation.to);
    if (!relation || !from || !to || from === to) return false;
    const c = relationCurve(from, to, relationBend(relation));
    return Math.hypot(p.x - c.mx, p.y - c.my) <= (RELATION_HANDLE_PX + slack) / view.scale;
  };

  /** Relation line under the point (a few screen pixels of slack). */
  const relationAt = (p: { x: number; y: number }, slack: number) =>
    hitRelation(layout, Object.values(session.doc.relations), p.x, p.y, slack / view.scale);

  const relationMenu = (id: Id, clientX: number, clientY: number) => {
    const relation = session.doc.relations[id];
    if (!relation) return;
    showMenu(clientX, clientY, [
      {
        label: 'Подпись связи…',
        run: async () => {
          const text = await promptDialog('Подпись связи (пусто — без подписи)', relation.text ?? '');
          if (text !== null) setRelationText(ws, id, text);
        },
      },
      { label: 'Сбросить изгиб', disabled: relationBend(relation) === undefined, run: () => setRelationBend(ws, id, null) },
      { label: 'Удалить связь\tDel', separator: true, run: () => removeRelation(ws, id) },
    ]);
  };

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const startPinch = () => {
    const [a, b] = [...fingers.current.values()];
    if (!a || !b) return;
    pinch.current = {
      dist: Math.max(1, Math.hypot(a.sx - b.sx, a.sy - b.sy)),
      mx: (a.sx + b.sx) / 2,
      my: (a.sy + b.sy) / 2,
      scale: view.scale,
      vx: view.x,
      vy: view.y,
    };
  };

  // Touch gestures: one finger pans, a tap selects, a double tap edits (or adds a
  // topic on empty space), a long press opens the topic's menu, two fingers zoom.
  // Dragging topics with a finger is not supported: use Cut and Paste from the menu.
  const onTouchDown = (e: React.PointerEvent) => {
    const p = locate(e);
    fingers.current.set(e.pointerId, { sx: p.sx, sy: p.sy });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (or synthetic); the gesture still works without capture.
    }
    if (fingers.current.size === 2) {
      cancelPress();
      lastTap.current = null;
      drag.current = null;
      startPinch();
      return;
    }
    if (fingers.current.size > 2) return;
    containerRef.current!.focus();
    const toggle = hitToggle(layout, p.x, p.y);
    if (toggle) {
      toggleCollapse(ws, toggle.id);
      return;
    }
    if (onBendHandle(p, 12)) {
      drag.current = { kind: 'bend', id: session.selectedRelation!, bend: relationBend(session.doc.relations[session.selectedRelation!]!) ?? 0, moved: false };
      return;
    }
    const box = hitTest(layout, p.x, p.y);
    if (session.linking) {
      if (box) finishLinking(ws, box.id);
      else cancelLinking(ws);
      return;
    }
    drag.current = { kind: 'pan', sx: p.sx, sy: p.sy, vx: view.x, vy: view.y };
    const { clientX, clientY } = e;
    press.current = {
      id: box?.id ?? null,
      sx: p.sx,
      sy: p.sy,
      clientX,
      clientY,
      timer: window.setTimeout(() => {
        const current = press.current;
        press.current = null;
        if (!current?.id) return;
        // Held still: the topic is picked up. Moving the finger now drags it; letting go
        // without moving opens its menu. The menu is not shown under a finger that is still
        // down: Android would carry the long press over to it and cancel the touch.
        const group = session.multi.size > 0 && selectedIds(session).includes(current.id);
        drag.current = { kind: 'node', id: current.id, sx: current.sx, sy: current.sy, moved: false, group };
        held.current = { clientX, clientY };
        navigator.vibrate?.(15);
        if (!group) select(ws, current.id);
      }, LONG_PRESS_MS),
    };
  };

  const onTouchMove = (e: React.PointerEvent) => {
    const finger = fingers.current.get(e.pointerId);
    if (!finger) return;
    const p = locate(e);
    finger.sx = p.sx;
    finger.sy = p.sy;
    const pn = pinch.current;
    if (pn) {
      const [a, b] = [...fingers.current.values()];
      if (!a || !b) return;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (pn.scale * Math.hypot(a.sx - b.sx, a.sy - b.sy)) / pn.dist));
      const mx = (a.sx + b.sx) / 2;
      const my = (a.sy + b.sy) / 2;
      // The map point that was under the starting midpoint stays under the current one.
      view.x = mx - ((pn.mx - pn.vx) * scale) / pn.scale;
      view.y = my - ((pn.my - pn.vy) * scale) / pn.scale;
      view.scale = scale;
      ws.notify();
      return;
    }
    if (press.current && Math.hypot(p.sx - press.current.sx, p.sy - press.current.sy) > TAP_SLOP) {
      cancelPress();
      lastTap.current = null;
    }
    const d = drag.current;
    if (d?.kind === 'bend') {
      dragBend(d, p);
    } else if (d?.kind === 'pan') {
      view.x = d.vx + p.sx - d.sx;
      view.y = d.vy + p.sy - d.sy;
      ws.notify();
    } else if (d?.kind === 'node') {
      dragNodeMove(d, p, TAP_SLOP);
    }
  };

  const onTouchUp = (e: React.PointerEvent) => {
    if (!fingers.current.delete(e.pointerId)) return;
    if (pinch.current) {
      if (fingers.current.size >= 2) {
        startPinch();
        return;
      }
      pinch.current = null;
      // The remaining finger goes on panning from where it is.
      const [rest] = [...fingers.current.values()];
      drag.current = rest ? { kind: 'pan', sx: rest.sx, sy: rest.sy, vx: view.x, vy: view.y } : null;
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'bend') {
      if (d.moved && e.type !== 'pointercancel') setRelationBend(ws, d.id, d.bend);
      else ws.notify();
      return;
    }
    if (d?.kind === 'node') {
      const at = held.current;
      held.current = null;
      if (d.moved && e.type !== 'pointercancel') dragNodeEnd(d, locate(e));
      else if (dropTarget.current) {
        dropTarget.current = null;
        ws.notify();
      }
      if (!d.moved && at && e.type !== 'pointercancel') showMenu(at.clientX, at.clientY, nodeMenuItems(ws, session, d.id, true));
      return;
    }
    const tap = press.current;
    if (!tap || e.type === 'pointercancel') {
      cancelPress();
      return;
    }
    cancelPress();
    const previous = lastTap.current;
    const now = Date.now();
    if (previous && now - previous.at < DOUBLE_TAP_MS && Math.hypot(tap.sx - previous.sx, tap.sy - previous.sy) < TAP_SLOP * 3) {
      lastTap.current = null;
      if (tap.id) {
        select(ws, tap.id);
        startEdit(ws);
      } else {
        const at = { x: (tap.sx - view.x) / view.scale, y: (tap.sy - view.y) / view.scale };
        if (!relationAt(at, 14)) addFloating(ws, { x: Math.round(at.x), y: Math.round(at.y) });
      }
      return;
    }
    lastTap.current = { at: now, sx: tap.sx, sy: tap.sy };
    if (!tap.id) {
      // A tap on a relation line picks it; a tap on empty space lets it go.
      const relation = relationAt({ x: (tap.sx - view.x) / view.scale, y: (tap.sy - view.y) / view.scale }, 14);
      if (relation && session.selectedRelation === relation) relationMenu(relation, tap.clientX, tap.clientY);
      else selectRelation(ws, relation ?? null);
      return;
    }
    if (tap.id && session.multiMode) toggleSelected(ws, tap.id);
    else if (tap.id && !((e.ctrlKey || e.metaKey) && openLink(ws, tap.id))) select(ws, tap.id);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType;
    if (e.pointerType === 'touch') {
      onTouchDown(e);
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;
    containerRef.current!.focus();
    const p = locate(e);
    if (e.button === 0 && onBendHandle(p, 3)) {
      drag.current = { kind: 'bend', id: session.selectedRelation!, bend: relationBend(session.doc.relations[session.selectedRelation!]!) ?? 0, moved: false };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const toggle = e.button === 0 ? hitToggle(layout, p.x, p.y) : undefined;
    if (toggle) {
      toggleCollapse(ws, toggle.id);
      return;
    }
    const box = e.button === 0 ? hitTest(layout, p.x, p.y) : undefined;
    if (session.linking && e.button === 0) {
      if (box) finishLinking(ws, box.id);
      else cancelLinking(ws);
      return;
    }
    if (box && (e.ctrlKey || e.metaKey) && openLink(ws, box.id)) return;
    // Shift+click, or Ctrl+click on a topic without a link: add to the selection or take out.
    if (box && e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      toggleSelected(ws, box.id);
      return;
    }
    if (box) {
      const group = session.multi.size > 0 && selectedIds(session).includes(box.id);
      drag.current = { kind: 'node', id: box.id, sx: p.sx, sy: p.sy, moved: false, group };
      if (!group) select(ws, box.id);
    } else if (e.button === 0 && e.shiftKey) {
      drag.current = { kind: 'band', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else if (e.button === 0 && relationAt(p, 6)) {
      selectRelation(ws, relationAt(p, 6)!);
      return;
    } else {
      selectRelation(ws, null);
      drag.current = { kind: 'pan', sx: p.sx, sy: p.sy, vx: view.x, vy: view.y };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  /** The relation handle is being dragged: the curve follows, saved on release. */
  const dragBend = (d: Extract<Drag, { kind: 'bend' }>, p: { x: number; y: number }) => {
    const relation = session.doc.relations[d.id];
    const from = relation && layout.byId.get(relation.from);
    const to = relation && layout.byId.get(relation.to);
    if (!from || !to) return;
    d.bend = bendThrough(from, to, p.x, p.y);
    d.moved = true;
    ws.notify();
  };

  /** A topic is being dragged: shows where it would land. */
  const dragNodeMove = (d: Extract<Drag, { kind: 'node' }>, p: ReturnType<typeof locate>, slop: number) => {
    if (!d.moved && Math.hypot(p.sx - d.sx, p.sy - d.sy) < slop) return;
    d.moved = true;
    const next = dropAt(session.doc, layout, d.id, p.x, p.y);
    const current = dropTarget.current;
    if (next?.targetId !== current?.targetId || next?.place !== current?.place) {
      dropTarget.current = next;
      ws.notify();
    }
  };

  /** The dragged topic is let go: moves the branch, or moves a free-standing map to the new place. */
  const dragNodeEnd = (d: Extract<Drag, { kind: 'node' }>, p: ReturnType<typeof locate>) => {
    const drop = dropTarget.current;
    dropTarget.current = null;
    const box = layout.byId.get(d.id);
    if (drop && d.group) {
      // A group lands together; positions count among the children that stay put.
      const group = selectedBranches(session);
      if (!group.includes(drop.targetId)) {
        const target = session.doc.nodes[drop.targetId]!;
        const parentId = drop.place === 'child' ? drop.targetId : target.parentId!;
        const staying = session.doc.nodes[parentId]!.children.filter((c) => !group.includes(c));
        const index = drop.place === 'child' ? undefined : staying.indexOf(drop.targetId) + (drop.place === 'after' ? 1 : 0);
        moveBranches(ws, d.id, parentId, index);
      } else {
        ws.notify();
      }
    } else if (drop) {
      const { parentId, index } = dropDestination(session.doc, d.id, drop);
      moveBranches(ws, d.id, parentId, index);
    } else if (box && box.parentId === null && !session.focusId) {
      setRootPosition(ws, d.id, {
        x: Math.round(box.x + box.w / 2 + (p.sx - d.sx) / view.scale),
        y: Math.round(box.y + box.h / 2 + (p.sy - d.sy) / view.scale),
      });
    } else {
      ws.notify();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      onTouchMove(e);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const p = locate(e);
    if (d.kind === 'pan') {
      view.x = d.vx + p.sx - d.sx;
      view.y = d.vy + p.sy - d.sy;
      ws.notify();
      return;
    }
    if (d.kind === 'band') {
      d.x1 = p.x;
      d.y1 = p.y;
      ws.notify();
      return;
    }
    if (d.kind === 'bend') {
      dragBend(d, p);
      return;
    }
    dragNodeMove(d, p, 6);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      onTouchUp(e);
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'band') {
      const [left, right] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
      const [top, bottom] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
      const inside = layout.boxes.filter((b) => b.x < right && b.x + b.w > left && b.y < bottom && b.y + b.h > top).map((b) => b.id);
      // The frame adds to what is selected already.
      if (inside.length) selectMany(ws, [...selectedIds(session), ...inside.filter((id) => !selectedIds(session).includes(id))]);
      else ws.notify();
      return;
    }
    if (d?.kind === 'bend') {
      if (d.moved) setRelationBend(ws, d.id, d.bend);
      else ws.notify();
      return;
    }
    if (!d || d.kind !== 'node') return;
    if (!d.moved) {
      if (d.group) select(ws, d.id);
      return;
    }
    dragNodeEnd(d, locate(e));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    // Touch double taps are recognised in onTouchUp; the browser's own dblclick would repeat them.
    if (lastPointerType.current === 'touch') return;
    const p = locate(e);
    if (hitToggle(layout, p.x, p.y)) return;
    const box = hitTest(layout, p.x, p.y);
    if (box) {
      select(ws, box.id);
      startEdit(ws);
    } else if (!relationAt(p, 6)) {
      addFloating(ws, { x: Math.round(p.x), y: Math.round(p.y) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (session.editing || e.target !== containerRef.current) return;
    if (session.linking && e.key === 'Escape') {
      e.preventDefault();
      cancelLinking(ws);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const selection = session.selection;
    let handled = true;
    if (session.selectedRelation && (key === 'Delete' || key === 'Backspace' || key === 'Escape')) {
      e.preventDefault();
      if (key === 'Escape') selectRelation(ws, null);
      else removeRelation(ws, session.selectedRelation);
      return;
    }
    if (key === 'Escape' && (session.multi.size > 0 || session.multiMode)) {
      e.preventDefault();
      clearMulti(ws);
      return;
    }
    if (ctrl && !e.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'a') selectAllVisible(ws);
      else if (lower === 'z') (e.shiftKey ? redo : undo)(ws);
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

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    // On touch screens the long press is handled by the gesture code, which knows whether the finger moved.
    if (session.editing || lastPointerType.current === 'touch') return;
    const p = locate(e);
    const box = hitTest(layout, p.x, p.y);
    if (box) showMenu(e.clientX, e.clientY, nodeMenuItems(ws, session, box.id));
    else {
      const relation = relationAt(p, 6);
      if (relation) {
        selectRelation(ws, relation);
        relationMenu(relation, e.clientX, e.clientY);
      }
    }
  };

  // Clipboard events (not key handlers) give access to the system clipboard without a permission prompt.
  const onClipboardOut = (e: React.ClipboardEvent, data: ClipboardData | null) => {
    if (session.editing || e.target !== containerRef.current || !data) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', data.text);
    e.clipboardData.setData(FRAGMENT_MIME, JSON.stringify(data.fragments));
  };

  const editing = session.editing;
  const editBox =editing ? layout.byId.get(editing.id) : undefined;

  return (
    <div
      ref={containerRef}
      className={session.linking ? 'map-canvas linking' : 'map-canvas'}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
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
          onInput={(text) => {
            editing.text = text;
          }}
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
  /** Called on every change, so buttons elsewhere can save the text without waiting for a blur. */
  onInput: (text: string) => void;
  /** Called with the new text, or null when the edit is cancelled. */
  onDone: (text: string | null) => void;
}

function NodeEditor({ box, text, selectAll, scale, left, top, onInput, onDone }: NodeEditorProps) {
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
      onInput={(e) => onInput(e.currentTarget.value)}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  );
}
