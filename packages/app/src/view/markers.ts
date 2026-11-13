// Markers: small symbols shown before a topic's text. Stored in `node.markers`
// as ids, so a document stays readable without this table. Emoji are drawn by
// the system font: nothing to license. No DOM: shared by the canvas, exports and tests.

import type { MapNode } from '@oc/core';

export interface MarkerGroup {
  id: string;
  title: string;
  /** Only one marker of the group at a time (a topic has one priority, one status). */
  exclusive: boolean;
  markers: { id: string; glyph: string; title: string }[];
}

export const MARKER_GROUPS: MarkerGroup[] = [
  {
    id: 'priority',
    title: 'Приоритет',
    exclusive: true,
    markers: [1, 2, 3, 4, 5].map((n) => ({ id: `priority-${n}`, glyph: `${n}️⃣`, title: `Приоритет ${n}` })),
  },
  {
    id: 'status',
    title: 'Статус',
    exclusive: true,
    markers: [
      { id: 'status-todo', glyph: '⬜', title: 'Сделать' },
      { id: 'status-doing', glyph: '🔄', title: 'В работе' },
      { id: 'status-done', glyph: '✔️', title: 'Готово' },
      { id: 'status-cancelled', glyph: '❌', title: 'Отменено' },
      { id: 'status-waiting', glyph: '⏸️', title: 'Ждёт' },
    ],
  },
  {
    id: 'symbol',
    title: 'Значки',
    exclusive: false,
    markers: [
      { id: 'flag', glyph: '🚩', title: 'Флажок' },
      { id: 'star', glyph: '⭐', title: 'Звезда' },
      { id: 'idea', glyph: '💡', title: 'Идея' },
      { id: 'question', glyph: '❓', title: 'Вопрос' },
      { id: 'important', glyph: '❗', title: 'Важно' },
      { id: 'warning', glyph: '⚠️', title: 'Внимание' },
      { id: 'heart', glyph: '❤️', title: 'Нравится' },
      { id: 'person', glyph: '👤', title: 'Человек' },
      { id: 'date', glyph: '📅', title: 'Дата' },
      { id: 'money', glyph: '💰', title: 'Деньги' },
    ],
  },
];

const BY_ID = new Map(MARKER_GROUPS.flatMap((group) => group.markers.map((marker) => [marker.id, { ...marker, group }] as const)));

export const markerById = (id: string) => BY_ID.get(id);

/** Glyphs of a topic's markers in the order of the table; unknown ids are skipped. */
export function markerGlyphs(node: MapNode): string[] {
  if (!node.markers?.length) return [];
  const own = new Set(node.markers);
  return MARKER_GROUPS.flatMap((group) => group.markers.filter((m) => own.has(m.id)).map((m) => m.glyph));
}

/** Markers after switching one on or off; switching on removes the others of an exclusive group. */
export function toggleMarker(markers: readonly string[] | undefined, id: string): string[] {
  const current = [...(markers ?? [])];
  if (current.includes(id)) return current.filter((m) => m !== id);
  const group = BY_ID.get(id)?.group;
  const kept = group?.exclusive ? current.filter((m) => BY_ID.get(m)?.group !== group) : current;
  return [...kept, id];
}
