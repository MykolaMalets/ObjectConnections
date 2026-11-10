import { getNode } from '@oc/core';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { builtinExtensions } from './ext/builtin/index.ts';
import { ExtensionHost } from './ext/host.ts';
import { openFile, saveFile } from './state/files.ts';
import type { Session } from './state/store.ts';
import {
  Workspace,
  addChild,
  addSheet,
  drillDown,
  drillTo,
  drillUp,
  extractSelectedToSheet,
  newSession,
  redo,
  renameSheet,
  selectSheet,
  undo,
} from './state/store.ts';
import { MapCanvas } from './view/MapCanvas.tsx';

const AUTOSAVE_DELAY_MS = 1500;

function createHost(): ExtensionHost {
  const ws = new Workspace();
  const host = new ExtensionHost(ws, builtinExtensions);
  newSession(ws);
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
      for (const s of ws.sessions) if (s.dirty && s.file) void saveFile(host, s, true);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [host, ws, version]);

  const closeSession = (s: Session) => {
    if (s.dirty && !confirm(`В «${s.name}» есть несохранённые изменения. Закрыть без сохранения?`)) return;
    ws.close(s);
  };

  const panel = host.activePanel ? host.panels.get(host.activePanel) : undefined;
  // Bars keep keyboard focus on the canvas: mousedown on their buttons never moves focus.
  const keepFocus = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName !== 'SELECT') e.preventDefault();
  };

  return (
    <div className="app">
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
        {session?.conflict && <span className="warning">Файл изменён вне редактора — автосохранение остановлено</span>}
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
                closeSession(s);
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
              onClick={() => selectSheet(ws, sheet.id)}
              onDoubleClick={() => {
                const title = prompt('Название листа', sheet.title);
                if (title) renameSheet(ws, sheet.id, title);
              }}
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
