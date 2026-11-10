// Opening and saving map files through a StorageProvider.

import type { Doc } from '@oc/core';
import { serializeDoc, validate } from '@oc/core';
import type { ExtensionHost } from '../ext/host.ts';
import { FILE_EXTENSION } from '../storage/provider.ts';
import { Session } from './store.ts';

const displayName = (fileName: string) =>
  fileName.endsWith(FILE_EXTENSION) ? fileName.slice(0, -FILE_EXTENSION.length) : fileName;

export async function openFile(host: ExtensionHost): Promise<void> {
  const ws = host.ws;
  const provider = host.defaultStorage();
  const ref = await provider.pickOpen();
  if (!ref) return;
  const { text, version } = await provider.read(ref);
  let doc: Doc;
  try {
    doc = JSON.parse(text) as Doc;
  } catch {
    alert(`Файл «${ref.name}» не является картой: это не JSON.`);
    return;
  }
  const problems = typeof doc === 'object' && doc !== null && doc.format === 'ocmap' ? validate(doc) : ['нет поля format: "ocmap"'];
  if (problems.length) {
    alert(`Файл «${ref.name}» повреждён и не открыт:\n${problems.slice(0, 5).join('\n')}`);
    return;
  }
  const session = new Session(doc, displayName(ref.name));
  session.file = ref;
  session.fileVersion = version;
  ws.add(session);
}

/**
 * Saves the session. With `auto`, never asks the user anything: a session
 * without a file is skipped, and an outside change pauses autosave instead
 * of overwriting.
 */
export async function saveFile(host: ExtensionHost, session: Session, auto = false): Promise<void> {
  const ws = host.ws;
  if (session.saving) return;
  if (!session.file) {
    if (auto) return;
    const ref = await host.defaultStorage().pickSave(session.name + FILE_EXTENSION);
    if (!ref) return;
    session.file = ref;
    session.name = displayName(ref.name);
    session.fileVersion = '';
  }
  const provider = host.storageFor(session.file);
  if (auto && (!provider.canAutosave || session.conflict)) return;
  session.saving = true;
  try {
    if (session.fileVersion && (await provider.version(session.file)) !== session.fileVersion) {
      session.conflict = true;
      const overwrite =
        !auto && confirm(`Файл «${session.file.name}» изменён вне редактора. Перезаписать его текущей версией?`);
      if (!overwrite) return;
    }
    const revision = session.history.revision;
    const { version } = await provider.write(session.file, serializeDoc(session.doc));
    session.fileVersion = version;
    session.savedRevision = revision;
    session.conflict = false;
  } catch (error) {
    if (!auto) alert(`Не удалось сохранить: ${error instanceof Error ? error.message : String(error)}`);
    else console.warn('autosave failed', error);
  } finally {
    session.saving = false;
    ws.notify();
  }
}
