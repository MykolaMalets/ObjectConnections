// Local files. Uses the File System Access API (Chrome, Edge) when present and
// falls back to upload/download elsewhere.

import type { FileContent, StorageProvider } from './provider.ts';
import { FILE_EXTENSION } from './provider.ts';

interface PickerWindow {
  showOpenFilePicker?: (options: object) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
}

/** Permission methods of file handles; not yet in TypeScript's DOM library. */
interface PermissionHandle {
  queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

const TYPES =[{ description: 'ObjectConnections map', accept: { 'application/json': [FILE_EXTENSION] } }];

const picker = (): PickerWindow => window as unknown as PickerWindow;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export const localFs: StorageProvider = {
  id: 'local',
  canAutosave: true,

  async pickOpen() {
    try {
      const [handle] = await picker().showOpenFilePicker!({ types: TYPES });
      return handle ? { provider: 'local', name: handle.name, handle } : null;
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  },

  async pickSave(suggestedName) {
    try {
      const handle = await picker().showSaveFilePicker!({ types: TYPES, suggestedName });
      return { provider: 'local', name: handle.name, handle };
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
  },

  async read(ref): Promise<FileContent> {
    const file = await (ref.handle as FileSystemFileHandle).getFile();
    return { text: await file.text(), version: String(file.lastModified) };
  },

  async version(ref) {
    return String((await (ref.handle as FileSystemFileHandle).getFile()).lastModified);
  },

  async write(ref, text) {
    const handle = ref.handle as FileSystemFileHandle;
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    // The write is done; failing to read the timestamp back must not report it as failed.
    const version = await handle.getFile().then(
      (file) => String(file.lastModified),
      () => '',
    );
    return { version };
  },

  async authorize(ref) {
    const handle = ref.handle as PermissionHandle;
    if (!handle.queryPermission || !handle.requestPermission) return true;
    const options = { mode: 'readwrite' as const };
    if ((await handle.queryPermission(options)) === 'granted') return true;
    return (await handle.requestPermission(options)) === 'granted';
  },

  async same(a, b) {
    return (a.handle as FileSystemFileHandle).isSameEntry(b.handle as FileSystemFileHandle);
  },
};

/** Fallback for browsers without the File System Access API: open by upload, save by download. */
export const downloadFs: StorageProvider = {
  id: 'download',
  canAutosave: false,

  pickOpen() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = `${FILE_EXTENSION},application/json`;
      input.onchange = () => {
        const file = input.files?.[0];
        resolve(file ? { provider: 'download', name: file.name, handle: file } : null);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },

  async pickSave(suggestedName) {
    return { provider: 'download', name: suggestedName, handle: null };
  },

  async read(ref) {
    return { text: await (ref.handle as File).text(), version: '0' };
  },

  async version() {
    return '0';
  },

  async write(ref, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = ref.name;
    link.click();
    URL.revokeObjectURL(url);
    return { version: '0' };
  },
};

export function hasFileSystemAccess(): boolean {
  return typeof picker().showOpenFilePicker === 'function';
}
