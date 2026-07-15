/**
 * CacheService - Centralized caching for metadata and other expensive operations
 * Provides TTL-based caching with static storage shared across service instances
 */

import { EntityMetadata, AttributeMetadata, OptionSetMetadata } from '../types';

/**
 * Interface for cached metadata with timestamp for TTL validation
 */
export interface CachedMetadata<T> {
  data: T;
  timestamp: number;
}

/**
 * Default cache TTL in milliseconds (5 minutes)
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum cache sizes to prevent unbounded memory growth
 */
const MAX_ENTITY_CACHE_SIZE = 50;
const MAX_ATTRIBUTE_CACHE_PER_ENTITY = 100;
const MAX_OPTIONSET_CACHE_SIZE = 200;

/**
 * Static cache storage - shared across all service instances
 */
class CacheStorage {
  static entityMetadata = new Map<string, CachedMetadata<EntityMetadata>>();
  static attributeMetadata = new Map<string, Map<string, CachedMetadata<AttributeMetadata>>>();
  static optionSetMetadata = new Map<string, CachedMetadata<OptionSetMetadata>>();
  
  // LRU tracking - maps keys to last access timestamp
  static entityMetadataAccess = new Map<string, number>();
  static attributeMetadataAccess = new Map<string, number>();
  static optionSetMetadataAccess = new Map<string, number>();
  
  // Performance metrics
  static hits = 0;
  static misses = 0;
  static evictions = 0;
  
  // Periodic cleanup timer
  static cleanupInterval: number | null = null;
  static readonly CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
}

/**
 * CacheService provides TTL-based caching for expensive metadata operations
 */
export class CacheService {
  
  /**
   * Check if a cached item is still valid based on TTL
   */
  static isCacheValid(timestamp: number, ttlMs: number = CACHE_TTL_MS): boolean {
    return Date.now() - timestamp < ttlMs;
  }

  /**
   * Evict least recently used entries from cache when size limit is exceeded
   * @param cache The cache map to evict from
   * @param accessMap The access tracking map
   * @param maxSize Maximum allowed size
   */
  private static evictLRU<T>(
    cache: Map<string, T>,
    accessMap: Map<string, number>,
    maxSize: number
  ): void {
    if (cache.size <= maxSize) return;

    // Sort entries by last access time (oldest first)
    const entries = Array.from(accessMap.entries())
      .sort((a, b) => a[1] - b[1]);

    // Remove oldest entries until we're at or below maxSize
    const toRemove = cache.size - maxSize;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      const key = entries[i][0];
      cache.delete(key);
      accessMap.delete(key);
      CacheStorage.evictions++;
    }
  }

  /**
   * Start periodic cleanup timer (auto-started on first cache access)
   */
  private static startPeriodicCleanup(): void {
    CacheStorage.cleanupInterval ??= window.setInterval(() => {
      this.cleanupExpiredEntries();
    }, CacheStorage.CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop periodic cleanup timer
   */
  static stopPeriodicCleanup(): void {
    if (CacheStorage.cleanupInterval) {
      clearInterval(CacheStorage.cleanupInterval);
      CacheStorage.cleanupInterval = null;
    }
  }

  // ============================================================================
  // Entity Metadata Cache
  // ============================================================================

  /**
   * Get cached entity metadata if valid
   */
  static getEntityMetadata(entityName: string): EntityMetadata | null {
    const cached = CacheStorage.entityMetadata.get(entityName);
    if (cached && this.isCacheValid(cached.timestamp)) {
      // Update access time for LRU
      CacheStorage.entityMetadataAccess.set(entityName, Date.now());
      CacheStorage.hits++;
      return cached.data;
    }
    // Remove expired entry
    if (cached) {
      CacheStorage.entityMetadata.delete(entityName);
      CacheStorage.entityMetadataAccess.delete(entityName);
    }
    CacheStorage.misses++;
    return null;
  }

  /**
   * Store entity metadata in cache
   */
  static setEntityMetadata(entityName: string, metadata: EntityMetadata): void {
    const now = Date.now();
    CacheStorage.entityMetadata.set(entityName, {
      data: metadata,
      timestamp: now
    });
    CacheStorage.entityMetadataAccess.set(entityName, now);
    
    // Start periodic cleanup on first cache usage
    this.startPeriodicCleanup();
    
    // Enforce size limit
    this.evictLRU(
      CacheStorage.entityMetadata,
      CacheStorage.entityMetadataAccess,
      MAX_ENTITY_CACHE_SIZE
    );
  }

  // ============================================================================
  // Attribute Metadata Cache
  // ============================================================================

  /**
   * Get cached attribute metadata if valid
   */
  static getAttributeMetadata(entityName: string, attributeName: string): AttributeMetadata | null {
    const entityCache = CacheStorage.attributeMetadata.get(entityName);
    if (!entityCache) {
      CacheStorage.misses++;
      return null;
    }
    
    const cached = entityCache.get(attributeName);
    if (cached && this.isCacheValid(cached.timestamp)) {
      // Update access time for LRU
      const key = `${entityName}:${attributeName}`;
      CacheStorage.attributeMetadataAccess.set(key, Date.now());
      CacheStorage.hits++;
      return cached.data;
    }
    // Remove expired entry
    if (cached) {
      const key = `${entityName}:${attributeName}`;
      entityCache.delete(attributeName);
      CacheStorage.attributeMetadataAccess.delete(key);
    }
    CacheStorage.misses++;
    return null;
  }

  /**
   * Store attribute metadata in cache
   */
  static setAttributeMetadata(entityName: string, attributeName: string, metadata: AttributeMetadata): void {
    let entityCache = CacheStorage.attributeMetadata.get(entityName);
    if (!entityCache) {
      entityCache = new Map();
      CacheStorage.attributeMetadata.set(entityName, entityCache);
    }
    
    const now = Date.now();
    entityCache.set(attributeName, {
      data: metadata,
      timestamp: now
    });
    
    const key = `${entityName}:${attributeName}`;
    CacheStorage.attributeMetadataAccess.set(key, now);
    
    // Start periodic cleanup on first cache usage
    this.startPeriodicCleanup();
    
    // Enforce per-entity size limit
    if (entityCache.size > MAX_ATTRIBUTE_CACHE_PER_ENTITY) {
      // Get all keys for this entity
      const entityKeys = Array.from(CacheStorage.attributeMetadataAccess.entries())
        .filter(([k]) => k.startsWith(`${entityName}:`))
        .sort((a, b) => a[1] - b[1]);
      
      // Remove oldest entries until we're at the limit
      const toRemove = entityCache.size - MAX_ATTRIBUTE_CACHE_PER_ENTITY;
      for (let i = 0; i < toRemove && i < entityKeys.length; i++) {
        // Extract attribute name (everything after 'entityName:')
        const attrName = entityKeys[i][0].substring(entityName.length + 1);
        entityCache.delete(attrName);
        CacheStorage.attributeMetadataAccess.delete(entityKeys[i][0]);
        CacheStorage.evictions++;
      }
    }
  }

  // ============================================================================
  // OptionSet Metadata Cache
  // ============================================================================

  /**
   * Generate cache key for OptionSet metadata
   */
  static getOptionSetCacheKey(entityName: string, attributeName: string): string {
    return `${entityName}:${attributeName}`;
  }

  /**
   * Get cached OptionSet metadata if valid
   */
  static getOptionSetMetadata(entityName: string, attributeName: string): OptionSetMetadata | null {
    const cacheKey = this.getOptionSetCacheKey(entityName, attributeName);
    const cached = CacheStorage.optionSetMetadata.get(cacheKey);
    if (cached && this.isCacheValid(cached.timestamp)) {
      // Update access time for LRU
      CacheStorage.optionSetMetadataAccess.set(cacheKey, Date.now());
      CacheStorage.hits++;
      return cached.data;
    }
    // Remove expired entry
    if (cached) {
      CacheStorage.optionSetMetadata.delete(cacheKey);
      CacheStorage.optionSetMetadataAccess.delete(cacheKey);
    }
    CacheStorage.misses++;
    return null;
  }

  /**
   * Store OptionSet metadata in cache
   */
  static setOptionSetMetadata(entityName: string, attributeName: string, metadata: OptionSetMetadata): void {
    const cacheKey = this.getOptionSetCacheKey(entityName, attributeName);
    const now = Date.now();
    CacheStorage.optionSetMetadata.set(cacheKey, {
      data: metadata,
      timestamp: now
    });
    CacheStorage.optionSetMetadataAccess.set(cacheKey, now);
    
    // Start periodic cleanup on first cache usage
    this.startPeriodicCleanup();
    
    // Enforce size limit
    this.evictLRU(
      CacheStorage.optionSetMetadata,
      CacheStorage.optionSetMetadataAccess,
      MAX_OPTIONSET_CACHE_SIZE
    );
  }

  /**
   * Clean up all expired cache entries
   * Call periodically to prevent memory leaks in long-running sessions
   */
  static cleanupExpiredEntries(): void {
    let expiredCount = 0;
    
    // Cleanup entity metadata
    for (const [key, cached] of CacheStorage.entityMetadata.entries()) {
      if (!this.isCacheValid(cached.timestamp)) {
        CacheStorage.entityMetadata.delete(key);
        CacheStorage.entityMetadataAccess.delete(key);
        expiredCount++;
      }
    }

    // Cleanup attribute metadata
    for (const [entityName, entityCache] of CacheStorage.attributeMetadata.entries()) {
      for (const [attrName, cached] of entityCache.entries()) {
        if (!this.isCacheValid(cached.timestamp)) {
          entityCache.delete(attrName);
          const key = `${entityName}:${attrName}`;
          CacheStorage.attributeMetadataAccess.delete(key);
          expiredCount++;
        }
      }
      // Remove empty entity caches
      if (entityCache.size === 0) {
        CacheStorage.attributeMetadata.delete(entityName);
      }
    }

    // Cleanup OptionSet metadata
    for (const [key, cached] of CacheStorage.optionSetMetadata.entries()) {
      if (!this.isCacheValid(cached.timestamp)) {
        CacheStorage.optionSetMetadata.delete(key);
        CacheStorage.optionSetMetadataAccess.delete(key);
        expiredCount++;
      }
    }

    // Log stats if any cleanup occurred
    if (expiredCount > 0) {
      void import('./LoggerService').then(({ LoggerService }) => {
        const totalSize = CacheStorage.entityMetadata.size +
          Array.from(CacheStorage.attributeMetadata.values()).reduce((s, m) => s + m.size, 0) +
          CacheStorage.optionSetMetadata.size;
        return LoggerService.debug(`Cache cleanup: removed ${expiredCount} expired entries. Total remaining: ${totalSize}`);
      }).catch(() => undefined);
    }

    // Check for memory pressure and handle if needed
    if (this.isMemoryPressureHigh()) {
      this.handleMemoryPressure();
    }
  }

  /**
   * Detect if memory pressure is high
   * Uses Chrome's performance.memory API if available, otherwise uses heuristic
   */
  static isMemoryPressureHigh(): boolean {
    // Chrome only: performance.memory
    if ('memory' in performance) {
      const perfWithMemory = performance as Performance & { memory: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
      const usedHeap = perfWithMemory.memory.usedJSHeapSize;
      const totalHeap = perfWithMemory.memory.jsHeapSizeLimit;
      
      // Defensive check for valid values
      if (totalHeap > 0 && usedHeap >= 0) {
        return usedHeap / totalHeap > 0.85; // 85% threshold
      }
    }
    
    // Fallback heuristic: total cache entry count
    const totalEntries = 
      CacheStorage.entityMetadata.size +
      Array.from(CacheStorage.attributeMetadata.values())
        .reduce((sum, m) => sum + m.size, 0) +
      CacheStorage.optionSetMetadata.size;
    
    return totalEntries > 400; // Heuristic threshold
  }

  /**
   * Handle high memory pressure by aggressively evicting cache entries
   * Reduces max sizes by 50%
   */
  static handleMemoryPressure(): void {
    // Reduce entity metadata cache by 50%
    this.evictLRU(
      CacheStorage.entityMetadata,
      CacheStorage.entityMetadataAccess,
      Math.floor(MAX_ENTITY_CACHE_SIZE / 2)
    );

    // Reduce attribute metadata cache by 50% for each entity
    for (const [entityName, entityCache] of CacheStorage.attributeMetadata.entries()) {
      const targetSize = Math.floor(MAX_ATTRIBUTE_CACHE_PER_ENTITY / 2);
      if (entityCache.size > targetSize) {
        const entityKeys = Array.from(CacheStorage.attributeMetadataAccess.entries())
          .filter(([k]) => k.startsWith(`${entityName}:`))
          .sort((a, b) => a[1] - b[1]);
        
        const toRemove = entityCache.size - targetSize;
        for (let i = 0; i < toRemove && i < entityKeys.length; i++) {
          // Extract attribute name (everything after 'entityName:')
          const attrName = entityKeys[i][0].substring(entityName.length + 1);
          entityCache.delete(attrName);
          CacheStorage.attributeMetadataAccess.delete(entityKeys[i][0]);
          CacheStorage.evictions++;
        }
      }
      
      // Remove empty entity caches
      if (entityCache.size === 0) {
        CacheStorage.attributeMetadata.delete(entityName);
      }
    }

    // Reduce optionset metadata cache by 50%
    this.evictLRU(
      CacheStorage.optionSetMetadata,
      CacheStorage.optionSetMetadataAccess,
      Math.floor(MAX_OPTIONSET_CACHE_SIZE / 2)
    );

    void import('./LoggerService').then(({ LoggerService }) => {
      return LoggerService.warn('Cache memory pressure detected — aggressively evicted entries');
    }).catch(() => undefined);
  }
}
