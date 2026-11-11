import type { Doc } from '@oc/core';
import { getNode, validate } from '@oc/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { builtinExtensions } from './ext/builtin/index.ts';
import { ExtensionHost } from './ext/host.ts';
import { openFile, saveFile, syncFromStorage } from './state/files.ts';
import { dueReminders } from './state/reminders.ts';
import {
  Session,
  Workspace,
  addChild,
  addSheet,
  deleteSheet,
  mergeSheetIntoSelection,
  moveSheetBy,
  drillDown,
  drillTo,
  drillUp,
  extractSelectedToSheet,
  newSession,
  redo,
  renameSheet,
  revealNode,
  selectSheet,
  undo,
} from './state/store.ts';
import { DialogHost, confirmDialog, promptDialog } from './ui/dialogs.tsx';
import { MenuHost, showMenu } from './ui/menu.tsx';
import { MapCanvas } from './view/MapCanvas.tsx';

const AUTOSAVE_DELAY_MS = 1500;
const STORAGE_CHECK_MS = 2000;

// Drafts: unsaved documents are mirrored to localStorage so a page reload
// (or a crash) does not lose them. A draft is dropped once its tab is saved or closed.
const DRAFT_PREFIX = 'oc-draft:';

function restoreDrafts(ws: Workspace): void {
  for (const key of Object.keys(localStorage).filter((k) => k.startsWith(DRAFT_PREFIX)).sort()) {
    try {
      const draft = JSON.parse(localStorage.getItem(key)!) as { name: string; doc: Doc };
      if (validate(draft.doc).length) throw new Error('invalid draft');
      const session = new Session(draft.doc, draft.name);
      session.savedRevision = -1;
      ws.add(session);
    } catch {
      localStorage.removeItem(key);
    }
  }
}

function writeDrafts(ws: Workspace): void {
  const keep = new Set<string>();
  for (const s of ws.sessions) {
    if (!s.dirty) continue;
    const key = DRAFT_PREFIX + s.doc.id;
    keep.add(key);
    try {
      localStorage.setItem(key, JSON.stringify({ name: s.name, doc: s.doc }));
    } catch (error) {
      console.warn('draft not stored', error);
    }
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(DRAFT_PREFIX) && !keep.has(key)) localStorage.removeItem(key);
  }
}

// Reminders: announced once each. Ids of announced reminders are kept in localStorage.
const ANNOUNCED_KEY = 'oc-announced-reminders';
const REMINDER_CHECK_MS = 20_000;

function loadAnnounced(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ANNOUNCED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markAnnounced(ids: string[]): void {
  const all = [...loadAnnounced(), ...ids].slice(-1000);
  localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(all));
}

async function announceDueReminders(ws: Workspace): Promise<void> {
  const announced = loadAnnounced();
  const due = dueReminders(
    ws.sessions.map((s) => s.doc),
    Date.now(),
    (id) => announced.has(id),
  );
  if (due.length === 0) return;
  markAnnounced(due.map((d) => d.reminder.id));
  for (const { doc, node, reminder } of due) {
    const message = `Напоминание: «${node.text}»${reminder.text ? ` — ${reminder.text}` : ''}`;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('ObjectConnections', { body: message, tag: reminder.id });
    }
    if (await confirmDialog(message, 'Показать тему', 'Закрыть')) {
      const session = ws.sessions.find((s) => s.doc === doc);
      if (session) {
        ws.activate(session);
        revealNode(ws, node.id);
      }
    }
  }
}

function createHost(): ExtensionHost {
  const ws = new Workspace();
  const host = new ExtensionHost(ws, builtinExtensions);
  restoreDrafts(ws);
  if (ws.sessions.length === 0) newSession(ws);
  if (import.meta.env.DEV) Object.assign(window, { __ws: ws, __host: host });
  return host;
}

/** A `<select>` used as a menu: picking an item runs it and the control resets. */
function Menu({ label, items, onPick }: { label: string; items: { id: string; title: string }[]; onPick: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <select
      value=""
      onChange={(e) => {
        const id = e.currentTarget.value;
        e.currentTarget.blur();
        if (id) onPick(id);
      }}
    >
      <option value="">{label}</option>
      {items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.title}
        </option>
      ))}
    </select>
  );
}

export function App() {
  const host = useMemo(createHost, []);
  const ws = host.ws;
  const version = useSyncExternalStore(ws.subscribe, ws.getVersion);
  const session = ws.session;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT';
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      const key = e.key.toLowerCase();
      if (ctrl && !e.shiftKey && key === 's') {
        e.preventDefault();
        if (ws.session) void saveFile(host, ws.session);
      } else if (ctrl && !e.shiftKey && key === 'o') {
        e.preventDefault();
        void openFile(host);
      } else if (!typing) {
        const command = host.commandForKey(e);
        if (command) {
          e.preventDefault();
          void host.runCommand(command);
        }
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ws.sessions.some((s) => s.dirty && (s.file || s.history.canUndo))) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [host, ws]);

  // Autosave: a quiet period after the last change, only for files saved in place.
  useEffect(() => {
    const timer = setTimeout(() => {
      writeDrafts(ws);
      for (const s of ws.sessions) if (s.dirty && s.file) void saveFile(host, s, true);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [host, ws, version]);

  // Outside changes (an agent editing the file, another device) are picked up while the window is visible.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      for (const s of ws.sessions) void syncFromStorage(host, s);
    };
    const timer = setInterval(check, STORAGE_CHECK_MS);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [host, ws]);

  useEffect(() => {
    void announceDueReminders(ws);
    const timer = setInterval(() => void announceDueReminders(ws), REMINDER_CHECK_MS);
    return () => clearInterval(timer);
  }, [ws]);

  const closeSession = async (s: Session) => {
    const unsaved = s.dirty && (s.file || s.history.canUndo);
    if (unsaved && !(await confirmDialog(`В «${s.name}» есть несохранённые изменения. Закрыть без сохранения?`, 'Закрыть'))) return;
    ws.close(s);
  };

  const renameSheetAsk = async (s: Session, sheetId: string) => {
    const sheet = s.doc.sheets.find((x) => x.id === sheetId);
    const title = sheet && (await promptDialog('Название листа', sheet.title));
    if (title) renameSheet(ws, sheetId, title);
  };

  const deleteSheetAsk = async (s: Session, sheetId: string) => {
    const sheet = s.doc.sheets.find((x) => x.id === sheetId);
    if (!sheet) return;
    const count = sheet.rootIds.reduce(function size(sum: number, id: string): number {
      return s.doc.nodes[id]!.children.reduce(size, sum + 1);
    }, 0);
    const ask = `Удалить лист «${sheet.title}» вместе с его картами (тем: ${count})? Это можно отменить через Ctrl+Z.`;
    if (await confirmDialog(ask, 'Удалить')) deleteSheet(ws, sheetId);
  };

  const sheetMenu = (e: React.MouseEvent, s: Session, sheetId: string) => {
    e.preventDefault();
    const sheets = s.doc.sheets;
    const index = sheets.findIndex((x) => x.id === sheetId);
    const target = s.selection ? getNode(s.doc, s.selection) : undefined;
    const targetOnOtherSheet = !!target && s.sheetId !== sheetId;
    showMenu(e.clientX, e.clientY, [
      { label: 'Переименовать…', run: () => void renameSheetAsk(s, sheetId) },
      { label: 'Сдвинуть влево', disabled: index <= 0, run: () => moveSheetBy(ws, sheetId, -1) },
      { label: 'Сдвинуть вправо', disabled: index >= sheets.length - 1, run: () => moveSheetBy(ws, sheetId, 1) },
      {
        label: targetOnOtherSheet ? `Влить в тему «${target.text}»` : 'Влить в выбранную тему (выберите тему на другом листе)',
        disabled: !targetOnOtherSheet,
        separator: true,
        run: () => mergeSheetIntoSelection(ws, sheetId),
      },
      { label: 'Удалить лист…', disabled: sheets.length <= 1, separator: true, run: () => void deleteSheetAsk(s, sheetId) },
    ]);
  };

  const panel = host.activePanel ? host.panels.get(host.activePanel) : undefined;
  // Bars keep keyboard focus on the canvas: mousedown on their buttons never moves focus.
  const keepFocus = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'SELECT') e.preventDefault();
  };

  return (
    <div className="app">
      <DialogHost />
      <MenuHost />
      <div className="toolbar" onMouseDown={keepFocus}>
        <button onClick={() => newSession(ws)}>Новая</button>
        <button onClick={() => void openFile(host)} title="Ctrl+O">Открыть</button>
        <button disabled={!session} onClick={() => session && void saveFile(host, session)} title="Ctrl+S">
          Сохранить
        </button>
        <span className="separator" />
        <button disabled={!session?.history.canUndo} onClick={() => undo(ws)} title="Ctrl+Z">↶</button>
        <button disabled={!session?.history.canRedo} onClick={() => redo(ws)} title="Ctrl+Y">↷</button>
        <span className="separator" />
        <button disabled={!session} onClick={() => addChild(ws)} title="Tab">Подтема</button>
        <button disabled={!session} onClick={() => drillDown(ws)} title="F6">Войти</button>
        <button disabled={!session} onClick={() => drillUp(ws)} title="Shift+F6">Вверх</button>
        <button disabled={!session} onClick={() => extractSelectedToSheet(ws)}>На новый лист</button>
        {[...host.commands.values()]
          .filter((command) => command.toolbar)
          .map((command) => (
            <button
              key={command.id}
              title={command.key}
              disabled={command.enabled ? !command.enabled(host.editor) : false}
              onClick={() => void host.runCommand(command)}
            >
              {command.title}
            </button>
          ))}
        <span className="separator" />
        {session && <Menu label="Экспорт…" items={[...host.exporters.values()]} onPick={(id) => void host.runExport(id)} />}
        <Menu label="Импорт…" items={[...host.importers.values()]} onPick={(id) => void host.runImport(id)} />
        <span className="spacer" />
        {session?.linking && <span className="hint">Щёлкните тему, с которой связать (Esc — отмена)</span>}
        {session?.conflict && <span className="warning">Файл изменён вне редактора — автосохранение остановлено</span>}
        {session?.saveError && !session.conflict && (
          <span className="warning" title={session.saveError}>
            Не сохранено — нажмите «Сохранить»
          </span>
        )}
        {[...host.panels.values()].map((p) => (
          <button key={p.id} className={p.id === host.activePanel ? 'pressed' : ''} onClick={() => host.togglePanel(p.id)}>
            {p.title}
          </button>
        ))}
        {session && (
          <button
            title="Сбросить масштаб"
            onClick={() => {
              session.view.scale = 1;
              session.needsCenter = true;
              ws.notify();
            }}
          >
            {Math.round(session.view.scale * 100)}%
          </button>
        )}
      </div>

      <div className="tabs" onMouseDown={keepFocus}>
        {ws.sessions.map((s) => (
          <div key={s.id} className={s === session ? 'tab active' : 'tab'} onClick={() => ws.activate(s)}>
            <span>
              {s.name}
              {s.dirty ? ' •' : ''}
            </span>
            <button
              className="close"
              title="Закрыть"
              onClick={(e) => {
                e.stopPropagation();
                void closeSession(s);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {session && session.focusPath.length > 0 && (
        <div className="breadcrumbs" onMouseDown={keepFocus}>
          <button onClick={() => drillTo(ws, 0)}>Вся карта</button>
          {session.focusPath.map((id, index) => (
            <span key={id}>
              <span className="chevron">›</span>
              <button disabled={index === session.focusPath.length - 1} onClick={() => drillTo(ws, index + 1)}>
                {getNode(session.doc, id)?.text || '…'}
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="main">
        {session ? (
          <MapCanvas key={session.id} ws={ws} session={session} />
        ) : (
          <div className="empty">Нет открытых карт. Создайте новую или откройте файл.</div>
        )}
        {panel && (
          <aside className="side">
            <h2>{panel.title}</h2>
            {panel.render(host.editor)}
          </aside>
        )}
      </div>

      {session && (
        <div className="sheets" onMouseDown={keepFocus}>
          {session.doc.sheets.map((sheet) => (
            <button
              key={sheet.id}
              className={sheet.id === session.sheetId ? 'sheet active' : 'sheet'}
              title="Двойной щелчок — переименовать, правая кнопка — меню листа"
              onClick={() => selectSheet(ws, sheet.id)}
              onDoubleClick={() => void renameSheetAsk(session, sheet.id)}
              onContextMenu={(e) => sheetMenu(e, session, sheet.id)}
            >
              {sheet.title}
            </button>
          ))}
          <button className="sheet" title="Добавить лист" onClick={() => addSheet(ws)}>
            +
          </button>
        </div>
      )}
    </div>
  );
}
