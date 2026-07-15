import * as React from 'react';
import {
  StagedProduct,
  WriteInRow,
  FieldValue,
  VirtualTableRow
} from '../types';
import { StagingPersistenceService, ConfigService } from '../services';
import { findValueBySuffix } from '../utils/stringUtils';
import { generateStagedProductId } from '../utils/idGenerator';

/**
 * Context value interface for staging operations
 */
export interface StagingContextValue {
  // Staged products state
  stagedProducts: StagedProduct[];
  stagedProductsById: Record<string, StagedProduct>;

  // Write-in state
  writeInRows: WriteInRow[];
  writeInEditedValues: Record<string, Record<string, FieldValue>>;

  // Computed values
  stagedWriteInsById: Record<string, StagedProduct>;

  // Actions
  stageProduct: (
    product: VirtualTableRow,
    editedValues: Record<string, FieldValue>,
    existingStagedId?: string
  ) => void;
  removeStaged: (stagedId: string) => void;
  stageWriteIn: (
    row: WriteInRow,
    editedValues: Record<string, FieldValue>,
    existingStagedId?: string
  ) => void;
  updateWriteInRows: (
    rows: WriteInRow[],
    editedValues: Record<string, Record<string, FieldValue>>
  ) => void;
  clearAllStaging: () => void;

  // Persistence
  initializePersistence: (
    parentEntityName: string,
    parentRecordId: string,
    parentVariantKey?: string
  ) => void;
  restoreFromStorage: (getStockFn?: (productIds: string[]) => Promise<Map<string, number>>) => Promise<{
    restored: boolean;
    hasAdjustments: boolean;
    hasRemovals: boolean;
    adjustmentCount: number;
    removalCount: number;
    totalRestored: number;
  }>;
}

/**
 * Context for centralized staging state management
 */
const StagingContext = React.createContext<StagingContextValue | undefined>(undefined);

/**
 * Props for StagingProvider
 */
interface StagingProviderProps {
  children: React.ReactNode;
  configService: ConfigService;
  parentEntityName: string;
}

/**
 * State for StagingProvider
 */
interface StagingProviderState {
  stagedProducts: StagedProduct[];
  writeInRows: WriteInRow[];
  writeInEditedValues: Record<string, Record<string, FieldValue>>;
}

/**
 * Provider component for staging state
 * Manages all staging operations and persistence
 */
export class StagingProvider extends React.PureComponent<
  StagingProviderProps,
  StagingProviderState
> {
  private persistenceService: StagingPersistenceService | null = null;
  private isMounted = false;

  // Performance: Cache computed values
  private cachedStagedProductsById: Record<string, StagedProduct> = {};
  private lastStagedProductsRef: StagedProduct[] = [];
  private cachedStagedWriteInsById: Record<string, StagedProduct> = {};
  private lastStagedWriteInsRef: StagedProduct[] = [];
  private cachedContextValue: StagingContextValue | null = null;

  constructor(props: StagingProviderProps) {
    super(props);

    this.state = {
      stagedProducts: [],
      writeInRows: [],
      writeInEditedValues: {}
    };
  }

  componentDidMount(): void {
    this.isMounted = true;
  }

  componentWillUnmount(): void {
    this.isMounted = false;
    
    // Clean up persistence service
    if (this.persistenceService) {
      this.persistenceService.destroy();
      this.persistenceService = null;
    }
  }

  componentDidUpdate(
    _prevProps: StagingProviderProps,
    prevState: StagingProviderState
  ): void {
    // Persist staging state when it changes (debounced in service)
    const stagingChanged = prevState.stagedProducts !== this.state.stagedProducts;
    const writeInChanged = prevState.writeInRows !== this.state.writeInRows;
    const writeInValuesChanged =
      prevState.writeInEditedValues !== this.state.writeInEditedValues;

    if (
      (stagingChanged || writeInChanged || writeInValuesChanged) &&
      this.persistenceService
    ) {
      // Only persist write-in rows that are currently staged.
      // When a write-in is un-staged via Remove, the row stays in writeInRows
      // but has no corresponding StagedProduct — saving it would cause phantom
      // rows to re-appear on the next restore.
      const stagedWriteInProductIds = new Set(
        this.state.stagedProducts.filter(sp => sp.isWriteIn).map(sp => sp.productId)
      );
      const writeInRowsToSave = this.state.writeInRows.filter(
        row => stagedWriteInProductIds.has(row._tempId)
      );
      const writeInEditedValuesToSave = Object.fromEntries(
        Object.entries(this.state.writeInEditedValues).filter(([tempId]) =>
          stagedWriteInProductIds.has(tempId)
        )
      );


      this.persistenceService.save(
        this.state.stagedProducts,
        writeInRowsToSave,
        writeInEditedValuesToSave
      );
    }
  }

  /**
   * Initialize persistence service
   * Must be called before using any persistence features
   */
  private initializePersistence = (
    parentEntityName: string,
    parentRecordId: string,
    parentVariantKey?: string
  ): void => {

    this.persistenceService = new StagingPersistenceService(
      parentEntityName,
      parentRecordId,
      parentVariantKey
    );

    // Cleanup expired staging entries from other sessions
    StagingPersistenceService.cleanupExpired();
  };

  /**
   * Restore persisted staging state from localStorage
   * Handles stock reconciliation for entities with validateStockBeforeSave
   */
  private restoreFromStorage = async (
    getStockFn?: (productIds: string[]) => Promise<Map<string, number>>
  ): Promise<{
    restored: boolean;
    hasAdjustments: boolean;
    hasRemovals: boolean;
    adjustmentCount: number;
    removalCount: number;
    totalRestored: number;
  }> => {
    if (!this.persistenceService) {
      return {
        restored: false,
        hasAdjustments: false,
        hasRemovals: false,
        adjustmentCount: 0,
        removalCount: 0,
        totalRestored: 0
      };
    }

    const persistedState = this.persistenceService.load();
    if (!persistedState) {
      return {
        restored: false,
        hasAdjustments: false,
        hasRemovals: false,
        adjustmentCount: 0,
        removalCount: 0,
        totalRestored: 0
      };
    }

    const { stagedProducts, writeInRows, writeInEditedValues } = persistedState;

    // If no products to restore, nothing to do
    if (
      (!stagedProducts || stagedProducts.length === 0) &&
      (!writeInRows || writeInRows.length === 0)
    ) {
      return {
        restored: false,
        hasAdjustments: false,
        hasRemovals: false,
        adjustmentCount: 0,
        removalCount: 0,
        totalRestored: 0
      };
    }


    let finalStagedProducts = stagedProducts ?? [];
    let adjustmentCount = 0;
    let removalCount = 0;

    // Reconcile stock levels if getStockFn is provided
    if (getStockFn && finalStagedProducts.length > 0) {
      const reconciliationResult = await this.persistenceService.reconcileStock(
        finalStagedProducts,
        getStockFn
      );

      finalStagedProducts = reconciliationResult.validProducts;
      adjustmentCount = reconciliationResult.adjustments.length;
      removalCount = reconciliationResult.removed.length;

      // All products were removed
      if (finalStagedProducts.length === 0 && (!writeInRows || writeInRows.length === 0)) {
        this.persistenceService.clear();
        return {
          restored: false,
          hasAdjustments: false,
          hasRemovals: true,
          adjustmentCount: 0,
          removalCount,
          totalRestored: 0
        };
      }
    }

    // Restore state
    if (this.isMounted) {
      this.setState({
        stagedProducts: finalStagedProducts,
        writeInRows: writeInRows ?? [],
        writeInEditedValues: writeInEditedValues ?? {}
      });
    }

    // Count only catalog staged products + write-in rows.
    // Write-in staged products are already represented in writeInRows,
    // so using finalStagedProducts.length would double-count them.
    const catalogStagedCount = finalStagedProducts.filter(sp => !sp.isWriteIn).length;
    const totalRestored = catalogStagedCount + (writeInRows?.length ?? 0);

    return {
      restored: true,
      hasAdjustments: adjustmentCount > 0,
      hasRemovals: removalCount > 0,
      adjustmentCount,
      removalCount,
      totalRestored
    };
  };

  /**
   * Stage a catalog product
   */
  private stageProduct = (
    product: VirtualTableRow,
    editedValues: Record<string, FieldValue>,
    existingStagedId?: string
  ): void => {
    // Apply auto-set rules before staging
    const finalEditedValues = this.applyAutoSetRules(product, editedValues);

    this.setState(prevState => {
      const stagedProducts = [...prevState.stagedProducts];
      const productId = product.productid;
      const indexByProductId = stagedProducts.findIndex(sp => sp.productId === productId);
      const indexByStagedId = existingStagedId
        ? stagedProducts.findIndex(sp => sp.id === existingStagedId)
        : -1;
      const resolvedIndex = indexByStagedId >= 0 ? indexByStagedId : indexByProductId;

      // Extract quantity, price, description from final edited values
      const quantityValue = findValueBySuffix(finalEditedValues as Record<string, unknown>, 'quantity');
      const priceValue = findValueBySuffix(finalEditedValues as Record<string, unknown>, 'priceperunit');
      const descriptionValue = finalEditedValues.description;

      const quantity = quantityValue ? Number(quantityValue) : undefined;
      const unitPrice = priceValue ? Number(priceValue) : 0;
      const description =
        typeof descriptionValue === 'string' ? descriptionValue : undefined;

      if (resolvedIndex >= 0) {
        // Update existing staged product
        const existing = stagedProducts[resolvedIndex];
        const updatedProduct: StagedProduct = {
          ...existing,
          product,
          productId,
          quantity,
          unitPrice,
          description,
          editedFields: finalEditedValues,
          validationErrors: []
        };

        stagedProducts[resolvedIndex] = updatedProduct;

        return {
          stagedProducts
        };
      }

      // Create new staged product
      const newStagedProduct: StagedProduct = {
        id: generateStagedProductId(),
        productId,
        product,
        quantity,
        unitPrice,
        description,
        editedFields: finalEditedValues,
        validationErrors: [],
        isWriteIn: false
      };

      stagedProducts.push(newStagedProduct);

      return {
        stagedProducts
      };
    });
  };

  /**
   * Remove a staged product by ID
   */
  private removeStaged = (stagedId: string): void => {
    this.setState(prevState => {
      const remaining = prevState.stagedProducts.filter(sp => sp.id !== stagedId);
      return {
        stagedProducts: remaining
      };
    });
  };

  /**
   * Stage a write-in product
   * Note: Auto-set rules are NOT applied to write-in products since they lack product entity data
   */
  private stageWriteIn = (
    row: WriteInRow,
    editedValues: Record<string, FieldValue>,
    existingStagedId?: string
  ): void => {

    // Get description from productdescription or description field
    const rawProductDescription = editedValues.productdescription;
    const productDescription =
      typeof rawProductDescription === 'string' ? rawProductDescription : '';
    const rawDescription = editedValues.description;
    const description = typeof rawDescription === 'string' ? rawDescription : '';

    this.setState(prevState => {
      const stagedProducts = [...prevState.stagedProducts];

      // Check if we're updating an existing staged item
      const existingIndex = existingStagedId
        ? stagedProducts.findIndex(sp => sp.id === existingStagedId)
        : stagedProducts.findIndex(sp => sp.isWriteIn && sp.productId === row._tempId);

      if (existingIndex >= 0) {
        // Update existing staged write-in
        const existing = stagedProducts[existingIndex];
        const updatedProduct: StagedProduct = {
          ...existing,
          quantity: Number(editedValues.quantity) || 1,
          unitPrice: Number(editedValues.priceperunit) || 0,
          description,
          validationErrors: [],
          editedFields: editedValues,
          productdescription: productDescription
        } as StagedProduct;

        stagedProducts[existingIndex] = updatedProduct;


        return {
          stagedProducts
        };
      } else {
        // Create new staged write-in
        const newStagedProduct: StagedProduct = {
          id: generateStagedProductId(),
          productId: row._tempId,
          product: undefined,
          quantity: Number(editedValues.quantity) || 1,
          unitPrice: Number(editedValues.priceperunit) || 0,
          description,
          validationErrors: [],
          isWriteIn: true,
          editedFields: editedValues,
          productdescription: productDescription
        } as StagedProduct;


        stagedProducts.push(newStagedProduct);

        return {
          stagedProducts
        };
      }
    });
  };

  /**
   * Update write-in rows and edited values
   */
  private updateWriteInRows = (
    rows: WriteInRow[],
    editedValues: Record<string, Record<string, FieldValue>>
  ): void => {
    this.setState({
      writeInRows: rows,
      writeInEditedValues: editedValues
    });
  };

  /**
   * Apply auto-set rules to product data and merge with edited values
   * Supports hidden fields - fields not in view but stored for payload
   * Supports special tokens:
   * - matchValue="*" = match if field has any value (not null/empty)
   * - setValue="$sourceValue" = copy the value from sourceField
   * - overrideValue (optional, default: false) = whether to override user-populated values
   */
  private applyAutoSetRules = (
    product: VirtualTableRow,
    editedValues: Record<string, FieldValue>
  ): Record<string, FieldValue> => {
    const autoSetRules = this.props.configService.getAutoSetRules(
      this.props.parentEntityName
    );

    if (autoSetRules.length === 0) {
      return editedValues;
    }

    const autoSetValues: Record<string, FieldValue> = {};
    let appliedCount = 0;

    for (const rule of autoSetRules) {
      const sourceValue = product[rule.sourceField];
      let conditionMet = false;

      // Check if condition is met
      if (rule.matchValue === '*') {
        // Special case: match if field has any value (not null/undefined/empty)
        conditionMet = sourceValue != null && sourceValue !== '';
      } else {
        // Standard case: exact match (case-insensitive for strings)
        const sourceStr = String(sourceValue ?? '').trim().toUpperCase();
        const matchStr = rule.matchValue.toUpperCase();
        conditionMet = sourceStr === matchStr;
      }

      if (conditionMet) {
        // Check if we should apply this rule based on overrideValue setting
        const overrideValue = rule.overrideValue ?? false;
        const fieldAlreadySet = rule.targetField in editedValues && 
                                editedValues[rule.targetField] != null && 
                                editedValues[rule.targetField] !== '';

        // Skip if field is already set by user and overrideValue is false
        if (fieldAlreadySet && !overrideValue) {
          continue;
        }

        // Determine value to set
        let valueToSet: FieldValue;
        if (rule.setValue === '$sourceValue') {
          // Special case: copy the source value
          valueToSet = sourceValue as FieldValue;
        } else {
          // Standard case: use configured setValue
          valueToSet = rule.setValue as FieldValue;
        }

        autoSetValues[rule.targetField] = valueToSet;
        appliedCount++;
      }
    }

    if (appliedCount > 0) {
      // Merge: auto-set values first, then user editedValues (user always wins for non-override rules)
      return { ...autoSetValues, ...editedValues };
    }

    return editedValues;
  };

  /**
   * Clear all staging state
   */
  private clearAllStaging = (): void => {

    this.setState({
      stagedProducts: [],
      writeInRows: [],
      writeInEditedValues: {}
    });

    if (this.persistenceService) {
      this.persistenceService.clear();
    }
  };

  /**
   * Unified helper to compute staged product index (cached for performance)
   * @param filterFn - Optional filter function to apply to staged products
   * @returns Record indexed by productId
   */
  private computeStagedIndex(
    filterFn?: (sp: StagedProduct) => boolean
  ): Record<string, StagedProduct> {
    const items = filterFn 
      ? this.state.stagedProducts.filter(filterFn) 
      : this.state.stagedProducts;
    
    return items.reduce(
      (acc, sp) => {
        if (sp.productId) {
          acc[sp.productId] = sp;
        }
        return acc;
      },
      {} as Record<string, StagedProduct>
    );
  }

  /**
   * Compute stagedProductsById (cached for performance)
   * Indexed by productId for lookup by consumers (ProductGrid, etc.)
   */
  private getStagedProductsById = (): Record<string, StagedProduct> => {
    if (this.state.stagedProducts !== this.lastStagedProductsRef) {
      this.cachedStagedProductsById = this.computeStagedIndex();
      this.lastStagedProductsRef = this.state.stagedProducts;
    }
    return this.cachedStagedProductsById;
  };

  /**
   * Compute stagedWriteInsById (cached for performance)
   */
  private getStagedWriteInsById = (): Record<string, StagedProduct> => {
    if (this.state.stagedProducts !== this.lastStagedWriteInsRef) {
      this.cachedStagedWriteInsById = this.computeStagedIndex(sp => sp.isWriteIn === true);
      this.lastStagedWriteInsRef = this.state.stagedProducts;
    }
    return this.cachedStagedWriteInsById;
  };

  render(): React.ReactNode {
    const stagedProductsById = this.getStagedProductsById();
    const stagedWriteInsById = this.getStagedWriteInsById();

    if (
      this.cachedContextValue?.stagedProducts !== this.state.stagedProducts ||
      this.cachedContextValue.stagedProductsById !== stagedProductsById ||
      this.cachedContextValue.writeInRows !== this.state.writeInRows ||
      this.cachedContextValue.writeInEditedValues !== this.state.writeInEditedValues ||
      this.cachedContextValue.stagedWriteInsById !== stagedWriteInsById
    ) {
      this.cachedContextValue = {
        stagedProducts: this.state.stagedProducts,
        stagedProductsById,
        writeInRows: this.state.writeInRows,
        writeInEditedValues: this.state.writeInEditedValues,
        stagedWriteInsById,
        stageProduct: this.stageProduct,
        removeStaged: this.removeStaged,
        stageWriteIn: this.stageWriteIn,
        updateWriteInRows: this.updateWriteInRows,
        clearAllStaging: this.clearAllStaging,
        initializePersistence: this.initializePersistence,
        restoreFromStorage: this.restoreFromStorage
      };
    }

    return (
      <StagingContext.Provider value={this.cachedContextValue}>
        {this.props.children}
      </StagingContext.Provider>
    );
  }
}

/**
 * Hook to use staging context
 * Must be used within StagingProvider
 */
export function useStagingContext(): StagingContextValue {
  const context = React.useContext(StagingContext);
  if (!context) {
    throw new Error('useStagingContext must be used within StagingProvider');
  }
  return context;
}
