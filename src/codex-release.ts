/** Optional public release metadata, never used to choose or install a native executable. */
export async function latestCodexVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher('https://registry.npmjs.org/@openai/codex/latest', {
      signal: AbortSignal.timeout(4000), headers: { 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('name' in data) || data.name !== '@openai/codex' ||
        !('version' in data) || typeof data.version !== 'string' || data.version.length > 64 || !/^\d+\.\d+\.\d+$/u.test(data.version)) return null;
    return data.version;
  } catch { return null; }
}
