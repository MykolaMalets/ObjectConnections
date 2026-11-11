// In-app dialogs. Native alert/confirm/prompt are not used anywhere: embedded
// browsers and installed PWAs may suppress them, and they block the page.

import { useEffect, useRef, useSyncExternalStore } from 'react';

interface Request {
  kind: 'alert' | 'confirm' | 'prompt';
  message: string;
  okLabel: string;
  cancelLabel: string;
  initial: string;
  resolve: (value: string | boolean | null) => void;
}

const queue: Request[] = [];
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

function open(kind: Request['kind'], message: string, okLabel: string, initial = '', cancelLabel = 'Отмена'): Promise<string | boolean | null> {
  return new Promise((resolve) => {
    queue.push({ kind, message, okLabel, cancelLabel, initial, resolve });
    changed();
  });
}

function close(value: string | boolean | null): void {
  queue.shift()?.resolve(value);
  changed();
}

export async function alertDialog(message: string): Promise<void> {
  await open('alert', message, 'OK');
}

export async function confirmDialog(message: string, okLabel = 'OK', cancelLabel = 'Отмена'): Promise<boolean> {
  return (await open('confirm', message, okLabel, '', cancelLabel)) === true;
}

/** Resolves with the entered text, or null when cancelled. */
export async function promptDialog(message: string, initial = ''): Promise<string | null> {
  const value = await open('prompt', message, 'OK', initial);
  return typeof value === 'string' ? value : null;
}

/** Renders the dialog at the front of the queue. Mount once, at the app root. */
export function DialogHost() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
  const request = queue[0];
  const input = useRef<HTMLInputElement>(null);
  const ok = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    if (request.kind === 'prompt') input.current?.select();
    else ok.current?.focus();
  }, [request]);

  if (!request) return null;
  const accept = () => close(request.kind === 'prompt' ? (input.current?.value ?? '') : true);
  const cancel = () => close(request.kind === 'alert' ? true : request.kind === 'confirm' ? false : null);

  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') cancel();
        else if (e.key === 'Enter') accept();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <p>{request.message}</p>
        {request.kind === 'prompt' && <input ref={input} defaultValue={request.initial} />}
        <div className="dialog-buttons">
          {request.kind !== 'alert' && <button onClick={cancel}>{request.cancelLabel}</button>}
          <button ref={ok} className="primary" onClick={accept}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
