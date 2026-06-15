import Anthropic from '@anthropic-ai/sdk';
import { config, has } from '../../config.js';
import type { Source, ProductCandidate, DiscoveryBudget } from '../../types.js';

/**
 * Runtime for generated agentic connectors — sites with no usable API.
 * Same approach as the built-in agentic_web source, but scoped to the one
 * site the user added: Claude searches and fetches only that site's domains
 * and extracts newly announced products as structured JSON.
 * Skipped automatically when ANTHROPIC_API_KEY is unset.
 */

export interface AgenticSourceDef {
  id: string;
  label: string;
  /** The URL the user submitted when adding this source. */
  addedFrom: string;
  /** Domains the agent is allowed to fetch from. */
  domains: string[];
  /** What this site publishes and how to find new product launches on it. */
  hint: string;
}

export function defineAgenticSource(def: AgenticSourceDef): Source {
  return {
    id: def.id,
    label: def.label,
    meta: { custom: true, kind: 'agentic', url: def.addedFrom, credentials: [] },
    enabled: () => has.anthropic(),

    async discover(budget: DiscoveryBudget): Promise<ProductCandidate[]> {
      const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const want = Math.min(budget.maxCandidates, budget.test ? 8 : 25);

      const system =
        'You are a beverage-industry scout finding genuinely NEW or newly announced ' +
        'alcohol products (beer, wine, spirits, RTDs) from ONE specific site. Strategy:\n' +
        '1. Use web_search with site:-targeted queries against the given domains to find ' +
        'the most recent product launches, releases, or catalog additions.\n' +
        '2. Use web_fetch to open those specific pages and extract the individual products.\n' +
        'Do NOT invent products — only include ones you actually found on a fetched page ' +
        'or search result. When finished, output ONLY a JSON array (no prose, no markdown ' +
        'fences) of objects with keys: brand, productName, producer, beverageClass, ' +
        'origin, sourceUrl.';

      const user =
        `Site: ${def.label} (${def.domains.join(', ')}).\n` +
        `What to look for: ${def.hint}\n` +
        `Find up to ${want} distinct, recently-launched products. Return JSON only.`;

      const msg = await client.messages.create(
        {
          model: config.ANTHROPIC_MODEL,
          max_tokens: 8192,
          system,
          tools: [
            {
              type: 'web_search_20260209',
              name: 'web_search',
              max_uses: budget.test ? 4 : 10,
            },
            {
              type: 'web_fetch_20260309',
              name: 'web_fetch',
              max_uses: budget.test ? 3 : 12,
              allowed_domains: def.domains,
              max_content_tokens: 8000,
            },
          ],
          messages: [{ role: 'user', content: user }],
        },
        { signal: AbortSignal.timeout(Math.max(5000, budget.deadline - Date.now())) },
      );

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      return parseJsonArray(text)
        .slice(0, budget.maxCandidates)
        .map((row) => ({
          brand: str(row.brand),
          productName: str(row.productName),
          producer: str(row.producer),
          beverageClass: str(row.beverageClass),
          origin: str(row.origin),
          source: def.id,
          sourceUrl: str(row.sourceUrl),
          raw: row,
        } satisfies ProductCandidate));
    },
  };
}

function parseJsonArray(text: string): Array<Record<string, unknown>> {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
