/**
 * Mock of the `vscode` module for unit testing.
 * Provides minimal implementations of the VS Code API surface
 * used by the extension's source files.
 */

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Uri {
  private constructor(
    public readonly fsPath: string,
    public readonly scheme: string,
  ) {}

  static file(path: string): Uri {
    return new Uri(path, 'file');
  }

  with(change: { scheme?: string }): Uri {
    return new Uri(this.fsPath, change.scheme ?? this.scheme);
  }

  toString(): string {
    return `${this.scheme}:${this.fsPath}`;
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string | number;

  constructor(
    public readonly range: Range,
    public readonly message: string,
    public readonly severity: DiagnosticSeverity,
  ) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  iconPath?: ThemeIcon;
  resourceUri?: Uri;
  command?: { command: string; title: string; arguments?: unknown[] };
  collapsibleState?: TreeItemCollapsibleState;

  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum CodeActionKind {
  QuickFix = 'quickfix',
}

export class CodeAction {
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;

  constructor(
    public readonly title: string,
    public readonly kind?: CodeActionKind,
  ) {}
}

export class WorkspaceEdit {
  private edits: Array<{ uri: Uri; range: Range; newText: string }> = [];

  replace(uri: Uri, range: Range, newText: string): void {
    this.edits.push({ uri, range, newText });
  }

  getEdits(): Array<{ uri: Uri; range: Range; newText: string }> {
    return this.edits;
  }
}

// Mock factories
function createMockDiagnosticCollection() {
  const store = new Map<string, Diagnostic[]>();
  return {
    set(uri: Uri, diagnostics: Diagnostic[]): void {
      store.set(uri.fsPath, diagnostics);
    },
    delete(uri: Uri): void {
      store.delete(uri.fsPath);
    },
    clear(): void {
      store.clear();
    },
    get(uri: Uri): Diagnostic[] | undefined {
      return store.get(uri.fsPath);
    },
    dispose(): void {
      store.clear();
    },
    /** Test helper to get internal store */
    _store: store,
  };
}

function createMockStatusBarItem() {
  return {
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    backgroundColor: undefined as ThemeColor | undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
    alignment: StatusBarAlignment.Left,
    priority: 0,
  };
}

function createMockOutputChannel() {
  const lines: string[] = [];
  return {
    appendLine: (line: string) => lines.push(line),
    append: (text: string) => lines.push(text),
    clear: () => {
      lines.length = 0;
    },
    show: () => {},
    hide: () => {},
    dispose: () => {},
    _lines: lines,
  };
}

// ── Test harness state (mutated by tests via the __* helpers below) ──────────
let __docText = '';
let __infoChoice: string | undefined;
let __lastEdit: WorkspaceEdit | undefined;
const __executedCommands: Array<{ command: string; args: unknown[] }> = [];

export function __setDocText(text: string): void {
  __docText = text;
}
export function __setInfoChoice(choice: string | undefined): void {
  __infoChoice = choice;
}
export function __getLastEdit(): WorkspaceEdit | undefined {
  return __lastEdit;
}
export function __getExecutedCommands(): Array<{ command: string; args: unknown[] }> {
  return __executedCommands;
}
export function __reset(): void {
  __docText = '';
  __infoChoice = undefined;
  __lastEdit = undefined;
  __executedCommands.length = 0;
}

export const languages = {
  createDiagnosticCollection: (_name?: string) => createMockDiagnosticCollection(),
  registerCodeActionsProvider: () => ({ dispose: () => {} }),
};

export const window = {
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) =>
    createMockStatusBarItem(),
  createOutputChannel: (_name: string) => createMockOutputChannel(),
  createTreeView: () => ({ dispose: () => {} }),
  showErrorMessage: () => {},
  showWarningMessage: () => {},
  showInformationMessage: (..._args: unknown[]) => Promise.resolve(__infoChoice),
};

export const workspace = {
  workspaceFolders: undefined as Array<{ uri: Uri }> | undefined,
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidOpenTextDocument: () => ({ dispose: () => {} }),
  openTextDocument: (uri: Uri) =>
    Promise.resolve({
      uri,
      getText: () => __docText,
      offsetAt: (pos: Position) => pos.character,
    }),
  applyEdit: (edit: WorkspaceEdit) => {
    __lastEdit = edit;
    return Promise.resolve(true);
  },
  registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: (_command: string, _callback: () => void) => ({ dispose: () => {} }),
  executeCommand: (command: string, ...args: unknown[]) => {
    __executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export type DocumentSelector = Array<{ language: string; scheme: string }>;

export interface TextDocument {
  uri: Uri;
  languageId: string;
  lineAt(line: number): { text: string };
}
