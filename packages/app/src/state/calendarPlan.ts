// What to change in an outside calendar so that it matches the reminders of a
// document. No DOM and no network here, so it is tested in Node.
//
// Each reminder is one calendar event, found by the reminder id stored in the
// event (not by `calendarEventId` in the document: matching this way needs no
// change to the map, works from any device and survives undo).

import type { Doc, Id } from '@oc/core';

export interface CalendarEntry {
  reminderId: Id;
  /** ISO 8601. */
  start: string;
  summary: string;
}

export interface CalendarEvent extends CalendarEntry {
  eventId: string;
}

export interface CalendarPlan {
  create: CalendarEntry[];
  update: { eventId: string; entry: CalendarEntry }[];
  remove: string[];
}

/** The calendar entries a document asks for: one per reminder, titled with the topic. */
export function calendarEntries(doc: Doc): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const node of Object.values(doc.nodes)) {
    for (const reminder of node.reminders ?? []) {
      if (Number.isNaN(Date.parse(reminder.at))) continue;
      const topic = node.text.trim() || 'Тема без названия';
      entries.push({ reminderId: reminder.id, start: reminder.at, summary: reminder.text ? `${topic} — ${reminder.text}` : topic });
    }
  }
  return entries;
}

/**
 * Events are created only for reminders still ahead: a past reminder that never
 * had an event (written before the calendar was connected) is not worth one.
 * Existing events are kept in line, past or not; events whose reminder is gone are removed.
 */
export function planCalendarSync(entries: CalendarEntry[], events: CalendarEvent[], now: number): CalendarPlan {
  const plan: CalendarPlan = { create: [], update: [], remove: [] };
  const byReminder = new Map<Id, CalendarEvent>();
  for (const event of events) {
    if (byReminder.has(event.reminderId)) plan.remove.push(event.eventId);
    else byReminder.set(event.reminderId, event);
  }
  const wanted = new Set<Id>();
  for (const entry of entries) {
    wanted.add(entry.reminderId);
    const event = byReminder.get(entry.reminderId);
    if (!event) {
      if (Date.parse(entry.start) > now) plan.create.push(entry);
    } else if (Date.parse(event.start) !== Date.parse(entry.start) || event.summary !== entry.summary) {
      plan.update.push({ eventId: event.eventId, entry });
    }
  }
  for (const event of byReminder.values()) if (!wanted.has(event.reminderId)) plan.remove.push(event.eventId);
  return plan;
}

/** A short fingerprint of the reminders; the editor syncs only when it changes. */
export function remindersSignature(doc: Doc): string {
  return JSON.stringify(calendarEntries(doc).sort((a, b) => (a.reminderId < b.reminderId ? -1 : 1)));
}
