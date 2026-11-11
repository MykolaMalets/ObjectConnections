// The topic's menu: shown by a right click, a long press on a touch screen and the "⋯" button of the touch bar.

import type { Id } from '@oc/core';
import type { Session, Workspace } from '../state/store.ts';
import {
  addChild,
  addSibling,
  copySelection,
  cutSelection,
  drillDown,
  extractSelectedToSheet,
  openLink,
  pasteClipboard,
  removeRelation,
  removeSelected,
  select,
  setRelationText,
  setUrlLink,
  startEdit,
  startLinking,
  toggleCollapse,
} from '../state/store.ts';
import { promptDialog } from '../ui/dialogs.tsx';
import type { MenuItem } from '../ui/menu.tsx';

/** Selects the topic and returns its menu items. Shortcut hints are left out on touch screens. */
export function nodeMenuItems(ws: Workspace, session: Session, id: Id, touch = false): MenuItem[] {
  select(ws, id);
  const node = session.doc.nodes[id]!;
  const isViewRoot = node.parentId === null || node.id === session.focusId;
  const link = node.link;
  const label = (text: string, shortcut: string) => (touch ? text : `${text}\t${shortcut}`);
  const items: MenuItem[] = [
    { label: label('Подтема', 'Tab'), run: () => addChild(ws) },
    { label: label('Тема рядом', 'Enter'), disabled: isViewRoot, run: () => addSibling(ws) },
    { label: label('Изменить текст', 'F2'), run: () => startEdit(ws) },
    {
      label: label('Копировать', 'Ctrl+C'),
      separator: true,
      run: () => {
        const data = copySelection(ws);
        if (data) void navigator.clipboard?.writeText(data.text).catch(() => undefined);
      },
    },
    {
      label: label('Вырезать', 'Ctrl+X'),
      disabled: isViewRoot,
      run: () => {
        const data = cutSelection(ws);
        if (data) void navigator.clipboard?.writeText(data.text).catch(() => undefined);
      },
    },
    {
      label: label('Вставить', 'Ctrl+V'),
      run: async () => {
        const text = await navigator.clipboard?.readText().catch(() => undefined);
        pasteClipboard(ws, text === undefined ? {} : { text });
      },
    },
    {
      label: touch
        ? link?.type === 'node'
          ? 'Перейти по ссылке'
          : 'Открыть ссылку'
        : link?.type === 'node'
          ? 'Перейти по ссылке\tCtrl+щелчок'
          : 'Открыть ссылку\tCtrl+щелчок',
      separator: true,
      disabled: !link || link.type === 'file',
      run: () => void openLink(ws, node.id),
    },
    {
      label: link?.type === 'url' ? 'Изменить ссылку…' : 'Добавить ссылку…',
      disabled: !!link && link.type !== 'url',
      run: async () => {
        const url = await promptDialog('Адрес ссылки (пусто — убрать ссылку)', link?.type === 'url' ? link.url : 'https://');
        if (url !== null) setUrlLink(ws, node.id, url === 'https://' ? null : url);
      },
    },
    {
      label: node.collapsed ? label('Развернуть ветку', '+') : label('Свернуть ветку', '−'),
      separator: true,
      disabled: node.children.length === 0 || node.parentId === null,
      run: () => toggleCollapse(ws, node.id),
    },
    { label: label('Показать как отдельную карту', 'F6'), run: () => drillDown(ws) },
    { label: 'Вынести на новый лист', disabled: node.parentId === null, run: () => extractSelectedToSheet(ws) },
    { label: 'Связать с темой…', separator: true, run: () => startLinking(ws) },
  ];
  for (const r of Object.values(session.doc.relations)) {
    if (r.from !== node.id && r.to !== node.id) continue;
    const other = session.doc.nodes[r.from === node.id ? r.to : r.from]?.text ?? '…';
    const name = `${r.from === node.id ? '→' : '←'} «${other}»${r.text ? ` (${r.text})` : ''}`;
    items.push(
      {
        label: `Подпись связи ${name}…`,
        run: async () => {
          const text = await promptDialog('Подпись связи (пусто — без подписи)', r.text ?? '');
          if (text !== null) setRelationText(ws, r.id, text);
        },
      },
      { label: `Удалить связь ${name}`, run: () => removeRelation(ws, r.id) },
    );
  }
  items.push({ label: label('Удалить', 'Del'), separator: true, disabled: isViewRoot, run: () => removeSelected(ws) });
  return items;
}
