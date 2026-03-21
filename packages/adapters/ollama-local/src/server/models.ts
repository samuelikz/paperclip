import type { AdapterModel } from "@paperclipai/adapter-utils";

const DEFAULT_BASE_URL = "http://localhost:11434";
const MODELS_CACHE_TTL_MS = 60_000;

interface OllamaTagEntry {
  name: string;
  size?: number;
  modified_at?: string;
}

interface OllamaTagsResponse {
  models: OllamaTagEntry[];
}

function parseOllamaTagsResponse(body: unknown): AdapterModel[] {
  if (typeof body !== "object" || body === null) return [];
  const response = body as OllamaTagsResponse;
  if (!Array.isArray(response.models)) return [];
  const out: AdapterModel[] = [];
  for (const entry of response.models) {
    if (typeof entry.name !== "string" || !entry.name.trim()) continue;
    const name = entry.name.trim();
    out.push({ id: name, label: name });
  }
  return out;
}

export async function listOllamaModels(baseUrl: string): Promise<AdapterModel[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    return parseOllamaTagsResponse(body);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function discoverOllamaModels(baseUrl: string): Promise<AdapterModel[]> {
  return listOllamaModels(baseUrl);
}

// ---------------------------------------------------------------------------
// In-memory cache keyed by normalized baseUrl
// ---------------------------------------------------------------------------

const modelsCache = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

function pruneExpiredCache(now: number) {
  for (const [key, value] of modelsCache.entries()) {
    if (value.expiresAt <= now) modelsCache.delete(key);
  }
}

export async function listOllamaModelsCached(
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<AdapterModel[]> {
  const key = baseUrl.trim().toLowerCase().replace(/\/$/, "");
  const now = Date.now();
  pruneExpiredCache(now);
  const cached = modelsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await listOllamaModels(baseUrl);
  modelsCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

export function resetOllamaModelsCacheForTests() {
  modelsCache.clear();
}

export { DEFAULT_BASE_URL };
