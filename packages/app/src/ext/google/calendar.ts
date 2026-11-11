// Google Calendar (extension google.calendar): reminders of a map become events
// in the user's primary calendar, with a notification at the reminder time, so
// the phone reminds even when the editor is closed.
//
// Each event carries the ids of its document and reminder in private extended
// properties; that is how events are found again (see state/calendarPlan.ts).

import type { Doc } from '@oc/core';
import type { Extension, ReminderSink } from '../api.ts';
import type { CalendarEntry, CalendarEvent } from '../../state/calendarPlan.ts';
import { calendarEntries, planCalendarSync } from '../../state/calendarPlan.ts';
import { SignInRequired, accessToken, forgetToken, googleConfig, grantedBefore, hasToken, preloadSignIn } from './auth.ts';

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const EVENT_MINUTES = 15;

let state: ReturnType<ReminderSink['status']> = { state: 'sign-in' };

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken([SCOPE], false);
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (response.status === 401) {
    forgetToken();
    throw new SignInRequired();
  }
  // An event deleted in the calendar by hand is already gone: nothing to do.
  if (response.status === 410 && init.method === 'DELETE') return response;
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { error?: { message?: string } }).error?.message ?? '';
    } catch {
      // Not JSON.
    }
    throw new Error(`Google Календарь ответил ошибкой ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string };
  extendedProperties?: { private?: Record<string, string> };
}

async function existingEvents(docId: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ privateExtendedProperty: `ocDoc=${docId}`, maxResults: '2500', showDeleted: 'false' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = (await (await call(`${EVENTS}?${query}`)).json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const item of page.items ?? []) {
      const reminderId = item.extendedProperties?.private?.ocReminder;
      if (reminderId && item.start?.dateTime) {
        events.push({ eventId: item.id, reminderId, start: item.start.dateTime, summary: item.summary ?? '' });
      }
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return events;
}

function eventBody(doc: Doc, entry: CalendarEntry) {
  const start = new Date(entry.start);
  const end = new Date(start.getTime() + EVENT_MINUTES * 60_000);
  return {
    summary: entry.summary,
    description: `Напоминание из карты «${doc.title}» (ObjectConnections).`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
    extendedProperties: { private: { ocDoc: doc.id, ocReminder: entry.reminderId } },
  };
}

export const calendarSink: ReminderSink = {
  id: 'google.calendar',
  title: 'Google Календарь',

  status() {
    if (hasToken([SCOPE])) return state.state === 'sign-in' ? { state: 'ready' } : state;
    return { ...(state.state === 'ready' ? { state: 'sign-in' as const } : state), granted: grantedBefore([SCOPE]) };
  },

  async connect() {
    try {
      await accessToken([SCOPE], true);
      state = { state: 'ready' };
    } catch (error) {
      state = { state: 'error', message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  },

  async sync(doc) {
    try {
      const plan = planCalendarSync(calendarEntries(doc), await existingEvents(doc.id), Date.now());
      for (const entry of plan.create) {
        await call(EVENTS, { method: 'POST', body: JSON.stringify(eventBody(doc, entry)) });
      }
      for (const { eventId, entry } of plan.update) {
        await call(`${EVENTS}/${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify(eventBody(doc, entry)) });
      }
      for (const eventId of plan.remove) {
        await call(`${EVENTS}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
      }
      state = { state: 'ready' };
    } catch (error) {
      state =
        error instanceof SignInRequired
          ? { state: 'sign-in' }
          : { state: 'error', message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  },
};

/** Registered only when the build has a Google client id (see googleConfig). */
export const googleCalendarExtension: Extension = {
  id: 'google.calendar',
  name: 'Google Календарь',
  activate(ctx) {
    if (!googleConfig()) return;
    preloadSignIn();
    ctx.reminderSinks.register(calendarSink);
  },
};
