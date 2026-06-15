import { config, has } from '../config.js';
import type { Source, ProductCandidate, DiscoveryBudget } from '../types.js';

/**
 * COLA Cloud — enriched TTB Certificate of Label Approval registry.
 * Primary leading-indicator feed: labels are federally approved before products
 * ship, and ~2,500-3,000 new approvals land weekly.
 *
 * GET /colas returns results newest-first by approval_date and, when no date
 * filter is given, defaults to the last 365 days — exactly what discovery wants.
 * Auth is the X-API-Key header. Response shape is { data: [...], pagination }.
 * Docs: https://docs.colacloud.us/api-reference/colas/search-colas
 */
export const colaCloud: Source = {
  id: 'cola_cloud',
  label: 'COLA Cloud (TTB registry)',
  enabled: () => has.colaCloud(),

  async discover(budget: DiscoveryBudget): Promise<ProductCandidate[]> {
    const out: ProductCandidate[] = [];
    const perPage = Math.min(budget.maxCandidates, 100); // API max is 100
    let page = 1;

    // Page through newest approvals until we hit the budget, run out of
    // results, or run out of time. (Mind your plan's per-minute burst limit.)
    while (out.length < budget.maxCandidates && Date.now() < budget.deadline && page <= 100) {
      const url = new URL(`${config.COLACLOUD_BASE_URL}/colas`);
      url.searchParams.set('sort', 'approval_date_desc'); // newest first (default)
      url.searchParams.set('per_page', String(perPage));
      url.searchParams.set('page', String(page));

      const res = await fetch(url, {
        headers: { 'X-API-Key': config.COLACLOUD_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1000, budget.deadline - Date.now())),
      });
      if (!res.ok) {
        throw new Error(`COLA Cloud ${res.status}: ${await res.text().catch(() => '')}`);
      }

      const body = (await res.json()) as {
        data?: ColaSummary[];
        pagination?: { has_more?: boolean };
      };
      const rows = body.data ?? [];
      for (const row of rows) {
        out.push(toCandidate(row));
        if (out.length >= budget.maxCandidates) break;
      }
      if (rows.length === 0 || !body.pagination?.has_more) break;
      page++;
    }

    return out.slice(0, budget.maxCandidates);
  },
};

/** Shape of a record in the /colas list response (ColaSummary). */
interface ColaSummary {
  ttb_id?: string;
  brand_name?: string;
  product_name?: string;
  product_type?: string;   // wine | malt beverage | distilled spirits
  class_name?: string;     // finer TTB classification, e.g. "table red wine"
  origin_name?: string;
  permit_number?: string;
  approval_date?: string | null;
  image_count?: number;
  has_barcode?: boolean;
}

function toCandidate(row: ColaSummary): ProductCandidate {
  const ttbId = str(row.ttb_id);
  return {
    brand: str(row.brand_name),
    productName: str(row.product_name),
    // The applicant/company name is NOT in the list view (it requires a detail
    // view, which costs quota). We keep permit_number in `raw` to identify the
    // producer without burning detail-view quota on every discovery pass.
    producer: undefined,
    beverageClass: str(row.class_name) ?? str(row.product_type),
    origin: str(row.origin_name),
    // List view only exposes has_barcode (boolean); the actual UPC value needs
    // a detail view, so we leave it unset here.
    upc: undefined,
    source: 'cola_cloud',
    sourceRef: ttbId,
    sourceUrl: ttbId
      ? `https://ttbonline.gov/colasonline/viewColaDetails.do?action=publicDisplaySearchAdvanced&ttbid=${ttbId}`
      : undefined,
    raw: row,
  };
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}