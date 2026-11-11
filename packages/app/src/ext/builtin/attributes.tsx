// Attributes panel: user-defined typed fields of topics. Definitions belong to
// the document; values belong to topics (see docs/FORMAT.md, AttrDef).

import type { AttrDef, AttrType, AttrValue, Id } from '@oc/core';
import { newId } from '@oc/core';
import { confirmDialog, promptDialog } from '../../ui/dialogs.tsx';
import type { EditorApi, Extension } from '../api.ts';

const TYPES: { value: AttrType; label: string }[] = [
  { value: 'text', label: 'текст' },
  { value: 'number', label: 'число' },
  { value: 'date', label: 'дата' },
  { value: 'bool', label: 'да/нет' },
  { value: 'url', label: 'ссылка' },
  { value: 'select', label: 'один из списка' },
  { value: 'multiselect', label: 'несколько из списка' },
];

/** Converts an input's text to a stored value; null removes the value. */
export function parseAttrValue(def: AttrDef, raw: string): AttrValue | null {
  const value = raw.trim();
  if (!value) return null;
  if (def.type === 'number') {
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

function ValueInput({ editor, id, def }: { editor: EditorApi; id: Id; def: AttrDef }) {
  const current = editor.doc!.nodes[id]!.attrs?.[def.id];
  const set = (value: AttrValue | null) =>
    editor.apply([{ t: 'setAttr', id, defId: def.id, value }], `Атрибут «${def.name}»`);

  if (def.type === 'bool') {
    return <input type="checkbox" checked={current === true} onChange={(e) => set(e.currentTarget.checked ? true : null)} />;
  }
  if (def.type === 'select') {
    return (
      <select value={typeof current === 'string' ? current : ''} onChange={(e) => set(e.currentTarget.value || null)}>
        <option value="">—</option>
        {(def.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (def.type === 'multiselect') {
    const chosen = Array.isArray(current) ? current : [];
    return (
      <span className="choices">
        {(def.options ?? []).map((o) => (
          <label key={o}>
            <input
              type="checkbox"
              checked={chosen.includes(o)}
              onChange={(e) => {
                const next = e.currentTarget.checked ? [...chosen, o] : chosen.filter((x) => x !== o);
                set(next.length ? next : null);
              }}
            />
            {o}
          </label>
        ))}
      </span>
    );
  }
  const shown = current === undefined ? '' : String(current);
  return (
    <input
      key={`${id}|${shown}`}
      type={def.type === 'date' ? 'date' : def.type === 'number' ? 'text' : def.type === 'url' ? 'url' : 'text'}
      inputMode={def.type === 'number' ? 'decimal' : undefined}
      defaultValue={shown}
      onBlur={(e) => {
        const value = parseAttrValue(def, e.currentTarget.value);
        if ((value ?? '') !== (current ?? '')) set(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

async function addDefinition(editor: EditorApi, type: AttrType): Promise<void> {
  const name = (await promptDialog('Название атрибута'))?.trim();
  if (!name) return;
  const def: AttrDef = { id: newId(), name, type };
  if (type === 'select' || type === 'multiselect') {
    const raw = await promptDialog('Варианты через запятую');
    const options = [...new Set((raw ?? '').split(',').map((o) => o.trim()).filter(Boolean))];
    if (options.length === 0) return;
    def.options = options;
  }
  editor.apply([{ t: 'putAttrDef', def }], 'Новый атрибут');
}

async function removeDefinition(editor: EditorApi, def: AttrDef): Promise<void> {
  const used = Object.values(editor.doc!.nodes).filter((n) => n.attrs?.[def.id] !== undefined).length;
  const ask = used
    ? `Удалить атрибут «${def.name}»? Его значения у тем (${used}) тоже удалятся. Это можно отменить через Ctrl+Z.`
    : `Удалить атрибут «${def.name}»?`;
  if (await confirmDialog(ask, 'Удалить')) editor.apply([{ t: 'removeAttrDef', id: def.id }], 'Удалить атрибут');
}

function AttributesPanel({ editor }: { editor: EditorApi }) {
  const doc = editor.doc;
  if (!doc) return null;
  const id = editor.selection;
  const node = id ? doc.nodes[id] : undefined;
  const defs = Object.values(doc.attrDefs).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <p className="hint">
        {node ? `Значения для темы «${node.text}».` : 'Выберите тему, чтобы задать значения.'} Атрибуты общие для всего файла.
      </p>
      {defs.length === 0 && <p className="hint">Атрибутов пока нет.</p>}
      {defs.map((def) => (
        <div key={def.id} className="attr">
          <div className="attr-head">
            <span title={TYPES.find((t) => t.value === def.type)?.label}>{def.name}</span>
            <button className="icon" title="Удалить атрибут" onClick={() => void removeDefinition(editor, def)}>
              ×
            </button>
          </div>
          {node && id && <ValueInput editor={editor} id={id} def={def} />}
        </div>
      ))}
      <select
        value=""
        onChange={(e) => {
          const type = e.currentTarget.value as AttrType;
          e.currentTarget.blur();
          if (type) void addDefinition(editor, type);
        }}
      >
        <option value="">Добавить атрибут…</option>
        {TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </>
  );
}

export const attributesExtension: Extension = {
  id: 'builtin.attributes',
  name: 'Атрибуты',
  activate(ctx) {
    ctx.panels.register({ id: 'attributes', title: 'Атрибуты', render: (editor) => <AttributesPanel editor={editor} /> });
  },
};
