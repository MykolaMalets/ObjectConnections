// Search bar (Ctrl+F): marks every found topic on the map; Enter and the arrows
// go through them, opening collapsed branches and switching sheets as needed.

import type { Id } from '@oc/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchMatch } from '../state/search.ts';
import { docLabels, searchDoc } from '../state/search.ts';
import type { Session, Workspace } from '../state/store.ts';
import { revealNode, setHighlights } from '../state/store.ts';

const FIELD_NAMES: Record<SearchMatch['field'], string> = {
  text: '',
  notes: 'в заметке',
  label: 'в метке',
  attr: 'в атрибуте',
  link: 'в ссылке',
};

export function SearchBar({ ws, session, onClose }: { ws: Workspace; session: Session; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [attrId, setAttrId] = useState('');
  /** Position in the matches; -1 until the user steps to the first one. */
  const [index, setIndex] = useState(-1);

  const doc = session.doc;
  const revision = `${session.epoch}|${session.history.revision}`;
  const labels = useMemo(() => docLabels(doc), [doc, revision]);
  const attrDefs = Object.values(doc.attrDefs);
  const matches = useMemo(
    () => searchDoc(doc, { query, label: label || undefined, attrId: attrId || undefined }),
    [doc, revision, query, label, attrId],
  );

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIndex(-1), [query, label, attrId, session]);

  // Marks follow the matches; they disappear with the bar or when another tab is shown.
  const ids = matches.map((m) => m.id).join(' ');
  useEffect(() => {
    setHighlights(ws, session, ids ? (ids.split(' ') as Id[]) : null);
    return () => setHighlights(ws, session, null);
  }, [ws, session, ids]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    const next = index < 0 ? (delta > 0 ? 0 : matches.length - 1) : (index + delta + matches.length) % matches.length;
    setIndex(next);
    revealNode(ws, matches[next]!.id);
  };

  const current = index >= 0 ? matches[index] : undefined;
  const status =
    matches.length === 0
      ? query.trim() || label || attrId
        ? 'не найдено'
        : ''
      : current
        ? `${index + 1} из ${matches.length}${FIELD_NAMES[current.field] ? ` · ${FIELD_NAMES[current.field]}` : ''}`
        : `найдено: ${matches.length}`;

  return (
    <div
      className="search-bar"
      onKeyDown={(e) => {
        // Keys typed here belong to the search, not to the map's shortcuts.
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
        else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          step(-1);
        }
      }}
    >
      <input
        ref={input}
        type="search"
        placeholder="Найти в карте"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        enterKeyHint="search"
      />
      {labels.length > 0 && (
        <select value={label} onChange={(e) => setLabel(e.currentTarget.value)} title="Только темы с меткой">
          <option value="">Любая метка</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
      {attrDefs.length > 0 && (
        <select value={attrId} onChange={(e) => setAttrId(e.currentTarget.value)} title="Искать в значении атрибута">
          <option value="">Все поля</option>
          {attrDefs.map((def) => (
            <option key={def.id} value={def.id}>
              {def.name}
            </option>
          ))}
        </select>
      )}
      <span className="search-status">{status}</span>
      <button disabled={matches.length === 0} onClick={() => step(-1)} title="Предыдущая (Shift+Enter)" aria-label="Предыдущая">
        ↑
      </button>
      <button disabled={matches.length === 0} onClick={() => step(1)} title="Следующая (Enter)" aria-label="Следующая">
        ↓
      </button>
      <button onClick={onClose} title="Закрыть (Esc)" aria-label="Закрыть поиск">
        ×
      </button>
    </div>
  );
}
