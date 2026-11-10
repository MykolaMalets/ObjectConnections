// Extension API. Everything an extension may touch is declared in this file;
// see docs/EXTENSIONS.md for the rules and a walkthrough.

import type { Doc, Id, MapNode, Op, Reminder, Sheet } from '@oc/core';
import type { ReactNode } from 'react';
import type { StorageProvider } from '../storage/provider.ts';

/** Undoes a registration. */
export type Disposable = () => void;

export interface Extension {
  /** Unique, stable, dot-separated: 'builtin.notes', 'google.drive'. Also the namespace for `ext` data. */
  id: string;
  name: string;
  /** Called once at startup. May return a cleanup function. */
  activate(ctx: ExtensionContext): void | Disposable;
}

/** Live view of the editor. Getters always reflect the active file. */
export interface EditorApi {
  readonly doc: Doc | null;
  readonly fileName: string | null;
  readonly sheet: Sheet | null;
  readonly selection: Id | null;
  /** Roots currently shown: the drill-down focus, or every map of the sheet. */
  readonly viewRoots: Id[];
  /** Applies operations to the active document as one undo step. False when rejected or no file is open. */
  apply(ops: Op[], label: string): boolean;
  /** Opens a document in a new tab (used by importers). */
  openDoc(doc: Doc, name: string): void;
  /** Called after every change of document, selection or view. */
  subscribe(listener: () => void): Disposable;
}

export interface Command {
  id: string;
  title: string;
  /** Shortcut such as 'Ctrl+Shift+M'. Modifiers in the order Ctrl, Alt, Shift. */
  key?: string;
  /** Show a toolbar button. Commands without it are reachable only by shortcut. */
  toolbar?: boolean;
  enabled?(editor: EditorApi): boolean;
  run(editor: EditorApi): void | Promise<void>;
}

export interface ExportInput {
  doc: Doc;
  sheet: Sheet;
  /** Maps to export, in order. */
  rootIds: Id[];
  /** File name without extension. */
  name: string;
}

export interface Exporter {
  id: string;
  title: string;
  /** File extension without the dot. */
  extension: string;
  mime: string;
  run(input: ExportInput): string | Blob | Promise<string | Blob>;
}

export interface Importer {
  id: string;
  title: string;
  /** Accepted file extensions with the dot: ['.mm']. */
  extensions: string[];
  /** Builds a valid document from file content. Throw an Error with a readable message on bad input. */
  run(text: string, fileName: string): Doc | Promise<Doc>;
}

export interface Panel {
  id: string;
  title: string;
  /** Rendered in the side panel on every editor change while the panel is open. */
  render(editor: EditorApi): ReactNode;
}

/**
 * Pushes node reminders to an outside calendar. The editor calls `upsert`
 * when a reminder is created or changed and stores the returned event id in
 * `reminder.calendarEventId`; `remove` is called when it is deleted.
 */
export interface ReminderSink {
  id: string;
  title: string;
  upsert(reminder: Reminder, node: MapNode, doc: Doc): Promise<{ calendarEventId: string }>;
  remove(reminder: Reminder): Promise<void>;
}

export interface Registry<T> {
  register(item: T): Disposable;
}

export interface ExtensionContext {
  editor: EditorApi;
  commands: Registry<Command>;
  exporters: Registry<Exporter>;
  importers: Registry<Importer>;
  panels: Registry<Panel>;
  storage: Registry<StorageProvider>;
  reminderSinks: Registry<ReminderSink>;
}
