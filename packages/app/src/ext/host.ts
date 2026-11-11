// Extension host: owns the registries and gives extensions their context.

import { validate } from '@oc/core';
import { Session, execute } from '../state/store.ts';
import type { Workspace } from '../state/store.ts';
import type { FileRef, StorageProvider } from '../storage/provider.ts';
import { alertDialog } from '../ui/dialogs.tsx';
import type { Measure } from '../view/layout.ts';
import { layoutRoots } from '../view/layout.ts';
import { createMeasure } from '../view/style.ts';
import type {
  Command,
  Disposable,
  EditorApi,
  Exporter,
  Extension,
  ExtensionContext,
  Importer,
  Panel,
  Registry,
  ReminderSink,
} from './api.ts';

export class ExtensionHost {
  readonly ws: Workspace;
  readonly editor: EditorApi;
  readonly commands = new Map<string, Command>();
  readonly exporters = new Map<string, Exporter>();
  readonly importers = new Map<string, Importer>();
  readonly panels = new Map<string, Panel>();
  readonly storage = new Map<string, StorageProvider>();
  readonly reminderSinks = new Map<string, ReminderSink>();
  /** Id of the panel shown in the side area, or null. */
  activePanel: string | null = null;
  measure: Measure | null = null;

  constructor(ws: Workspace, extensions: Extension[]) {
    this.ws = ws;
    this.editor = {
      get doc() {
        return ws.session?.doc ?? null;
      },
      get fileName() {
        return ws.session?.name ?? null;
      },
      get sheet() {
        return ws.session?.sheet ?? null;
      },
      get selection() {
        return ws.session?.selection ?? null;
      },
      get viewRoots() {
        return ws.session?.viewRoots ?? [];
      },
      apply: (ops, label) => execute(ws, ops, label),
      openDoc: (doc, name) => ws.add(new Session(doc, name)),
      subscribe: (listener) => ws.subscribe(listener),
    };
    const seen = new Set<string>();
    for (const extension of extensions) {
      if (seen.has(extension.id)) throw new Error(`duplicate extension id: ${extension.id}`);
      seen.add(extension.id);
      try {
        extension.activate(this.contextFor());
      } catch (error) {
        console.error(`extension ${extension.id} failed to activate`, error);
      }
    }
  }

  contextFor(): ExtensionContext {
    return {
      editor: this.editor,
      commands: this.registry(this.commands),
      exporters: this.registry(this.exporters),
      importers: this.registry(this.importers),
      panels: this.registry(this.panels),
      storage: this.registry(this.storage),
      reminderSinks: this.registry(this.reminderSinks),
    };
  }

  registry<T extends { id: string }>(map: Map<string, T>): Registry<T> {
    return {
      register: (item): Disposable => {
        if (map.has(item.id)) throw new Error(`already registered: ${item.id}`);
        map.set(item.id, item);
        this.ws.notify();
        return () => {
          if (map.get(item.id) === item) map.delete(item.id);
          this.ws.notify();
        };
      },
    };
  }

  /** Provider used for "Open" and for files that were never saved: the first one registered. */
  defaultStorage(): StorageProvider {
    const provider = this.storage.values().next().value;
    if (!provider) throw new Error('no storage provider is registered');
    return provider;
  }

  storageFor(ref: FileRef): StorageProvider {
    const provider = this.storage.get(ref.provider);
    if (!provider) throw new Error(`storage provider is not available: ${ref.provider}`);
    return provider;
  }

  togglePanel(id: string): void {
    this.activePanel = this.activePanel === id ? null : id;
    this.ws.notify();
  }

  /** Command bound to the keyboard event, if any. */
  commandForKey(e: KeyboardEvent): Command | undefined {
    if (e.key.length !== 1 && !/^F\d+$/.test(e.key)) return undefined;
    const combo = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', e.key.toUpperCase()]
      .filter(Boolean)
      .join('+');
    for (const command of this.commands.values()) if (command.key?.toUpperCase() === combo.toUpperCase()) return command;
    return undefined;
  }

  async runCommand(command: Command): Promise<void> {
    if (command.enabled && !command.enabled(this.editor)) return;
    try {
      await command.run(this.editor);
    } catch (error) {
      void alertDialog(`«${command.title}»: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Runs an exporter on what the canvas currently shows and hands the result to the user. */
  async runExport(id: string): Promise<void> {
    const exporter = this.exporters.get(id);
    const session = this.ws.session;
    if (!exporter || !session?.sheet) return;
    try {
      const result = await exporter.run({
        doc: session.doc,
        sheet: session.sheet,
        rootIds: session.viewRoots,
        name: session.name,
        layout: () => {
          this.measure ??= createMeasure(document.createElement('canvas').getContext('2d')!);
          return layoutRoots(session.doc, session.viewRoots, session.sheet?.structure, this.measure, !!session.focusId);
        },
      });
      const blob = typeof result === 'string' ? new Blob([result], { type: exporter.mime }) : result;
      downloadBlob(blob, `${session.name}.${exporter.extension}`);
    } catch (error) {
      void alertDialog(`Экспорт «${exporter.title}» не удался: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Lets the user pick a file for the importer and opens the result in a new tab. */
  async runImport(id: string): Promise<void> {
    const importer = this.importers.get(id);
    if (!importer) return;
    const file = await pickFile(importer.extensions.join(','));
    if (!file) return;
    try {
      const doc = await importer.run(await file.text(), file.name);
      const problems = validate(doc);
      if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
      this.editor.openDoc(doc, file.name.replace(/\.[^.]+$/, ''));
    } catch (error) {
      void alertDialog(`Импорт «${importer.title}» не удался: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
