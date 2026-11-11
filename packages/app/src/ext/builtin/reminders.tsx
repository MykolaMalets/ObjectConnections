// Reminders panel: reminders of the selected topic and the next ones in the map.
// Announcing due reminders is done by the app (see App.tsx, useReminderAlerts).

import type { Id, Reminder } from '@oc/core';
import { newId } from '@oc/core';
import { useRef } from 'react';
import { isoToLocalInput, localInputToIso, upcomingReminders } from '../../state/reminders.ts';
import type { EditorApi, Extension } from '../api.ts';

const formatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const formatAt = (iso: string) => formatter.format(new Date(iso));

/** One hour from now, rounded up to a quarter of an hour, as a datetime-local value. */
function defaultTime(): string {
  const quarter = 15 * 60 * 1000;
  return isoToLocalInput(new Date(Math.ceil((Date.now() + 60 * 60 * 1000) / quarter) * quarter).toISOString());
}

function setReminders(editor: EditorApi, id: Id, reminders: Reminder[], label: string): void {
  const sorted = [...reminders].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  editor.apply([{ t: 'patchNode', id, patch: { reminders: sorted.length ? sorted : null } }], label);
}

/** Browser notifications need permission, which may be asked only from a click. */
function askNotificationPermission(): void {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
}

function RemindersPanel({ editor }: { editor: EditorApi }) {
  const when = useRef<HTMLInputElement>(null);
  const what = useRef<HTMLInputElement>(null);
  const doc = editor.doc;
  if (!doc) return null;
  const id = editor.selection;
  const node = id ? doc.nodes[id] : undefined;
  const now = Date.now();
  const upcoming = upcomingReminders(doc, now);

  const add = () => {
    if (!id || !node) return;
    const at = localInputToIso(when.current?.value ?? '');
    if (!at) return;
    const text = what.current?.value.trim();
    const reminder: Reminder = { id: newId(), at };
    if (text) reminder.text = text;
    setReminders(editor, id, [...(node.reminders ?? []), reminder], 'Добавить напоминание');
    if (what.current) what.current.value = '';
    askNotificationPermission();
  };

  return (
    <>
      {node && id ? (
        <>
          <p className="hint">Напоминания темы «{node.text}». Срабатывают, пока редактор открыт.</p>
          {(node.reminders ?? []).map((r) => (
            <div key={r.id} className={Date.parse(r.at) < now ? 'reminder past' : 'reminder'}>
              <span>
                {formatAt(r.at)}
                {r.text ? ` — ${r.text}` : ''}
              </span>
              <button
                className="icon"
                title="Удалить напоминание"
                onClick={() => setReminders(editor, id, node.reminders!.filter((x) => x.id !== r.id), 'Удалить напоминание')}
              >
                ×
              </button>
            </div>
          ))}
          <div className="attr">
            <input ref={when} type="datetime-local" defaultValue={defaultTime()} key={id} />
            <input
              ref={what}
              type="text"
              placeholder="Текст (необязательно)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
            <button className="primary" onClick={add}>
              Добавить напоминание
            </button>
          </div>
        </>
      ) : (
        <p className="hint">Выберите тему, чтобы добавить к ней напоминание.</p>
      )}
      <h2>Ближайшие в этой карте</h2>
      {upcoming.length === 0 && <p className="hint">Нет предстоящих напоминаний.</p>}
      {upcoming.map(({ node: n, reminder: r }) => (
        <button key={r.id} className="reminder-link" onClick={() => editor.select(n.id)}>
          <b>{formatAt(r.at)}</b> {n.text}
          {r.text ? ` — ${r.text}` : ''}
        </button>
      ))}
    </>
  );
}

export const remindersExtension: Extension = {
  id: 'builtin.reminders',
  name: 'Напоминания',
  activate(ctx) {
    ctx.panels.register({ id: 'reminders', title: 'Напоминания', render: (editor) => <RemindersPanel editor={editor} /> });
  },
};
