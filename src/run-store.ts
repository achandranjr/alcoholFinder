import { randomUUID } from 'node:crypto';
import type { RunResult } from './types.js';

/**
 * Holds run results in memory so the dashboard can show live progress.
 * Test/dry runs are NEVER persisted to Postgres — this store is their only home.
 * A small ring buffer keeps the most recent runs.
 */
class RunStore {
  private runs = new Map<string, RunResult>();
  private order: string[] = [];
  private cap = 50;

  create(mode: 'live' | 'test'): RunResult {
    const run: RunResult = {
      runId: randomUUID(),
      mode,
      startedAt: new Date().toISOString(),
      status: 'running',
      sourcesRun: [],
      candidates: 0,
      newProducts: [],
      knownCount: 0,
      log: [],
    };
    this.runs.set(run.runId, run);
    this.order.unshift(run.runId);
    while (this.order.length > this.cap) {
      const id = this.order.pop();
      if (id) this.runs.delete(id);
    }
    return run;
  }

  get(id: string): RunResult | undefined { return this.runs.get(id); }
  list(): RunResult[] { return this.order.map((id) => this.runs.get(id)!).filter(Boolean); }
}

export const runStore = new RunStore();
