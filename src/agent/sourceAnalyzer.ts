import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { config, has } from '../config.js';

/**
 * Agentic analysis of a user-submitted URL: should this site be queried
 * through an API connector or agentically (web search + fetch)?
 *
 * Claude researches the site (its pages + API docs) and returns a structured
 * SourceAnalysis. For API sources, the analysis includes the request spec
 * (endpoint, pagination, field mapping) AND the exact credential fields the
 * user must supply — which is what drives the dashboard's dynamic form
 * (one input for an API key, two for username+password, none for open APIs).
 */

const credentialFieldSchema = z.object({
  field: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'field must be UPPER_SNAKE_CASE'),
  label: z.string().min(1),
  secret: z.boolean().optional(),
  hint: z.string().optional(),
});

const apiSpecSchema = z.object({
  baseUrl: z.string().url(),
  docsUrl: z.string().optional(),
  listPath: z.string().min(1),
  queryParams: z.record(z.string()).optional(),
  pageParam: z.string().optional(),
  itemsPath: z.string().optional(),
  fieldMap: z.object({
    brand: z.string().optional(),
    productName: z.string().optional(),
    producer: z.string().optional(),
    beverageClass: z.string().optional(),
    origin: z.string().optional(),
    upc: z.string().optional(),
    sourceRef: z.string().optional(),
    sourceUrl: z.string().optional(),
  }),
  auth: z.object({
    type: z.enum(['none', 'api_key', 'bearer', 'basic']),
    placement: z.enum(['header', 'query']).optional(),
    name: z.string().optional(),
  }),
  credentials: z.array(credentialFieldSchema).default([]),
});

export const sourceAnalysisSchema = z
  .object({
    url: z.string().url(),
    label: z.string().min(1),
    kind: z.enum(['api', 'agentic']),
    reason: z.string().min(1),
    api: apiSpecSchema.optional(),
    agentic: z
      .object({
        domains: z.array(z.string().min(1)).min(1),
        hint: z.string().min(1),
      })
      .optional(),
  })
  .refine((a) => (a.kind === 'api' ? !!a.api : !!a.agentic), {
    message: 'analysis is missing the details object for its kind',
  });

export type SourceAnalysis = z.infer<typeof sourceAnalysisSchema>;

const ANALYZER_SYSTEM = `You analyze a website as a candidate data source for an alcohol-product
discovery pipeline. The pipeline has two connector types:

- "api": a generic HTTP connector that calls one JSON list endpoint (with optional
  page-number pagination), maps response fields onto product candidates, and injects
  auth from user-supplied credentials.
- "agentic": an LLM with web search + fetch scoped to the site's domains that
  extracts newly announced products from its pages.

Research the site: fetch the submitted page, and search for official API
documentation (e.g. "<site> API docs", "<site> developer"). Then decide:

Choose "api" ONLY if ALL of these hold (verify in docs — do not guess):
- A documented, publicly reachable HTTP API returns product/catalog data as JSON.
- A user can realistically obtain access self-serve (no auth, free signup, or
  paid plan with self-serve API keys). If access requires a partnership, sales
  contact, or app-store review, choose "agentic" instead.
- You found the actual base URL, list endpoint path, and response shape in the docs.

Otherwise choose "agentic".

Output ONLY one JSON object (no prose, no markdown fences):

{
  "url": "<the submitted url>",
  "label": "<human-readable site name>",
  "kind": "api" | "agentic",
  "reason": "<1-2 sentences on why>",
  "api": {                              // ONLY when kind="api"
    "baseUrl": "https://api.example.com",
    "docsUrl": "https://example.com/docs",          // optional
    "listPath": "/v1/products",
    "queryParams": {"sort": "newest"},              // optional; static params that bias toward newest items
    "pageParam": "page",                            // optional; omit if not paginated by page number
    "itemsPath": "data",                            // dot path from response root to the items array; "" if root IS the array
    "fieldMap": {                                   // dot paths WITHIN one item; include only fields the API returns
      "brand": "brand_name", "productName": "name", "producer": "company.name",
      "beverageClass": "category", "origin": "country", "upc": "barcode",
      "sourceRef": "id", "sourceUrl": "permalink"
    },
    "auth": {"type": "none" | "api_key" | "bearer" | "basic",
             "placement": "header" | "query",       // for api_key
             "name": "X-API-Key"},                  // header or query-param name
    "credentials": [                                // EXACTLY the fields a user must supply; [] when auth is "none"
      {"field": "API_KEY", "label": "API key", "secret": true, "hint": "from https://example.com/account/api"}
    ]
  },
  "agentic": {                          // ONLY when kind="agentic"
    "domains": ["example.com"],
    "hint": "<what this site publishes about alcohol products and how to find NEW launches on it>"
  }
}

Credential rules:
- auth "none"  -> credentials []
- auth "api_key" or "bearer" -> exactly one field (e.g. API_KEY or ACCESS_TOKEN), secret: true
- auth "basic" -> exactly two fields: USERNAME and PASSWORD (PASSWORD secret: true)
- field names are UPPER_SNAKE_CASE; labels are short and human-readable.
- "sourceRef" should map to the record's stable unique id when one exists.`;

export async function analyzeSourceUrl(rawUrl: string): Promise<SourceAnalysis> {
  if (!has.anthropic()) {
    throw new Error('ANTHROPIC_API_KEY is required to analyze a new source');
  }
  const url = new URL(rawUrl); // throws on garbage input

  // Let the agent fetch the site itself (and subdomains like docs.example.com),
  // but nothing else — search results still cover off-domain documentation.
  const host = url.hostname.replace(/^www\./, '');
  const registrable = host.split('.').slice(-2).join('.');
  const allowedDomains = [...new Set([host, registrable])];

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const msg = await client.messages.create(
    {
      model: config.ANTHROPIC_MODEL,
      max_tokens: 8192,
      system: ANALYZER_SYSTEM,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
        {
          type: 'web_fetch_20260309',
          name: 'web_fetch',
          max_uses: 6,
          allowed_domains: allowedDomains,
          max_content_tokens: 8000,
        },
      ],
      messages: [
        { role: 'user', content: `Analyze this site as a discovery source: ${url.href}` },
      ],
    },
    { signal: AbortSignal.timeout(150_000) },
  );

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  const analysis = sourceAnalysisSchema.parse(parseJsonObject(text));
  // The submitted URL is authoritative, whatever the model echoed back.
  return { ...analysis, url: url.href };
}

function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('analyzer did not return JSON');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}
