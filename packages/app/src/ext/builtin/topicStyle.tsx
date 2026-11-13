// "Оформление" panel: colour, markers and labels of the selected topic.

import type { MapNode, Op } from '@oc/core';
import { useRef } from 'react';
import { docLabels } from '../../state/search.ts';
import { MARKER_GROUPS, toggleMarker } from '../../view/markers.ts';
import { TOPIC_COLORS, isLight } from '../../view/style.ts';
import type { EditorApi, Extension } from '../api.ts';

/** Applies a change to every selected topic as one undo step. */
function patchAll(editor: EditorApi, nodes: MapNode[], patchOf: (node: MapNode) => Record<string, unknown>, label: string): void {
  editor.apply(
    nodes.map((node) => ({ t: 'patchNode', id: node.id, patch: patchOf(node) }) as Op),
    label,
  );
}

function setColor(editor: EditorApi, nodes: MapNode[], color: string | null): void {
  patchAll(
    editor,
    nodes,
    (node) => {
      const { color: _old, ...rest } = node.style ?? {};
      const style = color ? { ...rest, color } : rest;
      return { style: Object.keys(style).length ? style : null };
    },
    color ? 'Цвет темы' : 'Убрать цвет',
  );
}

const cleanLabels = (labels: string[]) => [...new Set(labels.map((l) => l.trim().replace(/^#/, '')).filter(Boolean))];

function addLabels(editor: EditorApi, nodes: MapNode[], added: string[]): void {
  patchAll(editor, nodes, (node) => ({ labels: cleanLabels([...(node.labels ?? []), ...added]) }), 'Добавить метку');
}

function removeLabel(editor: EditorApi, nodes: MapNode[], label: string): void {
  patchAll(
    editor,
    nodes,
    (node) => {
      const rest = (node.labels ?? []).filter((l) => l !== label);
      return { labels: rest.length ? rest : null };
    },
    'Убрать метку',
  );
}

function TopicStylePanel({ editor }: { editor: EditorApi }) {
  const input = useRef<HTMLInputElement>(null);
  const doc = editor.doc;
  const nodes = doc ? editor.selectedIds.map((id) => doc.nodes[id]!).filter(Boolean) : [];
  const node = nodes[0];
  if (!doc || !node) return <p className="hint">Выберите тему.</p>;
  // The panel shows the primary topic; changes go to every selected one.
  const color = typeof node.style?.color === 'string' ? node.style.color : null;
  const labels = node.labels ?? [];
  const others = docLabels(doc).filter((l) => !labels.includes(l));

  const addTyped = () => {
    const typed = cleanLabels(input.current?.value.split(',') ?? []);
    if (typed.length) addLabels(editor, nodes, typed);
    if (input.current) input.current.value = '';
  };

  return (
    <>
      <p className="hint">{nodes.length > 1 ? `Выбрано тем: ${nodes.length}. Изменения — для всех.` : `Тема «${node.text}».`}</p>

      <h3>Цвет</h3>
      <div className="swatches">
        <button className={color === null ? 'swatch none pressed' : 'swatch none'} title="Без цвета" onClick={() => setColor(editor, nodes, null)}>
          ∅
        </button>
        {TOPIC_COLORS.map((c) => (
          <button
            key={c}
            className={c === color ? 'swatch pressed' : 'swatch'}
            style={{ background: c, color: isLight(c) ? '#1f2733' : '#fff' }}
            title={c}
            aria-label={`Цвет ${c}`}
            onClick={() => setColor(editor, nodes, c)}
          >
            {c === color ? '✓' : ''}
          </button>
        ))}
      </div>

      <h3>Маркеры</h3>
      {MARKER_GROUPS.map((group) => (
        <div key={group.id} className="markers">
          {group.markers.map((m) => {
            const on = node.markers?.includes(m.id) ?? false;
            return (
              <button
                key={m.id}
                className={on ? 'marker pressed' : 'marker'}
                title={m.title}
                aria-label={m.title}
                aria-pressed={on}
                onClick={() =>
                  // Whether the marker is switched on or off follows the primary topic.
                  patchAll(
                    editor,
                    nodes,
                    (n) => {
                      const has = n.markers?.includes(m.id) ?? false;
                      const next = has === on ? toggleMarker(n.markers, m.id) : [...(n.markers ?? [])];
                      return { markers: next.length ? next : null };
                    },
                    on ? 'Убрать маркер' : 'Поставить маркер',
                  )
                }
              >
                {m.glyph}
              </button>
            );
          })}
        </div>
      ))}

      <h3>Метки</h3>
      <div className="row">
        {labels.map((l) => (
          <span key={l} className="chip">
            #{l}
            <button
              className="icon"
              title="Убрать метку"
              onClick={() => removeLabel(editor, nodes, l)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        ref={input}
        type="text"
        placeholder="Новая метка (через запятую — несколько)"
        onKeyDown={(e) => {
          if (e.key === 'Enter') addTyped();
        }}
      />
      <button onClick={addTyped}>Добавить метку</button>
      {others.length > 0 && (
        <>
          <p className="hint">Метки этой карты:</p>
          <div className="row">
            {others.map((l) => (
              <button key={l} className="chip" onClick={() => addLabels(editor, nodes, [l])}>
                #{l}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export const topicStyleExtension: Extension = {
  id: 'builtin.topic-style',
  name: 'Оформление темы',
  activate(ctx) {
    ctx.panels.register({ id: 'topic-style', title: 'Оформление', render: (editor) => <TopicStylePanel editor={editor} /> });
  },
};
