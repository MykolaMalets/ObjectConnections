// Large buttons for the actions that a keyboard gives on the desktop. Shown on touch screens.
// Redo stays in the main toolbar: the bar has to fit a 360px wide phone.

import type { Session, Workspace } from '../state/store.ts';
import { addChild, addSibling, commitEdit, removeSelected, startEdit, undo } from '../state/store.ts';
import { showMenu } from '../ui/menu.tsx';
import { nodeMenuItems } from './nodeMenu.ts';

export const isTouchScreen = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function TouchBar({ ws, session }: { ws: Workspace; session: Session }) {
  const node = session.selection ? session.doc.nodes[session.selection] : undefined;
  const isViewRoot = !node || node.parentId === null || node.id === session.focusId;
  // An open text editor is saved first, as if the user had finished typing.
  const act = (action: () => void) => () => {
    commitEdit(ws);
    action();
  };
  return (
    <div className="touch-bar">
      <button disabled={!session.history.canUndo} onClick={act(() => undo(ws))} aria-label="Отменить">
        ↶
      </button>
      <button disabled={!node} onClick={act(() => {
          addChild(ws);
          startEdit(ws);
        })}>
        Подтема
      </button>
      <button disabled={isViewRoot} onClick={act(() => {
          addSibling(ws);
          startEdit(ws);
        })}>
        Рядом
      </button>
      <button disabled={!node} onClick={act(() => startEdit(ws))}>
        Текст
      </button>
      <button disabled={isViewRoot} onClick={act(() => removeSelected(ws))}>
        Удалить
      </button>
      <button
        disabled={!node}
        aria-label="Меню темы"
        onClick={(e) => {
          if (!node) return;
          commitEdit(ws);
          const rect = e.currentTarget.getBoundingClientRect();
          showMenu(rect.right, rect.top, nodeMenuItems(ws, session, node.id, true));
        }}
      >
        ⋯
      </button>
    </div>
  );
}
