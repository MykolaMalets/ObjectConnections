// Opening, saving and re-reading map files through a StorageProvider.

import type { Doc } from '@oc/core';
import { serializeDoc, validate } from '@oc/core';
import type { ExtensionHost } from '../ext/host.ts';
import type { FileRef, StorageProvider } from '../storage/provider.ts';
import { FILE_EXTENSION } from '../storage/provider.ts';
import { alertDialog, choiceDialog, confirmDialog } from '../ui/dialogs.tsx';
import { Session } from './store.ts';

const displayName = (fileName: string) =>
  fileName.endsWith(FILE_EXTENSION) ? fileName.slice(0, -FILE_EXTENSION.length) : fileName;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Parses file content. Returns the document or the reasons it cannot be used. */
function parseDoc(text: string): { doc: Doc } | { problems: string[] } {
  if (!text.trim()) return { problems: ['файл пустой — вероятно, сохранение в него не удалось'] };
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

/** With several storages, asks the user which one to use. Null when cancelled. */
async function chooseStorage(host: ExtensionHost, question: string): Promise<StorageProvider | null> {
  const providers = [...host.storage.values()];
  if (providers.length <= 1) return host.defaultStorage();
  const index = await choiceDialog(
    question,
    providers.map((p) => p.title),
  );
  return index === null ? null : providers[index]!;
}

export async function openFile(host: ExtensionHost): Promise<void> {
  try {
    const provider = await chooseStorage(host, 'Откуда открыть карту?');
    const ref = await provider?.pickOpen();
    if (ref) await openRef(host, ref);
  } catch (error) {
    void alertDialog(`Не удалось открыть файл: ${messageOf(error)}`);
  }
}

/**
 * Files the operating system hands to the installed app (double-click on an
 * .ocmap file, "Open with"). See file_handlers in public/manifest.webmanifest.
 */
export function handleLaunchedFiles(host: ExtensionHost): void {
  const launchQueue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  if (!launchQueue || !host.storage.has('local')) return;
  launchQueue.setConsumer(async (params) => {
    for (const handle of params.files) {
      if (handle.kind !== 'file') continue;
      await openRef(host, { provider: 'local', name: handle.name, handle }).catch((error: unknown) =>
        alertDialog(`Не удалось открыть «${handle.name}»: ${messageOf(error)}`),
      );
    }
  });
}

interface LaunchQueue {
  setConsumer(consumer: (params: { files: FileSystemHandle[] }) => void | Promise<void>): void;
}

async function openRef(host: ExtensionHost, ref: FileRef): Promise<void> {
  const ws = host.ws;
  const provider = host.storageFor(ref);
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
      const storage = await chooseStorage(host, `Где сохранить «${session.name}»?`);
      const ref = await storage?.pickSave(session.name + FILE_EXTENSION);
      if (!ref) return;
      session.file = ref;
      session.name = displayName(ref.name);
      session.fileVersion = '';
    }
    const provider = host.storageFor(session.file);
    if (auto && !provider.canAutosave) return;
    // A manual save runs inside a user gesture, the only moment access can be requested.
    // The answer is advisory: some browsers report "not granted" for a file that is
    // writable, so the write below is attempted either way and reports the real error.
    if (!auto) await provider.authorize?.(session.file).catch(() => false);
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
    const blocked = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
    session.saveError = blocked
      ? 'браузер запретил запись в файл. Во встроенном браузере Claude запись не работает — откройте редактор в Chrome или Edge'
      : messageOf(error);
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
    // Signed out of a cloud storage: keep the version, so the save after signing in still detects outside changes.
    if (error instanceof Error && error.name === 'SignInRequired') return;
    // Access was lost: stop checking until the next successful save sets a version again.
    console.warn('sync from storage stopped', error);
    session.fileVersion = '';
  }
}
