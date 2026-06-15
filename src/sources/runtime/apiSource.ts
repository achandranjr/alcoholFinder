import { getCredentials } from '../../credentials.js';
import type { Source, ProductCandidate, DiscoveryBudget, CredentialField } from '../../types.js';

/**
 * Runtime for generated API connectors. A generated file in src/sources/custom/
 * holds only the declarative spec (produced by the source analyzer); this module
 * does the actual fetching: pagination, auth injection, and field mapping.
 * Credentials are looked up from the credential store, never embedded in code.
 */

export interface ApiAuth {
  type: 'none' | 'api_key' | 'bearer' | 'basic';
  /** Where an api_key goes. Default: header. */
  placement?: 'header' | 'query';
  /** Header or query-param name for the key, e.g. "X-API-Key". */
  name?: string;
}

export interface ApiFieldMap {
  brand?: string;
  productName?: string;
  producer?: string;
  beverageClass?: string;
  origin?: string;
  upc?: string;
  sourceRef?: string;
  sourceUrl?: string;
}

export interface ApiSourceSpec {
  baseUrl: string;
  docsUrl?: string;
  /** Endpoint path that lists/searches products, e.g. "/v1/products". */
  listPath: string;
  /** Static params that bias the listing toward newest products. */
  queryParams?: Record<string, string>;
  /** Page-number query param, when the API paginates that way. */
  pageParam?: string;
  /** Dot path from the response root to the items array; "" when the root is the array. */
  itemsPath?: string;
  /** Dot paths within one item for each ProductCandidate field. */
  fieldMap: ApiFieldMap;
  auth: ApiAuth;
  credentials: CredentialField[];
}

export interface ApiSourceDef {
  id: string;
  label: string;
  /** The URL the user submitted when adding this source. */
  addedFrom: string;
  spec: ApiSourceSpec;
}

export function defineApiSource(def: ApiSourceDef): Source {
  const { id, label, spec } = def;
  return {
    id,
    label,
    meta: { custom: true, kind: 'api', url: def.addedFrom, credentials: spec.credentials },

    enabled() {
      if (spec.auth.type === 'none') return true;
      const creds = getCredentials(id);
      return spec.credentials.every((c) => (creds[c.field] ?? '').length > 0);
    },

    async discover(budget: DiscoveryBudget): Promise<ProductCandidate[]> {
      const out: ProductCandidate[] = [];
      let page = 1;

      while (out.length < budget.maxCandidates && Date.now() < budget.deadline && page <= 20) {
        const url = joinUrl(spec.baseUrl, spec.listPath);
        for (const [k, v] of Object.entries(spec.queryParams ?? {})) url.searchParams.set(k, v);
        if (spec.pageParam) url.searchParams.set(spec.pageParam, String(page));

        const headers: Record<string, string> = { Accept: 'application/json' };
        applyAuth(id, spec, url, headers);

        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(Math.max(1000, budget.deadline - Date.now())),
        });
        if (!res.ok) {
          throw new Error(`${label} ${res.status}: ${await res.text().catch(() => '')}`);
        }

        const body = (await res.json()) as unknown;
        const items = dig(body, spec.itemsPath ?? '');
        if (!Array.isArray(items)) {
          if (page === 1) {
            throw new Error(`${label}: itemsPath "${spec.itemsPath ?? ''}" did not yield an array`);
          }
          break;
        }

        for (const item of items) {
          out.push(toCandidate(id, spec.fieldMap, item));
          if (out.length >= budget.maxCandidates) break;
        }

        if (items.length === 0 || !spec.pageParam) break;
        page++;
      }

      return out.slice(0, budget.maxCandidates);
    },
  };
}

function applyAuth(id: string, spec: ApiSourceSpec, url: URL, headers: Record<string, string>): void {
  const creds = getCredentials(id);
  const { auth } = spec;
  if (auth.type === 'none') return;

  if (auth.type === 'basic') {
    const user = findCred(creds, spec.credentials, /user|login|email/i);
    const pass = findCred(creds, spec.credentials, /pass|secret/i);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    return;
  }

  // api_key / bearer: a single credential value.
  const value = creds[spec.credentials[0]?.field ?? ''] ?? '';
  if (auth.type === 'bearer') {
    headers.Authorization = `Bearer ${value}`;
  } else if (auth.placement === 'query') {
    url.searchParams.set(auth.name ?? 'api_key', value);
  } else {
    headers[auth.name ?? 'X-API-Key'] = value;
  }
}

function findCred(
  creds: Record<string, string>,
  fields: CredentialField[],
  pattern: RegExp,
): string {
  const match = fields.find((f) => pattern.test(f.field));
  return creds[match?.field ?? ''] ?? '';
}

function joinUrl(base: string, path: string): URL {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return new URL(b + p);
}

/** Walk a dot path ("data.items") into an object; "" returns the object itself. */
function dig(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>(
    (o, key) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

function toCandidate(id: string, fm: ApiFieldMap, item: unknown): ProductCandidate {
  const pick = (p?: string) => (p ? str(dig(item, p)) : undefined);
  return {
    brand: pick(fm.brand),
    productName: pick(fm.productName),
    producer: pick(fm.producer),
    beverageClass: pick(fm.beverageClass),
    origin: pick(fm.origin),
    upc: pick(fm.upc),
    source: id,
    sourceRef: pick(fm.sourceRef),
    sourceUrl: pick(fm.sourceUrl),
    raw: item,
  };
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
