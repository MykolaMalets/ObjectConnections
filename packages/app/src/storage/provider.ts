// Storage abstraction. Every place files can live (local disk, Google Drive, …)
// implements StorageProvider; the editor never touches platform APIs directly.

export interface FileRef {
  /** Id of the provider that owns this reference. */
  provider: string;
  name: string;
  /** Provider-specific handle (file handle, Drive file id, …). */
  handle: unknown;
}

export interface FileContent {
  text: string;
  /** Opaque version token; changes whenever the stored file changes. */
  version: string;
}

export interface StorageProvider {
  id: string;
  /** True when write() saves in place without user interaction, so autosave is possible. */
  canAutosave: boolean;
  /** Lets the user choose an existing file. Null when cancelled. */
  pickOpen(): Promise<FileRef | null>;
  /** Lets the user choose where to save a new file. Null when cancelled. */
  pickSave(suggestedName: string): Promise<FileRef | null>;
  read(ref: FileRef): Promise<FileContent>;
  /** Current version token without reading the content; used to detect outside changes. */
  version(ref: FileRef): Promise<string>;
  /** Returns the new version token, or '' when it cannot be determined. */
  write(ref: FileRef, text: string): Promise<{ version: string }>;
  /**
   * Makes sure the file can be written, asking the user if needed. Called
   * only from a user gesture (a manual save). False when access is refused.
   */
  authorize?(ref: FileRef): Promise<boolean>;
  /** True when both references point at the same stored file. */
  same?(a: FileRef, b: FileRef): Promise<boolean>;
}

export const FILE_EXTENSION = '.ocmap';
