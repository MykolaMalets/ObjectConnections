// Opening, saving and re-reading map files through a StorageProvider.

import type { Doc } from '@oc/core';
import { serializeDoc, validate } from '@oc/core';
import type { ExtensionHost } from '../ext/host.ts';
import { FILE_EXTENSION } from '../storage/provider.ts';
import { Session } from './store.ts';

const displayName = (fileName: string) =>
  fileName.endsWith(FILE_EXTENSION) ? fileName.slice(0, -FILE_EXTENSION.length) : fileName;

/** Parses file content. Returns the document or the reasons it cannot be used. */
function parseDoc(text: string): { doc: Doc } | { problems: string[] } {
  let doc: Doc;
  try {
    doc = JSON.parse(text) as Doc;
  } catch {
    return { problems: ['это не JSON'] };
  }
  if (typeof doc !== 'object' || doc === null || doc.format !== 'ocmap') {
    return { problems: ['нет поля format: "ocmap"'] };
  }
  const problems = validate(doc);
  return problems.length ? { problems } : { doc };
}

export async function openFile(host: ExtensionHost): Promise<void> {
  const provider = host.defaultStorage();
  const ref = await provider.pickOpen();
  if (!ref) return;
  const { text, version } = await provider.read(ref);
  const parsed = parseDoc(text);
  if ('problems' in parsed) {
    alert(`Файл «${ref.name}» не открыт:\n${parsed.problems.slice(0, 5).join('\n')}`);
    return;
  }
  const session = new Session(parsed.doc, displayName(ref.name));
  session.file = ref;
  session.fileVersion = version;
  host.ws.add(session);
}

/**
 * Saves the session. With `auto`, never asks the user anything: a session
 * without a file is skipped, and an outside change pauses autosave instead
 * of overwriting.
 */
export async function saveFile(host: ExtensionHost, session: Session, auto = false): Promise<void> {
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
    const history = session.history;
    const revision = history.revision;
    const { version } = await provider.write(session.file, serializeDoc(session.doc));
    session.fileVersion = version;
    if (session.history === history) session.savedRevision = revision;
    session.conflict = false;
  } catch (error) {
    if (!auto) alert(`Не удалось сохранить: ${error instanceof Error ? error.message : String(error)}`);
    else console.warn('autosave failed', error);
  } finally {
    session.saving = false;
    host.ws.notify();
  }
}

/**
 * Picks up changes made to the file outside the editor (an agent, another
 * device). Without unsaved edits the document is reloaded silently; with
 * them the session is marked as conflicting and autosave pauses.
 */
export async function syncFromStorage(host: ExtensionHost, session: Session): Promise<void> {
  if (!session.file || session.saving || session.editing) return;
  const provider = host.storageFor(session.file);
  try {
    if ((await provider.version(session.file)) === session.fileVersion) return;
    if (session.dirty) {
      if (!session.conflict) {
        session.conflict = true;
        host.ws.notify();
      }
      return;
    }
    const { text, version } = await provider.read(session.file);
    const parsed = parseDoc(text);
    // A half-written or broken file is ignored; the next check tries again.
    if ('problems' in parsed || session.dirty || session.saving) return;
    session.replaceDoc(parsed.doc);
    session.fileVersion = version;
    session.conflict = false;
    host.ws.notify();
  } catch (error) {
    console.warn('sync from storage failed', error);
  }
}
