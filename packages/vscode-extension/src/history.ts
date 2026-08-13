import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

/** The essential facts of one applied heal - enough to record and to reverse it. */
export interface AppliedHeal {
  readonly filePath: string;
  /** 1-indexed line of the replaced call. */
  readonly line: number;
  /** 1-indexed column where the replaced text begins. */
  readonly column: number;
  /** The exact source text that was replaced (what an undo restores). */
  readonly before: string;
  /** The exact source text written in (what an undo looks for). */
  readonly after: string;
}

/** A persisted heal, as stored in the workspace history. */
export interface HealHistoryEntry extends AppliedHeal {
  readonly id: string;
  /** Epoch ms when the heal was applied. */
  readonly appliedAt: number;
  /** Short human summary, e.g. `'button' → getByTestId('save')`. */
  readonly label: string;
  readonly selectorId?: string;
}

/** Minimal persistence surface - satisfied by `vscode.Memento` (workspaceState). */
export interface HistoryStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/** Where an applied heal's `after` text currently sits, so it can be reverted. */
export type UndoLocation =
  | {
      readonly kind: 'found';
      readonly line: number;
      readonly startCol: number;
      readonly endCol: number;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ambiguous' };

/** Outcome of an undo attempt. */
export type UndoResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'file-missing' | 'not-found' | 'ambiguous' | 'edit-failed';
    };

const STORAGE_KEY = 'selectorHealer.healHistory';
const MAX_ENTRIES = 50;

/** In-memory fallback used before {@link HealHistoryStore.init} binds real storage. */
class InMemoryStore implements HistoryStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

/**
 * Persistent, capped log of applied heals - the backing store for "undo the
 * heal I just applied". Local-first: entries live in the workspace's `Memento`,
 * never leave the machine. Newest entry is first.
 */
export class HealHistoryStore {
  constructor(private store: HistoryStore = new InMemoryStore()) {}

  /** Bind to persistent storage (call once during `activate`). */
  init(store: HistoryStore): void {
    this.store = store;
  }

  /** All entries, most recent first. */
  all(): HealHistoryEntry[] {
    return this.store.get<HealHistoryEntry[]>(STORAGE_KEY, []);
  }

  /** The most recently applied heal, if any. */
  latest(): HealHistoryEntry | undefined {
    return this.all()[0];
  }

  /**
   * Record a newly applied heal at the front of the history, capping the log.
   *
   * @param heal - the applied edit plus a display label and optional selector id
   * @returns the stored entry (with its generated id and timestamp)
   *
   * @example
   * await healHistory.record({ ...applied, label: "'button' → getByTestId('save')" });
   */
  async record(
    heal: AppliedHeal & { label: string; selectorId?: string },
  ): Promise<HealHistoryEntry> {
    const entry: HealHistoryEntry = { ...heal, id: randomUUID(), appliedAt: Date.now() };
    const next = [entry, ...this.all()].slice(0, MAX_ENTRIES);
    await this.store.update(STORAGE_KEY, next);
    return entry;
  }

  /** Drop a single entry by id (called after a successful undo). */
  async remove(id: string): Promise<void> {
    await this.store.update(
      STORAGE_KEY,
      this.all().filter((e) => e.id !== id),
    );
  }

  /** Forget all recorded heals. */
  async clear(): Promise<void> {
    await this.store.update(STORAGE_KEY, []);
  }
}

/** Singleton history shared by the extension's commands and apply paths. */
export const healHistory = new HealHistoryStore();

/**
 * Locate where an applied heal's `after` text currently sits in a document, so
 * it can be reverted to `before`. Prefers the recorded line (choosing the
 * occurrence nearest the recorded column); if the line has shifted, falls back
 * to a whole-document search that must be unambiguous. Pure and side-effect free.
 *
 * @param lines - the document split into lines
 * @param entry - the recorded line (1-indexed), column (1-indexed), and `after` text
 * @returns a `found` location, or `not-found` / `ambiguous` when it can't be pinned down
 *
 * @example
 * findUndoRange(["await page.getByTestId('save').click();"], { line: 1, column: 12, after: "getByTestId('save')" });
 * // { kind: 'found', line: 0, startCol: 11, endCol: 30 }
 */
export function findUndoRange(
  lines: readonly string[],
  entry: Pick<HealHistoryEntry, 'line' | 'column' | 'after'>,
): UndoLocation {
  const { after } = entry;
  if (after.length === 0) return { kind: 'not-found' };

  // 1) Prefer the recorded line, choosing the occurrence nearest the recorded column.
  const recordedIdx = entry.line - 1;
  const recordedLine = lines[recordedIdx];
  if (recordedLine !== undefined) {
    const col = nearestOccurrence(recordedLine, after, entry.column - 1);
    if (col !== -1)
      return { kind: 'found', line: recordedIdx, startCol: col, endCol: col + after.length };
  }

  // 2) The line shifted - search the whole document; a unique match wins, more than one is ambiguous.
  let found: { line: number; col: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    let from = 0;
    for (;;) {
      const idx = line.indexOf(after, from);
      if (idx === -1) break;
      if (found) return { kind: 'ambiguous' };
      found = { line: i, col: idx };
      from = idx + after.length;
    }
  }
  if (found)
    return {
      kind: 'found',
      line: found.line,
      startCol: found.col,
      endCol: found.col + after.length,
    };
  return { kind: 'not-found' };
}

/** Index of the occurrence of `needle` in `text` nearest to `hint`, or -1 if none. */
function nearestOccurrence(text: string, needle: string, hint: number): number {
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    const dist = Math.abs(idx - hint);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
    from = idx + needle.length;
  }
  return best;
}

/**
 * Revert a previously applied heal by replacing its `after` text with the
 * original `before`. Re-opens the file, re-locates the healed text (tolerating a
 * shifted line), applies the reversing edit, and saves.
 *
 * @param entry - the history entry to undo
 * @returns `{ ok: true }` on success, or `{ ok: false, reason }` when the file is
 *          gone, the healed text can't be found, or it's now ambiguous
 *
 * @example
 * const res = await undoHeal(entry); // { ok: true }
 */
export async function undoHeal(entry: HealHistoryEntry): Promise<UndoResult> {
  const uri = vscode.Uri.file(entry.filePath);
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { ok: false, reason: 'file-missing' };
  }

  const loc = findUndoRange(doc.getText().split(/\r?\n/), entry);
  if (loc.kind !== 'found') return { ok: false, reason: loc.kind };

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(
      new vscode.Position(loc.line, loc.startCol),
      new vscode.Position(loc.line, loc.endCol),
    ),
    entry.before,
  );
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) return { ok: false, reason: 'edit-failed' };
  await doc.save();
  return { ok: true };
}
