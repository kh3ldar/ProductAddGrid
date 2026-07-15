/**
 * Shared utility for generating unique IDs
 * Uses crypto.randomUUID() when available, falls back to timestamp + random string
 */

/**
 * Generate a unique ID with the specified prefix
 * @param prefix - The prefix to prepend to the generated ID (e.g., 'staged', 'writein')
 * @returns A unique identifier string
 */
export function generateUniqueId(prefix: string): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi?.randomUUID) {
    try {
      return `${prefix}_${cryptoApi.randomUUID()}`;
    } catch {
      // Fallback below
    }
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generate a unique ID for staged products
 * @returns A unique identifier prefixed with 'staged_'
 */
export const generateStagedProductId = (): string => generateUniqueId('staged');

/**
 * Generate a unique ID for write-in product rows
 * @returns A unique identifier prefixed with 'writein_'
 */
export const generateWriteInTempId = (): string => generateUniqueId('writein');
