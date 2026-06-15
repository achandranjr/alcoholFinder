import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  COLACLOUD_API_KEY: z.string().optional().default(''),
  COLACLOUD_BASE_URL: z.string().default('https://colacloud.us/api'),

  OPENBREWERYDB_BASE_URL: z.string().default('https://api.openbrewerydb.org/v1'),

  PORT: z.coerce.number().default(4317),
});

export const config = schema.parse(process.env);

export const has = {
  anthropic: () => config.ANTHROPIC_API_KEY.length > 0,
  colaCloud: () => config.COLACLOUD_API_KEY.length > 0,
};
