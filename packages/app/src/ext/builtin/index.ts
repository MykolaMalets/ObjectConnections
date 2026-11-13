// Extensions compiled into the app. To add one, import it and append it here.
// Order matters only for storage: the first registered provider is the default.

import { downloadFs, localFs, hasFileSystemAccess } from '../../storage/localFs.ts';
import type { Extension } from '../api.ts';
import { googleCalendarExtension } from '../google/calendar.ts';
import { googleDriveExtension } from '../google/drive.ts';
import { exportFreeMindExtension } from './exportFreeMind.ts';
import { importFreeMindExtension } from './importFreeMind.ts';
import { exportMarkdownExtension } from './exportMarkdown.ts';
import { exportPdfExtension } from './exportPdf.ts';
import { exportWordExtension } from './exportWord.ts';
import { exportSvgExtension } from './exportSvg.ts';
import { attributesExtension } from './attributes.tsx';
import { notesExtension } from './notes.tsx';
import { promptExtension } from './prompt.tsx';
import { remindersExtension } from './reminders.tsx';
import { topicStyleExtension } from './topicStyle.tsx';

const localFilesExtension: Extension = {
  id: 'builtin.local-files',
  name: 'Локальные файлы',
  activate(ctx) {
    ctx.storage.register(hasFileSystemAccess() ? localFs : downloadFs);
  },
};

export const builtinExtensions: Extension[] = [
  localFilesExtension,
  googleDriveExtension,
  googleCalendarExtension,
  exportMarkdownExtension,
  exportWordExtension,
  exportPdfExtension,
  exportFreeMindExtension,
  importFreeMindExtension,
  exportSvgExtension,
  notesExtension,
  topicStyleExtension,
  attributesExtension,
  promptExtension,
  remindersExtension,
];
