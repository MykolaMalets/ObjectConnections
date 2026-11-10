// Opening, saving and re-reading map files through a StorageProvider.

import type { Doc } from '@oc/core';
import { serializeDoc, validate } from '@oc/core';
import type { ExtensionHost } from '../ext/host.ts';
import { FILE_EXTENSION } from '../storage/provider.ts';
import { alertDialog, confirmDialog } from '../ui/dialogs.tsx';
import { Session } from './store.ts';

const displayName = (fileName: string) =>
  fileName.endsWith(FILE_EXTENSION) ? fileName.slice(0, -FILE_EXTENSION.length) : fileName;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  const ws = host.ws;
  try {
    const provider = host.defaultStorage();
    const ref = await provider.pickOpen();
    if (!ref) return;
    // One file, one tab: two tabs of the same file would overwrite each other's changes.
    for (const open of ws.sessions) {
      if (open.file?.provider === ref.provider && (await provider.same?.(open.file, ref))) {
        ws.activate(open);
        void alertDialog(`Файл «${ref.name}» уже открыт — переключаю на его вкладку.`);
        return;
      }
    }
    const { text, version } = await provider.read(ref);
    const parsed = parseDoc(text);
    if ('problems' in parsed) {
      void alertDialog(`Файл «${ref.name}» не открыт: ${parsed.problems.slice(0, 5).join('; ')}`);
      return;
    }
    const session = new Session(parsed.doc, displayName(ref.name));
    session.file = ref;
    session.fileVersion = version;
    ws.add(session);
  } catch (error) {
    void alertDialog(`Не удалось открыть файл: ${messageOf(error)}`);
  }
}

/**
 * Saves the session. With `auto`, never asks the user anything: a session
 * without a file is skipped, an outside change pauses autosave instead of
 * overwriting, and after a failure autosave waits for a manual save.
 */
export async function saveFile(host: ExtensionHost, session: Session, auto = false): Promise<void> {
  const ws = host.ws;
  if (session.saving) return;
  if (auto && (!session.file || session.conflict || session.saveError)) return;
  session.saving = true;
  try {
    if (!session.file) {
      const ref = await host.defaultStorage().pickSave(session.name + FILE_EXTENSION);
      if (!ref) return;
      session.file = ref;
      session.name = displayName(ref.name);
      session.fileVersion = '';
    }
    const provider = host.storageFor(session.file);
    if (auto && !provider.canAutosave) return;
    // A manual save runs inside a user gesture, the only moment access can be requested.
    if (!auto && provider.authorize && !(await provider.authorize(session.file))) {
      throw new Error('нет разрешения на запись в этот файл');
    }
    if (session.fileVersion && (await provider.version(session.file)) !== session.fileVersion) {
      session.conflict = true;
      const overwrite =
        !auto &&
        (await confirmDialog(
          `Файл «${session.file.name}» изменён вне редактора. Перезаписать его текущей версией?`,
          'Перезаписать',
        ));
      if (!overwrite) return;
    }
    const history = session.history;
    const revision = history.revision;
    const { version } = await provider.write(session.file, serializeDoc(session.doc));
    session.fileVersion = version;
    if (session.history === history) session.savedRevision = revision;
    session.conflict = false;
    session.saveError = null;
  } catch (error) {
    session.saveError = messageOf(error);
    if (!auto) void alertDialog(`Не удалось сохранить «${session.name}»: ${session.saveError}`);
  } finally {
    session.saving = false;
    ws.notify();
  }
}

/**
 * Picks up changes made to the file outside the editor (an agent, another
 * device). Without unsaved edits the document is reloaded silently; with
 * them the session is marked as conflicting and autosave pauses.
 */
export async function syncFromStorage(host: ExtensionHost, session: Session): Promise<void> {
  // No known version means the storage cannot be compared against (see provider.write).
  if (!session.file || !session.fileVersion || session.saving || session.editing || session.saveError) return;
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
    // Access was lost: stop checking until the next successful save sets a version again.
    console.warn('sync from storage stopped', error);
    session.fileVersion = '';
  }
}
