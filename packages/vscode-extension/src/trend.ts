import type { HealthPoint } from './overview.js';

/** Minimal persistence surface - satisfied by `vscode.Memento` (workspaceState). */
export interface TrendStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'selectorHealer.healthTrend';
/** Keep only the most recent N points so the trend stays small and readable. */
const CAP = 20;

/** No-op store used before {@link HealthTrend.init} wires in real persistence. */
const noopStore: TrendStore = {
  get: (_key, defaultValue) => defaultValue,
  update: async () => {},
};

/**
 * Health-over-time for the dashboard Overview sparkline. Local-first: points
 * live in the workspace's `Memento`, capped to the last {@link CAP} runs. One
 * point is appended per completed full verify.
 */
export class HealthTrend {
  constructor(private store: TrendStore = noopStore) {}

  /** Wire in real persistence (workspaceState) on activation. */
  init(store: TrendStore): void {
    this.store = store;
  }

  /** Append a health reading from a completed run, capping the log. */
  record(healthPct: number): void {
    const points = this.all();
    points.push({ at: Date.now(), healthPct });
    void this.store.update(STORAGE_KEY, points.slice(-CAP));
  }

  /** All recorded points, oldest first. */
  all(): HealthPoint[] {
    return this.store.get<HealthPoint[]>(STORAGE_KEY, []);
  }
}

/** Singleton trend store shared by the verify flow and the Overview builder. */
export const healthTrend = new HealthTrend();
