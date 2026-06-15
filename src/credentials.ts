import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-source credential store for user-added sources, kept out of both the
 * generated connector files and the env. Lives in data/credentials.json
 * (gitignored) as { [sourceId]: { [field]: value } }.
 */
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'credentials.json');

type Store = Record<string, Record<string, string>>;

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf8')) as Store;
  } catch {
    cache = {};
  }
  return cache;
}

export function getCredentials(sourceId: string): Record<string, string> {
  return load()[sourceId] ?? {};
}

export function setCredentials(sourceId: string, creds: Record<string, string>): void {
  const store = load();
  store[sourceId] = { ...store[sourceId], ...creds };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}
