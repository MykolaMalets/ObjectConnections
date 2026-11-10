import type { EditorApi, Extension } from '../api.ts';

function NotesPanel({ editor }: { editor: EditorApi }) {
  const id = editor.selection;
  const node = id ? editor.doc?.nodes[id] : undefined;
  if (!id || !node) return <p className="hint">Выберите тему, чтобы увидеть её заметку.</p>;
  const notes = node.notes ?? '';
  return (
    <>
      <p className="hint">Заметка к теме «{node.text}». Сохраняется при выходе из поля.</p>
      <textarea
        // Remount when another node is selected or the note changes underneath (undo, agent edits).
        key={`${id}|${notes}`}
        className="notes"
        defaultValue={notes}
        placeholder="Текст заметки (Markdown)"
        onBlur={(e) => {
          const value = e.currentTarget.value;
          if (value !== notes) {
            editor.apply([{ t: 'patchNode', id, patch: { notes: value || null } }], 'Изменить заметку');
          }
        }}
      />
    </>
  );
}

export const notesExtension: Extension = {
  id: 'builtin.notes',
  name: 'Заметки',
  activate(ctx) {
    ctx.panels.register({ id: 'notes', title: 'Заметка', render: (editor) => <NotesPanel editor={editor} /> });
  },
};
