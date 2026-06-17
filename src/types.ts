// Core domain types shared across the service.

/** A normalized product candidate emitted by any source connector. */
export interface ProductCandidate {
  brand?: string;
  productName?: string;
  producer?: string;
  beverageClass?: string;
  origin?: string;
  upc?: string;

  source: string;        // connector id, e.g. "cola_cloud"
  sourceRef?: string;    // native id from the source (TTB id, brewery id, ...)
  sourceUrl?: string;    // link back to the record
  raw: unknown;          // full payload, stored as JSONB for later re-processing
}

/** A candidate after we've computed its stable identity. */
export interface KeyedCandidate extends ProductCandidate {
  dedupKey: string;
}

/** A credential the user must supply for a source (name/label only — values live in the source_credentials table). */
export interface CredentialField {
  /** Storage key, e.g. "API_KEY", "USERNAME". */
  field: string;
  /** Human label shown next to the dashboard input, e.g. "API key". */
  label: string;
  /** Render as a password input. */
  secret?: boolean;
  /** Where to obtain it, shown as placeholder/help text. */
  hint?: string;
}

/** Extra metadata carried by user-added (generated) sources. */
export interface SourceMeta {
  custom: true;
  kind: 'api' | 'agentic';
  /** The URL the user submitted when adding this source. */
  url: string;
  /** Credential fields this source needs — drives the dashboard form. */
  credentials: CredentialField[];
}

/** What a source connector exposes to the orchestrator. */
export interface Source {
  id: string;
  label: string;
  /** Present only on user-added sources generated from a URL. */
  meta?: SourceMeta;
  /** True only if the connector is configured (has keys, etc.). */
  enabled(): boolean;
  /**
   * Discover candidates. `budget` tells the source how hard to work —
   * test runs pass a small budget so the whole run fits in ~1-2 minutes.
   */
  discover(budget: DiscoveryBudget): Promise<ProductCandidate[]>;
}

export interface DiscoveryBudget {
  /** Soft cap on candidates to pull from this source. */
  maxCandidates: number;
  /** Soft wall-clock deadline (epoch ms) the source should respect. */
  deadline: number;
  /** True in test/dry-run mode. Sources may use this to do less work. */
  test: boolean;
}

export interface RunResult {
  runId: string;
  mode: 'live' | 'test';
  /** ISO timestamp the run was enqueued. */
  createdAt: string;
  /** ISO timestamp the pipeline actually began (set when a worker claims it). */
  startedAt?: string;
  finishedAt?: string;
  /** queued -> running -> done|error. 'queued' runs are waiting for the worker. */
  status: 'queued' | 'running' | 'done' | 'error';
  /** When set, the run is restricted to these source ids (per-source test button). */
  onlySources?: string[];
  sourcesRun: string[];
  candidates: number;
  newProducts: KeyedCandidate[];   // the interesting output for the dashboard
  knownCount: number;
  error?: string;
  log: string[];
}
