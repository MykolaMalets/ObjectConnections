// Google Drive storage (extension google.drive).
//
// Works with the drive.file scope: the app sees only files it created and files
// the user chose in the Google Picker, never the rest of the Drive. New maps go
// to the folder "ObjectConnections" in My Drive, which the app creates on first save.

import type { Extension } from '../api.ts';
import type { FileRef, StorageProvider } from '../../storage/provider.ts';
import { FILE_EXTENSION } from '../../storage/provider.ts';
import { promptDialog } from '../../ui/dialogs.tsx';
import { SignInRequired, accessToken, forgetToken, googleConfig, loadPicker, preloadSignIn } from './auth.ts';

export const DRIVE_PROVIDER_ID = 'google.drive';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const MAP_MIME = 'application/json';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'ObjectConnections';
const FOLDER_KEY = 'google.drive:folder';
/** Outside changes are looked for at most this often per file; the editor polls more often. */
const VERSION_CHECK_MS = 10_000;

/** ref.handle of this provider. `id` is empty until the first save creates the file. */
interface DriveHandle {
  id: string;
}

const handleOf = (ref: FileRef) => ref.handle as DriveHandle;

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken([SCOPE], false);
  const response = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    forgetToken();
    throw new SignInRequired();
  }
  if (!response.ok) throw new Error(await describeError(response));
  return response;
}

async function describeError(response: Response): Promise<string> {
  if (response.status === 404) return 'файл не найден на Google Диске или приложению не дан к нему доступ';
  let detail = '';
  try {
    detail = ((await response.json()) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    // Not JSON; the status is enough.
  }
  return `Google Диск ответил ошибкой ${response.status}${detail ? `: ${detail}` : ''}`;
}

const lastVersion = new Map<string, { at: number; version: string }>();

function remember(id: string, version: string): string {
  lastVersion.set(id, { at: Date.now(), version });
  return version;
}

/** Id of the app's folder, created when missing. */
async function appFolder(): Promise<string> {
  const known = localStorage.getItem(FOLDER_KEY);
  if (known) {
    const response = await call(`${FILES}/${known}?fields=id,trashed`).catch(() => null);
    if (response && !((await response.json()) as { trashed?: boolean }).trashed) return known;
  }
  const query = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`);
  const found = (await (await call(`${FILES}?q=${query}&fields=files(id)&spaces=drive`)).json()) as { files: { id: string }[] };
  let id = found.files[0]?.id;
  if (!id) {
    const created = await call(`${FILES}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    id = ((await created.json()) as { id: string }).id;
  }
  localStorage.setItem(FOLDER_KEY, id);
  return id;
}

async function create(name: string, text: string): Promise<{ id: string; version: string }> {
  const boundary = `oc-${crypto.randomUUID()}`;
  const metadata = { name, mimeType: MAP_MIME, parents: [await appFolder()] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${MAP_MIME}; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
  const response = await call(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return (await response.json()) as { id: string; version: string };
}

interface PickerResult {
  action: string;
  docs?: { id: string; name: string }[];
}

/** Shows the Google Picker; resolves with the chosen file or null. */
async function pick(token: string): Promise<{ id: string; name: string } | null> {
  const config = googleConfig()!;
  await loadPicker();
  // The Picker library has no published types; this is the part of it used here.
  const picker = (window as unknown as { google: { picker: any } }).google.picker;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true).setMode(picker.DocsViewMode.LIST);
    new picker.PickerBuilder()
      .addView(view)
      .setTitle('Карта на Google Диске')
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback((data: PickerResult) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0];
          resolve(doc ? { id: doc.id, name: doc.name } : null);
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}

export const driveProvider: StorageProvider = {
  id: DRIVE_PROVIDER_ID,
  title: 'Google Диск',
  canAutosave: true,

  async pickOpen() {
    const file = await pick(await accessToken([SCOPE], true));
    return file && { provider: DRIVE_PROVIDER_ID, name: file.name, handle: { id: file.id } satisfies DriveHandle };
  },

  async pickSave(suggestedName) {
    await accessToken([SCOPE], true);
    let name = (await promptDialog(`Имя файла (папка «${FOLDER_NAME}» на Google Диске)`, suggestedName))?.trim();
    if (!name) return null;
    if (!name.endsWith(FILE_EXTENSION)) name += FILE_EXTENSION;
    return { provider: DRIVE_PROVIDER_ID, name, handle: { id: '' } satisfies DriveHandle };
  },

  async read(ref) {
    const { id } = handleOf(ref);
    const meta = (await (await call(`${FILES}/${id}?fields=version`)).json()) as { version: string };
    const text = await (await call(`${FILES}/${id}?alt=media`)).text();
    return { text, version: remember(id, meta.version) };
  },

  async version(ref) {
    const { id } = handleOf(ref);
    if (!id) return '';
    const cached = lastVersion.get(id);
    if (cached && Date.now() - cached.at < VERSION_CHECK_MS) return cached.version;
    const meta = (await (await call(`${FILES}/${id}?fields=version`)).json()) as { version: string };
    return remember(id, meta.version);
  },

  async write(ref, text) {
    const handle = handleOf(ref);
    if (!handle.id) {
      const created = await create(ref.name, text);
      handle.id = created.id;
      return { version: remember(created.id, created.version) };
    }
    const response = await call(`${UPLOAD}/${handle.id}?uploadType=media&fields=version`, {
      method: 'PATCH',
      headers: { 'Content-Type': `${MAP_MIME}; charset=UTF-8` },
      body: text,
    });
    return { version: remember(handle.id, ((await response.json()) as { version: string }).version) };
  },

  async authorize() {
    await accessToken([SCOPE], true);
    return true;
  },

  async same(a, b) {
    return !!handleOf(a).id && handleOf(a).id === handleOf(b).id;
  },
};

/** Registered only when the build has a Google client id (see googleConfig). */
export const googleDriveExtension: Extension = {
  id: 'google.drive',
  name: 'Google Диск',
  activate(ctx) {
    if (!googleConfig()) return;
    preloadSignIn();
    ctx.storage.register(driveProvider);
  },
};
