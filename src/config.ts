import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  COLACLOUD_API_KEY: z.string().optional().default(''),
  COLACLOUD_BASE_URL: z.string().default('https://app.colacloud.us/api/v1'),

  OPENBREWERYDB_BASE_URL: z.string().default('https://api.openbrewerydb.org/v1'),

  // For the dashboard's on-demand "Run" buttons: a token + repo so the web layer
  // can call GitHub's workflow_dispatch API. Optional — without them the dispatch
  // endpoint returns a clear error and the dashboard buttons are inert.
  GITHUB_TOKEN: z.string().optional().default(''),
  GITHUB_REPO: z.string().optional().default(''),   // "owner/name"
  GITHUB_REF: z.string().default('main'),            // branch the workflow lives on

  PORT: z.coerce.number().default(4317),
});

export const config = schema.parse(process.env);

export const has = {
  anthropic: () => config.ANTHROPIC_API_KEY.length > 0,
  colaCloud: () => config.COLACLOUD_API_KEY.length > 0,
  githubDispatch: () => config.GITHUB_TOKEN.length > 0 && config.GITHUB_REPO.length > 0,
};
