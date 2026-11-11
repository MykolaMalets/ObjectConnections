// Prompt panel: the request a topic carries for an AI agent. The agent (Claude
// Code with the ocmap skill) picks up queued prompts with `oc prompts <file>`.

import type { Id, Prompt } from '@oc/core';
import { useRef } from 'react';
import type { EditorApi, Extension } from '../api.ts';

const STATUS: Record<Prompt['status'], string> = {
  draft: 'черновик — агент его не видит',
  queued: 'в очереди — ждёт агента',
  running: 'агент работает',
  done: 'выполнено',
  error: 'ошибка',
};

const SCOPES: { value: Prompt['scope']; label: string }[] = [
  { value: 'subtree', label: 'эта тема и её ветка' },
  { value: 'node', label: 'только эта тема' },
  { value: 'sheet', label: 'весь лист' },
];

function setPrompt(editor: EditorApi, id: Id, prompt: Prompt | null, label: string): void {
  editor.apply([{ t: 'patchNode', id, patch: { prompt } }], label);
}

function PromptPanel({ editor }: { editor: EditorApi }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const id = editor.selection;
  const node = id ? editor.doc?.nodes[id] : undefined;
  if (!id || !node) return <p className="hint">Выберите тему, чтобы написать для неё задание агенту.</p>;
  const prompt = node.prompt;
  const text = prompt?.text ?? '';

  // Reads the live text and prompt: a button click can follow the textarea's blur-save in the same gesture.
  const save = (patch: Partial<Prompt>, label = 'Изменить промпт') => {
    const live = editor.doc?.nodes[id]?.prompt;
    const next: Prompt = { status: 'draft', scope: 'subtree', ...live, text: input.current?.value ?? text, ...patch };
    if (!next.text.trim()) return;
    if (patch.status && patch.status !== 'error' && patch.status !== 'done') delete next.message;
    setPrompt(editor, id, next, label);
  };

  return (
    <>
      <p className="hint">Задание агенту для темы «{node.text}». Агент читает карту и достраивает её по этому тексту.</p>
      <textarea
        // Remount when another topic is selected or the prompt changes underneath (undo, agent edits).
        ref={input}
        key={`${id}|${text}`}
        className="notes"
        defaultValue={text}
        placeholder="Например: разложи эту тему на 5–7 подтем с короткими пояснениями в заметках"
        onBlur={(e) => {
          const value = e.currentTarget.value;
          if (value === text) return;
          if (!value.trim()) setPrompt(editor, id, null, 'Убрать промпт');
          else save({ text: value });
        }}
      />
      <label className="field">
        <span>Область</span>
        <select
          value={prompt?.scope ?? 'subtree'}
          disabled={!prompt}
          onChange={(e) => save({ scope: e.currentTarget.value as Prompt['scope'] })}
        >
          {SCOPES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {/* Always present, so the buttons below do not move when the first save adds a status. */}
      <p className={prompt?.status === 'error' ? 'warning' : 'hint'}>
        Состояние: {prompt ? STATUS[prompt.status] : 'нет задания'}
        {prompt?.message ? `. ${prompt.message}` : ''}
      </p>
      {/* Buttons keep focus in the text field: they read its live value instead of waiting for its blur-save. */}
      <div className="row" onMouseDown={(e) => e.preventDefault()}>
        <button
          className="primary"
          disabled={prompt?.status === 'queued' || prompt?.status === 'running'}
          onClick={() => save({ status: 'queued' }, 'Промпт в очередь')}
        >
          {prompt?.status === 'done' || prompt?.status === 'error' ? 'Повторить' : 'В очередь'}
        </button>
        <button disabled={!prompt || prompt.status === 'draft'} onClick={() => save({ status: 'draft' }, 'Промпт в черновик')}>
          В черновик
        </button>
        <button disabled={!prompt} onClick={() => setPrompt(editor, id, null, 'Убрать промпт')}>
          Убрать
        </button>
      </div>
      <p className="hint">
        Чтобы выполнить очередь, сохраните карту и попросите Claude Code: «обработай промпты в карте {editor.fileName ?? '…'}».
        Изменения агента появятся здесь сами.
      </p>
    </>
  );
}

export const promptExtension: Extension = {
  id: 'builtin.prompt',
  name: 'Промпты для агента',
  activate(ctx) {
    ctx.panels.register({ id: 'prompt', title: 'Агент', render: (editor) => <PromptPanel editor={editor} /> });
  },
};
