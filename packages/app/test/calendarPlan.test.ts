import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, createDoc } from '@oc/core';
import type { CalendarEvent } from '../src/state/calendarPlan.ts';
import { calendarEntries, planCalendarSync, remindersSignature } from '../src/state/calendarPlan.ts';

const NOW = Date.parse('2026-11-12T10:00:00Z');

function docWith(reminders: { id: string; at: string; text?: string }[]) {
  const doc = createDoc('Map');
  const root = doc.sheets[0]!.rootIds[0]!;
  applyOps(doc, [{ t: 'patchNode', id: root, patch: { text: 'Call', reminders } }]);
  return doc;
}

test('calendar entries are titled with the topic and the reminder text', () => {
  const doc = docWith([
    { id: 'r1', at: '2026-11-13T09:00:00.000Z' },
    { id: 'r2', at: '2026-11-14T09:00:00.000Z', text: 'mum' },
  ]);
  assert.deepEqual(
    calendarEntries(doc).map((e) => e.summary),
    ['Call', 'Call — mum'],
  );
});

test('plan creates future events, updates changed ones and removes orphans', () => {
  const doc = docWith([
    { id: 'future', at: '2026-11-13T09:00:00.000Z' },
    { id: 'past', at: '2026-11-11T09:00:00.000Z' },
    { id: 'moved', at: '2026-11-15T09:00:00.000Z' },
    { id: 'same', at: '2026-11-16T09:00:00.000Z' },
  ]);
  const events: CalendarEvent[] = [
    { eventId: 'e-moved', reminderId: 'moved', start: '2026-11-15T08:00:00Z', summary: 'Call' },
    // The calendar answers in its own time zone; the same instant is not a change.
    { eventId: 'e-same', reminderId: 'same', start: '2026-11-16T11:00:00+02:00', summary: 'Call' },
    { eventId: 'e-gone', reminderId: 'deleted', start: '2026-11-20T09:00:00Z', summary: 'Old' },
    { eventId: 'e-dup', reminderId: 'same', start: '2026-11-16T09:00:00Z', summary: 'Call' },
  ];
  const plan = planCalendarSync(calendarEntries(doc), events, NOW);
  assert.deepEqual(
    plan.create.map((e) => e.reminderId),
    ['future'],
  );
  assert.deepEqual(
    plan.update.map((u) => u.eventId),
    ['e-moved'],
  );
  assert.deepEqual(plan.remove.sort(), ['e-dup', 'e-gone']);
});

test('signature changes with reminders and topic text only', () => {
  const doc = docWith([{ id: 'r1', at: '2026-11-13T09:00:00.000Z' }]);
  const before = remindersSignature(doc);
  const root = doc.sheets[0]!.rootIds[0]!;
  applyOps(doc, [{ t: 'patchNode', id: root, patch: { notes: 'irrelevant' } }]);
  assert.equal(remindersSignature(doc), before);
  applyOps(doc, [{ t: 'patchNode', id: root, patch: { text: 'Call back' } }]);
  assert.notEqual(remindersSignature(doc), before);
});
