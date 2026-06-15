import Anthropic from '@anthropic-ai/sdk';
import { config, has } from '../config.js';
import type { Source, ProductCandidate, DiscoveryBudget } from '../types.js';

/**
 * Agentic web discovery — covers every source that lacks a usable API.
 *
 * Rather than firing generic "new whiskey 2026" queries, the agent works a
 * rotating "beat" of high-signal trade publications that pre-catalogue product
 * launches, using two server-side tools:
 *   - web_search : targeted (site:-style) queries against the beat's domains
 *   - web_fetch  : pull the specific launch-roundup articles to extract products
 * Domains drawn from curated trade press, press-release wires, and category
 * specialists. Each run rotates beats so repeated runs cover different ground.
 *
 * Skipped automatically when ANTHROPIC_API_KEY is unset.
 */

// Trusted publications the agent is allowed to fetch from (Tier 1 + Tier 3).
const PUBLICATION_DOMAINS = [
  'drinks-intel.com', 'thespiritsbusiness.com', 'thedrinksbusiness.com', 'drinksint.com',
  'parkstreet.com', 'drinksretailingnews.co.uk', 'brewbound.com',
  'prnewswire.com', 'businesswire.com', 'prweb.com',
  'decanter.com', 'winemag.com', 'wine-searcher.com', 'whiskyadvocate.com', 'scotchwhisky.com',
];

interface Beat { name: string; domains: string[]; hint: string; }

const BEATS: Beat[] = [
  {
    name: 'spirits launches (trade press)',
    domains: ['drinks-intel.com', 'thespiritsbusiness.com', 'thedrinksbusiness.com', 'drinksint.com'],
    hint: "weekly/monthly new-spirits launch roundups (e.g. Global Drinks Intel's " +
          "'this week's new spirits launches', The Spirits Business 'top 10 launches'); " +
          'capture ABV, category, origin, bottle size, and SRP when listed',
  },
  {
    name: 'beer launches',
    domains: ['brewbound.com', 'prnewswire.com'],
    hint: 'new beer releases and brewery product announcements from the Brewbound newswire',
  },
  {
    name: 'wine & RTD launches',
    domains: ['parkstreet.com', 'drinksretailingnews.co.uk', 'decanter.com', 'winemag.com'],
    hint: "new wine, RTD, and hard-seltzer launches; Park Street's cumulative yearly " +
          'new-brand roundup is especially product-dense',
  },
  {
    name: 'press-release wire (broad)',
    domains: ['prnewswire.com', 'businesswire.com', 'prweb.com'],
    hint: 'beer/wine/spirits new-product press releases across all brand owners (noisy but comprehensive)',
  },
];

export const agenticWeb: Source = {
  id: 'agentic_web',
  label: 'Agentic web discovery',
  enabled: () => has.anthropic(),

  async discover(budget: DiscoveryBudget): Promise<ProductCandidate[]> {
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const beat = BEATS[Math.floor(Math.random() * BEATS.length)]!;
    const want = Math.min(budget.maxCandidates, budget.test ? 8 : 25);

    const system =
      'You are a beverage-industry scout finding genuinely NEW or newly announced ' +
      'alcohol products (beer, wine, spirits, RTDs). Strategy, in order:\n' +
      '1. Use web_search with site:-targeted queries against the beat\'s publications ' +
      'to find the most recent product-launch roundups and announcements.\n' +
      '2. Use web_fetch to open those specific articles and extract the individual ' +
      'products listed in them. Trade roundups often list many products per page.\n' +
      'Prefer primary, recent sources. Do NOT invent products — only include ones you ' +
      'actually found on a fetched page or search result. When finished, output ONLY a ' +
      'JSON array (no prose, no markdown fences) of objects with keys: brand, ' +
      'productName, producer, beverageClass, origin, sourceUrl.';

    const user =
      `Tonight's beat: ${beat.name}.\n` +
      `Focus on these publications first: ${beat.domains.join(', ')}.\n` +
      `What to look for: ${beat.hint}.\n` +
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
            allowed_domains: PUBLICATION_DOMAINS,
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
        source: 'agentic_web',
        sourceUrl: str(row.sourceUrl),
        raw: { ...row, _beat: beat.name },
      } satisfies ProductCandidate));
  },
};

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