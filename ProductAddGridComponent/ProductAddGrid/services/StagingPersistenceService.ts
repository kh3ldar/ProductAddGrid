/**
 * StagingPersistenceService - Persists staged products to localStorage
 * Enables restoration of staging state when component is reopened
 * 
 * Features:
 * - TTL-based expiry (7 days)
 * - Stock reconciliation for entities with validateStockBeforeSave
 * - Debounced saving to minimize localStorage writes
 */

import { 
  PersistedStagingState, 
  PersistedPriceRequestState,
  StagedProduct, 
  WriteInRow, 
  FieldValue,
  ProductRequestRow,
  StockReconciliationResult 
} from '../types';
import { LoggerService } from './LoggerService';

/** Time-to-live for persisted state (7 days in milliseconds) */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage key prefixes */
const STORAGE_KEY_PREFIX_STAGING = 'productaddgrid_staging';
const STORAGE_KEY_PREFIX_PRODUCT_REQUEST = 'productaddgrid_staging_pricerequest';

/**
 * Persistence types supported by the service
 */
type PersistenceType = 'staging' | 'productRequest';

/**
 * Type-safe union of persisted state types
 */
type PersistedState = PersistedStagingState | PersistedPriceRequestState;

/**
 * Shape of a payload passed to the save pipeline (staging or product request)
 */
interface SaveData {
  stagedProducts?: StagedProduct[];
  writeInRows?: WriteInRow[] | ProductRequestRow[];
  writeInEditedValues?: Record<string, Record<string, FieldValue>>;
  catalogRows?: ProductRequestRow[];
  catalogEditedValues?: Record<string, Record<string, FieldValue>>;
}

/**
 * Generate the localStorage key for a specific context and type
 * Includes variant key to prevent collision between entity variants
 */
function getStorageKey(
  type: PersistenceType,
  parentEntity: string,
  parentRecordId: string,
  parentVariantKey?: string
): string {
  const prefix = type === 'staging' ? STORAGE_KEY_PREFIX_STAGING : STORAGE_KEY_PREFIX_PRODUCT_REQUEST;
  const base = `${prefix}_${parentEntity}_${parentRecordId}`;
  return parentVariantKey ? `${base}_${parentVariantKey}` : base;
}

export class StagingPersistenceService {
  private parentEntity: string;
  private parentRecordId: string;
  private parentVariantKey?: string;
  private stagingStorageKey: string;
  private productRequestStorageKey: string;
  private saveTimeouts = new Map<PersistenceType, ReturnType<typeof setTimeout>>();
  /** Latest not-yet-written payload per type, so a flush (e.g. on unmount) can persist it */
  private pendingSaves = new Map<PersistenceType, { data: SaveData; storageKey: string }>();
  private readonly debounceMs = 1000; // 1 second debounce
  private storageListener?: (e: StorageEvent) => void;
  private crossTabConflictDetected = false;

  constructor(parentEntity: string, parentRecordId: string, parentVariantKey?: string) {
    this.parentEntity = parentEntity;
    this.parentRecordId = parentRecordId;
    this.parentVariantKey = parentVariantKey;
    this.stagingStorageKey = getStorageKey('staging', parentEntity, parentRecordId, parentVariantKey);
    this.productRequestStorageKey = getStorageKey('productRequest', parentEntity, parentRecordId, parentVariantKey);
    
    // Listen for changes from other tabs (both staging and product request)
    this.storageListener = (e: StorageEvent) => {
      if ((e.key === this.stagingStorageKey || e.key === this.productRequestStorageKey) && e.newValue !== null) {
        this.handleCrossTabChange(e.newValue);
      }
    };
    window.addEventListener('storage', this.storageListener);
  }

  /**
   * Save staging state to localStorage (debounced)
   * Automatically called when staging changes
   */
  save(
    stagedProducts: StagedProduct[],
    writeInRows?: WriteInRow[],
    writeInEditedValues?: Record<string, Record<string, FieldValue>>
  ): void {
    this.saveTyped('staging', {
      stagedProducts,
      writeInRows,
      writeInEditedValues
    });
  }

  /**
   * Save product request state to localStorage (debounced)
   * Used by ProductRequestsManager for price/acquisition requests
   */
  saveProductRequest(
    catalogRows: ProductRequestRow[],
    catalogEditedValues: Record<string, Record<string, FieldValue>>,
    writeInRows: ProductRequestRow[],
    writeInEditedValues: Record<string, Record<string, FieldValue>>
  ): void {
    this.saveTyped('productRequest', {
      catalogRows,
      catalogEditedValues,
      writeInRows,
      writeInEditedValues
    });
  }

  /**
   * Internal typed save method
   */
  private saveTyped(
    type: PersistenceType,
    data: SaveData
  ): void {
    const storageKey = type === 'staging' ? this.stagingStorageKey : this.productRequestStorageKey;
    

    // Cancel any pending save for this type
    const existingTimeout = this.saveTimeouts.get(type);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Don't save if nothing to persist
    const isEmpty = type === 'staging'
      ? (data.stagedProducts?.length ?? 0) === 0 && (data.writeInRows?.length ?? 0) === 0
      : (data.catalogRows?.length ?? 0) === 0 && !(data.writeInRows ?? []).some((row) => {
          const ev = data.writeInEditedValues?.[(row as ProductRequestRow)._tempId] ?? {};
          return Boolean(ev.productdescription) || Boolean(ev.quantity);
        });

    if (isEmpty) {
      this.clear(type);
      return;
    }

    // Record the latest payload so destroy()/flush() can persist it if the
    // debounce window hasn't elapsed yet (e.g. user closes the dialog quickly).
    this.pendingSaves.set(type, { data, storageKey });

    // Debounce the save
    const timeout = setTimeout(() => {
      this.saveImmediate(type, data, storageKey);
      // Clean up timeout + pending payload from maps after execution
      this.saveTimeouts.delete(type);
      this.pendingSaves.delete(type);
    }, this.debounceMs);

    this.saveTimeouts.set(type, timeout);
  }

  /**
   * Save immediately without debounce (used internally and for forced saves)
   */
  private saveImmediate(
    type: PersistenceType,
    data: SaveData,
    storageKey: string
  ): void {
    try {
      let state: PersistedState;
      
      if (type === 'staging') {
        state = {
          parentEntity: this.parentEntity,
          parentRecordId: this.parentRecordId,
          parentVariantKey: this.parentVariantKey,
          timestamp: Date.now(),
          stagedProducts: data.stagedProducts ?? [],
          writeInRows: data.writeInRows as WriteInRow[] | undefined,
          writeInEditedValues: data.writeInEditedValues
        };
      } else {
        state = {
          parentEntity: this.parentEntity,
          parentRecordId: this.parentRecordId,
          timestamp: Date.now(),
          catalogRows: data.catalogRows ?? [],
          catalogEditedValues: data.catalogEditedValues ?? {},
          writeInRows: data.writeInRows as ProductRequestRow[] ?? [],
          writeInEditedValues: data.writeInEditedValues ?? {}
        };
      }

      const serialized = JSON.stringify(state);
      const success = this.safeSetItem(storageKey, serialized);
      
      if (success) {
        // Log usage warning if high
        const usage = StagingPersistenceService.getLocalStorageUsage();
        if (usage.percentage > 80) {
          LoggerService.warn(`localStorage usage high: ${usage.percentage.toFixed(1)}%`);
        }
      }
    } catch (error) {
      LoggerService.error(`Failed to save ${type} state:`, error);
    }
  }

  /**
   * Load staging state from localStorage
   * Returns null if not found, expired, or invalid
   */
  load(): PersistedStagingState | null {
    return this.loadTyped('staging') as PersistedStagingState | null;
  }

  /**
   * Load product request state from localStorage
   * Returns null if not found, expired, or invalid
   */
  loadProductRequest(): PersistedPriceRequestState | null {
    return this.loadTyped('productRequest') as PersistedPriceRequestState | null;
  }

  /**
   * Internal typed load method
   */
  private loadTyped(type: PersistenceType): PersistedState | null {
    const storageKey = type === 'staging' ? this.stagingStorageKey : this.productRequestStorageKey;
    
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        return null;
      }

      const state = JSON.parse(raw) as PersistedState;

      // Validate structure and timestamp type
      if (!state.parentEntity || !state.parentRecordId || 
          typeof state.timestamp !== 'number' || isNaN(state.timestamp)) {
        this.clear(type);
        return null;
      }

      // Check TTL expiry
      const age = Date.now() - state.timestamp;
      if (age > TTL_MS || age < 0) { // age < 0 means timestamp is in the future
        this.clear(type);
        return null;
      }

      // Validate it's for the same context (entity + record + optional variant)
      const variantMatch = type === 'staging'
        ? (state as PersistedStagingState).parentVariantKey === this.parentVariantKey
        : true; // Product requests don't use variant keys
        
      if (state.parentEntity !== this.parentEntity || 
          state.parentRecordId !== this.parentRecordId ||
          !variantMatch) {
        this.clear(type);
        return null;
      }

      return state;
    } catch (error) {
      LoggerService.error(`Failed to load ${type} state:`, error);
      this.clear(type);
      return null;
    }
  }

  /**
   * Clear staging state from localStorage
   * Called on successful save or explicit clear
   * @param type - Type of persistence to clear (defaults to 'staging' for backward compatibility)
   */
  clear(type: PersistenceType = 'staging'): void {
    const storageKey = type === 'staging' ? this.stagingStorageKey : this.productRequestStorageKey;
    
    
    // Cancel any pending save for this type (and drop its queued payload so a
    // later flush can't resurrect state we're explicitly clearing).
    const existingTimeout = this.saveTimeouts.get(type);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.saveTimeouts.delete(type);
    }
    this.pendingSaves.delete(type);

    try {
      localStorage.removeItem(storageKey);
    } catch (error) {
      LoggerService.error(`Failed to clear ${type} state:`, error);
    }
  }

  /**
   * Reconcile restored staging with current stock levels
   * For entities with validateStockBeforeSave: true
   * 
   * @param restoredProducts - Products from localStorage
   * @param getStockFn - Async function to fetch current stock by product ID
   * @returns Reconciliation result with valid products, adjustments, and removals
   */
  async reconcileStock(
    restoredProducts: StagedProduct[],
    getStockFn: (productIds: string[]) => Promise<Map<string, number>>
  ): Promise<StockReconciliationResult> {
    // Filter to only catalog products (not write-ins)
    const catalogProducts = restoredProducts.filter(sp => !sp.isWriteIn && sp.productId);
    const writeInProducts = restoredProducts.filter(sp => sp.isWriteIn);

    if (catalogProducts.length === 0) {
      return {
        validProducts: writeInProducts,
        adjustments: [],
        removed: []
      };
    }

    // Fetch current stock
    const productIds = catalogProducts.map(sp => sp.productId);
    let stockMap: Map<string, number>;
    
    try {
      stockMap = await getStockFn(productIds);
    } catch (error) {
      LoggerService.error('Failed to fetch stock for reconciliation:', error);
      // On error, return all products as valid (don't lose user's work)
      return {
        validProducts: restoredProducts,
        adjustments: [],
        removed: []
      };
    }

    const validProducts: StagedProduct[] = [...writeInProducts];
    const adjustments: StockReconciliationResult['adjustments'] = [];
    const removed: StagedProduct[] = [];

    for (const product of catalogProducts) {
      const currentStock = stockMap.get(product.productId);
      const stagedQuantity = product.quantity ?? 0;

      // Product not found in stock query (possibly deleted)
      if (currentStock === undefined) {
        removed.push(product);
        continue;
      }

      // No stock available
      if (currentStock <= 0) {
        removed.push(product);
        continue;
      }

      // Quantity exceeds available stock
      if (stagedQuantity > currentStock) {
        const adjustedProduct = {
          ...product,
          quantity: currentStock
        };
        validProducts.push(adjustedProduct);
        adjustments.push({
          product: adjustedProduct,
          oldQuantity: stagedQuantity,
          newQuantity: currentStock
        });
        continue;
      }

      // Product is valid as-is
      validProducts.push(product);
    }

    return { validProducts, adjustments, removed };
  }

  /**
   * Clean up old entries across all contexts for both staging types
   * Called periodically to prevent localStorage bloat
   * Fixed: Collects all keys first to avoid race conditions
   */
  static cleanupExpired(): void {
    try {
      // Collect all localStorage keys first to avoid race conditions
      const allKeys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
          allKeys.push(key);
        }
      }

      // Filter to staging keys (both types) and check expiry
      const keysToRemove: string[] = [];
      
      for (const key of allKeys) {
        if (!key.startsWith(STORAGE_KEY_PREFIX_STAGING) && 
            !key.startsWith(STORAGE_KEY_PREFIX_PRODUCT_REQUEST)) {
          continue;
        }

        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;

          const state = JSON.parse(raw) as PersistedState;
          
          // Validate timestamp is a valid number
          if (typeof state.timestamp !== 'number' || isNaN(state.timestamp)) {
            keysToRemove.push(key);
            continue;
          }
          
          const age = Date.now() - state.timestamp;
          
          if (age > TTL_MS) {
            keysToRemove.push(key);
          }
        } catch {
          // Invalid JSON, remove it
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach(key => localStorage.removeItem(key));
      
      if (keysToRemove.length > 0) {
        LoggerService.debug(`Removed ${keysToRemove.length} expired staging persistence entries`);
      }
    } catch (error) {
      LoggerService.error('Failed to cleanup expired entries:', error);
    }
  }

  /**
   * Get localStorage usage statistics
   */
  private static getLocalStorageUsage(): { used: number; available: number; percentage: number } {
    let used = 0;
    
    // Properly iterate localStorage using indices
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        const value = localStorage.getItem(key);
        if (value) {
          used += value.length + key.length;
        }
      }
    }
    
    // Typical quota: 5-10MB, use conservative 5MB
    const QUOTA_BYTES = 5 * 1024 * 1024;
    return {
      used,
      available: QUOTA_BYTES - used,
      percentage: (used / QUOTA_BYTES) * 100
    };
  }

  /**
   * Safely set item in localStorage with quota handling
   * @returns true if successful, false otherwise
   */
  private safeSetItem(key: string, value: string): boolean {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        
        // Try cleanup and retry (exclude current instance's keys)
        StagingPersistenceService.cleanupOldestProductAddGridEntries([
          this.stagingStorageKey,
          this.productRequestStorageKey
        ]);
        
        try {
          localStorage.setItem(key, value);
          return true;
        } catch (retryError) {
          LoggerService.error('localStorage save failed even after cleanup', retryError);
          return false;
        }
      } else {
        LoggerService.error('localStorage setItem failed', e);
        return false;
      }
    }
  }

  /**
   * Remove oldest ProductAddGrid entries from localStorage
   * Called when quota is exceeded
   * @param excludeKeys - Keys to exclude from cleanup (e.g., current instance's keys)
   */
  private static cleanupOldestProductAddGridEntries(excludeKeys: string[] = []): void {
    const ourKeys: { key: string; timestamp: number }[] = [];
    
    // Find all ProductAddGrid keys with timestamps
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('productaddgrid_') && !excludeKeys.includes(key)) {
        try {
          const value = localStorage.getItem(key);
          if (value) {
            const data = JSON.parse(value) as { timestamp?: number };
            ourKeys.push({ key, timestamp: data.timestamp ?? 0 });
          }
        } catch {
          // Invalid JSON, add to removal list with timestamp 0
          ourKeys.push({ key, timestamp: 0 });
        }
      }
    }
    
    if (ourKeys.length === 0) {
      return;
    }
    
    // Sort by timestamp (oldest first)
    ourKeys.sort((a, b) => a.timestamp - b.timestamp);
    
    // Remove oldest 30%, but at least 1 and at most 10 entries
    const toRemove = Math.max(1, Math.min(10, Math.ceil(ourKeys.length * 0.3)));
    for (let i = 0; i < toRemove; i++) {
      localStorage.removeItem(ourKeys[i].key);
    }
    
  }

  /**
   * Handle cross-tab storage changes
   */
  private handleCrossTabChange(newValue: string): void {
    try {
      const externalState = JSON.parse(newValue) as PersistedState;
      
      // Determine what was modified based on state structure
      const _isStaging = 'stagedProducts' in externalState;
      
      // Store flag for UI to handle
      this.crossTabConflictDetected = true;
    } catch (error) {
      LoggerService.error('Failed to parse cross-tab staging change', error);
    }
  }

  /**
   * Check if cross-tab conflict was detected
   */
  hasCrossTabConflict(): boolean {
    return this.crossTabConflictDetected;
  }

  /**
   * Clear cross-tab conflict flag
   */
  clearCrossTabConflict(): void {
    this.crossTabConflictDetected = false;
  }

  /**
   * Immediately persist any debounced-but-not-yet-written payloads.
   * Cancels the pending timers and writes their latest state synchronously.
   * Called on destroy() so closing the dialog within the debounce window
   * does not lose the user's most recent staging changes.
   */
  flush(): void {
    for (const [type, timer] of this.saveTimeouts.entries()) {
      clearTimeout(timer);
      const pending = this.pendingSaves.get(type);
      if (pending) {
        this.saveImmediate(type, pending.data, pending.storageKey);
      }
    }
    this.saveTimeouts.clear();
    this.pendingSaves.clear();
  }

  /**
   * Destroy service and cleanup listeners
   */
  destroy(): void {
    // Persist any pending debounced writes before tearing down
    this.flush();

    // Remove event listener
    if (this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
      this.storageListener = undefined;
    }
  }
}
