import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Op } from '@oc/core';
import { applyOps, createDoc, createNode } from '@oc/core';
import { MAX_LATE_MS, dueReminders, isoToLocalInput, localInputToIso, upcomingReminders } from '../src/state/reminders.ts';

const NOW = Date.parse('2026-11-12T10:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function docWithReminders() {
  const doc = createDoc('Root');
  const root = doc.sheets[0]!.rootIds[0]!;
  const a = createNode('A');
  a.parentId = root;
  a.reminders = [
    { id: 'past', at: iso(-60_000) },
    { id: 'future', at: iso(3_600_000) },
    { id: 'ancient', at: iso(-MAX_LATE_MS - 1) },
    { id: 'broken', at: 'not a date' },
  ];
  const b = createNode('B');
  b.parentId = root;
  b.reminders = [
    { id: 'older', at: iso(-120_000) },
    { id: 'soon', at: iso(60_000) },
  ];
  applyOps(doc, [
    { t: 'insertSubtree', nodes: [a], rootId: a.id, parentId: root } satisfies Op,
    { t: 'insertSubtree', nodes: [b], rootId: b.id, parentId: root } satisfies Op,
  ]);
  return doc;
}

test('due reminders: past and not announced, not too old, oldest first', () => {
  const doc = docWithReminders();
  assert.deepEqual(
    dueReminders([doc], NOW, () => false).map((d) => d.reminder.id),
    ['older', 'past'],
  );
  assert.deepEqual(
    dueReminders([doc], NOW, (id) => id === 'older').map((d) => `${d.node.text}:${d.reminder.id}`),
    ['A:past'],
  );
});

test('upcoming reminders: future only, soonest first, limited', () => {
  const doc = docWithReminders();
  assert.deepEqual(upcomingReminders(doc, NOW).map((u) => u.reminder.id), ['soon', 'future']);
  assert.deepEqual(upcomingReminders(doc, NOW, 1).map((u) => u.reminder.id), ['soon']);
});

test('datetime-local conversion round-trips in local time', () => {
  const local = '2026-11-12T09:30';
  const stored = localInputToIso(local)!;
  assert.equal(isoToLocalInput(stored), local);
  assert.equal(localInputToIso(''), null);
  assert.equal(localInputToIso('garbage'), null);
});
