// Reminders that have come due. No DOM here, so it is tested in Node.

import type { Doc, Id, MapNode, Reminder } from '@oc/core';

export interface DueReminder {
  doc: Doc;
  node: MapNode;
  reminder: Reminder;
}

/** Reminders older than this are not announced when the editor opens after a long pause. */
export const MAX_LATE_MS = 7 * 24 * 60 * 60 * 1000;

/** Reminders whose time has come and that were not announced yet, oldest first. */
export function dueReminders(docs: Doc[], now: number, announced: (id: Id) => boolean): DueReminder[] {
  const due: DueReminder[] = [];
  for (const doc of docs) {
    for (const node of Object.values(doc.nodes)) {
      for (const reminder of node.reminders ?? []) {
        const at = Date.parse(reminder.at);
        if (Number.isNaN(at) || at > now || now - at > MAX_LATE_MS || announced(reminder.id)) continue;
        due.push({ doc, node, reminder });
      }
    }
  }
  return due.sort((a, b) => Date.parse(a.reminder.at) - Date.parse(b.reminder.at));
}

/** Upcoming reminders of a document, soonest first. */
export function upcomingReminders(doc: Doc, now: number, limit = 10): { node: MapNode; reminder: Reminder }[] {
  const list: { node: MapNode; reminder: Reminder }[] = [];
  for (const node of Object.values(doc.nodes)) {
    for (const reminder of node.reminders ?? []) {
      if (Date.parse(reminder.at) >= now) list.push({ node, reminder });
    }
  }
  return list.sort((a, b) => Date.parse(a.reminder.at) - Date.parse(b.reminder.at)).slice(0, limit);
}

/** Converts a `<input type="datetime-local">` value (local time) to ISO 8601 UTC; null if invalid. */
export function localInputToIso(value: string): string | null {
  const time = new Date(value).getTime();
  return value && !Number.isNaN(time) ? new Date(time).toISOString() : null;
}

/** Converts ISO 8601 to the value format of `<input type="datetime-local">` in local time. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
