// Reminders panel: reminders of the selected topic and the next ones in the map.
// Announcing due reminders is done by the app (see App.tsx, announceDueReminders).
// Outside calendars (ReminderSink) are kept in line with the active map here.

import type { Id, Reminder } from '@oc/core';
import { newId } from '@oc/core';
import { useRef, useSyncExternalStore } from 'react';
import { remindersSignature } from '../../state/calendarPlan.ts';
import { isoToLocalInput, localInputToIso, upcomingReminders } from '../../state/reminders.ts';
import type { EditorApi, Extension, Registry, ReminderSink } from '../api.ts';

// Calendar sync: a quiet period after the reminders of the active map change, then
// every connected sink gets the whole map. What was synced is remembered per sink
// and map, so unrelated edits cost nothing.
const SYNC_DELAY_MS = 2000;
const synced = new Map<string, string>();
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let syncAgain = false;

// Sync results change what the panel shows; it re-renders through this tiny store.
let syncVersion = 0;
const syncListeners = new Set<() => void>();
function syncChanged(): void {
  syncVersion++;
  for (const listener of syncListeners) listener();
}
const subscribeSync = (listener: () => void) => {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
};

function scheduleSync(editor: EditorApi, sinks: Registry<ReminderSink>): void {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runSync(editor, sinks), SYNC_DELAY_MS);
}

async function runSync(editor: EditorApi, sinks: Registry<ReminderSink>): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return;
  }
  const doc = editor.doc;
  if (!doc) return;
  syncing = true;
  try {
    const signature = remindersSignature(doc);
    for (const sink of sinks.list()) {
      const key = `${sink.id}|${doc.id}`;
      if (synced.get(key) === signature || sink.status().state === 'sign-in') continue;
      try {
        await sink.sync(doc);
        synced.set(key, signature);
      } catch (error) {
        console.warn(`reminders not synced to ${sink.title}`, error);
      }
      syncChanged();
    }
  } finally {
    syncing = false;
  }
  if (syncAgain) {
    syncAgain = false;
    await runSync(editor, sinks);
  }
}

function CalendarStatus({ editor, sinks }: { editor: EditorApi; sinks: Registry<ReminderSink> }) {
  useSyncExternalStore(subscribeSync, () => syncVersion);
  const list = sinks.list();
  if (list.length === 0) return <p className="hint">Срабатывают, пока редактор открыт.</p>;
  const connect = async (sink: ReminderSink) => {
    try {
      await sink.connect();
      const doc = editor.doc;
      if (doc) synced.delete(`${sink.id}|${doc.id}`);
      await runSync(editor, sinks);
    } catch {
      // The sink keeps the reason in its status.
    }
    syncChanged();
  };
  return (
    <>
      {list.map((sink) => {
        const status = sink.status();
        if (status.state === 'ready') {
          return (
            <p key={sink.id} className="hint">
              Напоминания этой карты добавляются в {sink.title}: телефон напомнит, даже когда редактор закрыт.
            </p>
          );
        }
        return (
          <div key={sink.id} className="attr">
            {status.state === 'error' ? (
              <p className="warning">
                {sink.title}: {status.message}
              </p>
            ) : (
              <p className="hint">Без календаря напоминания срабатывают, только пока редактор открыт.</p>
            )}
            <button onClick={() => void connect(sink)}>
              {status.state === 'error' ? 'Повторить' : `Подключить ${sink.title}`}
            </button>
          </div>
        );
      })}
    </>
  );
}

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

function RemindersPanel({ editor, sinks }: { editor: EditorApi; sinks: Registry<ReminderSink> }) {
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
    // This click may renew calendar access the user granted before; the sync then follows on its own.
    for (const sink of sinks.list()) {
      const status = sink.status();
      if (status.state === 'sign-in' && status.granted) void sink.connect().then(() => scheduleSync(editor, sinks), () => syncChanged());
    }
  };

  return (
    <>
      {node && id ? (
        <>
          <p className="hint">Напоминания темы «{node.text}».</p>
          <CalendarStatus editor={editor} sinks={sinks} />
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
    ctx.panels.register({
      id: 'reminders',
      title: 'Напоминания',
      render: (editor) => <RemindersPanel editor={editor} sinks={ctx.reminderSinks} />,
    });
    ctx.editor.subscribe(() => scheduleSync(ctx.editor, ctx.reminderSinks));
  },
};
