// Returns the list out of a Hub REST response regardless of envelope shape.
// Prefers the future `{ data: [...] }` standard, then a bare array, then the
// first of the given legacy wrapper keys that holds an array. [] otherwise.
export function unwrapList<T = unknown>(res: unknown, legacyKeys: string[] = []): T[] {
  if (res && typeof res === "object" && Array.isArray((res as Record<string, unknown>).data)) {
    return (res as Record<string, unknown>).data as T[];
  }
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    for (const k of legacyKeys) {
      const v = obj[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}
