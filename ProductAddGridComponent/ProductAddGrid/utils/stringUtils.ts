/**
 * String utility functions for the ProductAddGrid PCF control
 * Provides memoized/cached string operations for performance optimization
 */

/**
 * Cache for normalized keys to avoid repeated toLowerCase() calls
 * Extracted from DataService.ts to be reusable across the codebase
 * Size-limited to prevent memory leaks in long-running sessions
 */
const MAX_NORMALIZE_CACHE_SIZE = 1000;
const normalizeKeyCache = new Map<string, string>();

/**
 * Normalize a key to lowercase for case-insensitive comparisons
 * Results are memoized for performance (avoids repeated toLowerCase() calls)
 * 
 * @param key - The string to normalize
 * @returns Lowercase version of the key, or empty string if undefined/null
 * 
 * @example
 * normalizeKey('ProductName') // returns 'productname'
 * normalizeKey('QUANTITY') // returns 'quantity'
 */
export function normalizeKey(key?: string): string {
  if (!key) {
    return '';
  }

  // Check cache first
  const cached = normalizeKeyCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // Enforce cache size limit to prevent unbounded growth
  if (normalizeKeyCache.size >= MAX_NORMALIZE_CACHE_SIZE) {
    // Remove oldest entry (first entry in insertion order)
    const firstKey = normalizeKeyCache.keys().next().value;
    if (firstKey !== undefined) {
      normalizeKeyCache.delete(firstKey);
    }
  }

  // Compute and cache
  const normalized = key.toLowerCase();
  normalizeKeyCache.set(key, normalized);
  
  return normalized;
}

/**
 * Find a value in a record by suffix matching any publisher-prefixed key.
 * Matches keys where key === suffix or key ends with `_${suffix}` (case-insensitive).
 */
export function findValueBySuffix(
  record: Record<string, unknown>,
  ...suffixes: string[]
): unknown {
  for (const suffix of suffixes) {
    const normalizedSuffix = suffix.toLowerCase();
    for (const key of Object.keys(record)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === normalizedSuffix || normalizedKey.endsWith(`_${normalizedSuffix}`)) {
        return record[key];
      }
    }
  }
  return undefined;
}
