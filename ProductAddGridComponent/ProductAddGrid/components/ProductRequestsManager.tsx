import * as React from 'react';
import { BaseTabManager } from './BaseTabManager';
import {
  VirtualTableRow,
  MergedColumnConfig,
  FieldValue,
  ProductRequestRow,
  ProductRequestViewConfig,
  ViewMetadata,
  ProductFilterOption,
  ProductFilterCondition,
  ParentRecord,
  EntityConfig,
  OptionSetOption,
  ProductDetailPayload,
  ColumnConfig,
} from '../types';
import { DataService, ConfigService, LocalizationService, LoggerService, StagingPersistenceService } from '../services';
import { ProductRequestsTab } from './ProductRequestsTab';
import { generateWriteInTempId } from '../utils/idGenerator';
import { initializeRowWithDefaults, validateRequiredFields } from '../utils/gridUtils';

/**
 * Props for ProductRequestsManager
 */
export interface IProductRequestsManagerProps {
  parentEntityName: string;
  parentRecordId: string;
  parentRecord: ParentRecord;
  entityConfig: EntityConfig;
  dataService: DataService;
  configService: ConfigService;
  localizationService: LocalizationService;

  // Currency
  currencyCode?: string;
  currencySymbol?: string;

  // Toast notifications
  onShowToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void;

  // Trigger dialog close after successful save (set by container)
  onRequestSave: () => void;

  // Called whenever the number of staged product request rows changes
  onStagedCountChange?: (count: number) => void;

  // Called after successfully restoring persisted state from localStorage
  onRestoredFromStorage?: (totalRestored: number) => void;
}

/**
 * State for ProductRequestsManager
 */
interface IProductRequestsManagerState {
  productRequestCatalogViewMetadata?: ViewMetadata;
  productRequestWriteInViewMetadata?: ViewMetadata;
  productRequestCatalogColumns: MergedColumnConfig[];
  productRequestWriteInColumns: MergedColumnConfig[];
  productRequestViewConfig?: ProductRequestViewConfig;

  // Write-in grid state
  productRequestWriteInRows: ProductRequestRow[];
  productRequestWriteInEditedValues: Record<string, Record<string, FieldValue>>;

  // Catalog grid state (staged items)
  productRequestCatalogRows: ProductRequestRow[];
  productRequestCatalogEditedValues: Record<string, Record<string, FieldValue>>;

  // Catalog search state
  productRequestCatalogSearch: string;
  productRequestCatalogSearchResults: VirtualTableRow[];
  productRequestCatalogSearchLoading: boolean;
  productRequestSelectedFilterKey?: string;
  
  filterOptions: ProductFilterOption[];
  
  // Saving state
  isSaving: boolean;
  isLoading: boolean;
}

/**
 * ProductRequestsManager - Manages the product requests tab
 * Handles dual-grid layout (catalog search + write-in), request submission via Custom API
 */
export class ProductRequestsManager extends BaseTabManager<
  IProductRequestsManagerProps,
  IProductRequestsManagerState
> {
  /**
   * Map a ColumnConfig to a MergedColumnConfig with fallback defaults
   */
  private static toMergedColumn(col: ColumnConfig): MergedColumnConfig {
    return {
      logicalName: col.logicalName,
      labelKey: col.labelKey,
      displayName: col.labelKey ? undefined : col.logicalName,
      readOnly: col.readOnly ?? false,
      required: col.required ?? false,
      width: col.width ?? 150,
      type: col.type ?? 'Text',
      fromView: false,
      isValidForRead: true,
      isValidForCreate: true,
      isValidForUpdate: true,
      editable: col.editable ?? true,
      hidden: col.hidden ?? false,
      maxLength: col.maxLength
    };
  }
  private productRequestSearchDebounceTimer?: NodeJS.Timeout;
  private persistenceService?: StagingPersistenceService;

  // Performance: Cached computed values
  private cachedRequestTypeOptions: OptionSetOption[] | null = null;
  private cachedFilterConditions = new Map<string, ProductFilterCondition[]>();
  private _cachedStagedProductIds = new Set<string>();
  private _lastCatalogRowsForIds: ProductRequestRow[] = [];

  private getStagedProductIds(): Set<string> {
    const rows = this.state.productRequestCatalogRows;
    if (rows !== this._lastCatalogRowsForIds) {
      this._lastCatalogRowsForIds = rows;
      this._cachedStagedProductIds = new Set(
        rows.map(r => r._productId).filter((id): id is string => id !== undefined)
      );
    }
    return this._cachedStagedProductIds;
  }

  constructor(props: IProductRequestsManagerProps) {
    super(props);

    const defaultFilterKey = this.props.configService.getDefaultProductFilterKey(
      this.props.parentEntityName
    );
    const filterOptions = this.props.configService.getProductFilterOptions(
      this.props.parentEntityName
    );

    this.state = {
      productRequestCatalogViewMetadata: undefined,
      productRequestWriteInViewMetadata: undefined,
      productRequestCatalogColumns: [],
      productRequestWriteInColumns: [],
      productRequestViewConfig: undefined,
      productRequestWriteInRows: [],
      productRequestWriteInEditedValues: {},
      productRequestCatalogRows: [],
      productRequestCatalogEditedValues: {},
      productRequestCatalogSearch: '',
      productRequestCatalogSearchResults: [],
      productRequestCatalogSearchLoading: false,
      productRequestSelectedFilterKey: defaultFilterKey,
      filterOptions,
      isSaving: false,
      isLoading: true
    };
  }

  protected async onMount(): Promise<void> {
    // Initialize persistence service
    this.persistenceService = new StagingPersistenceService(
      this.props.parentEntityName,
      this.props.parentRecordId
    );
    // Load product request view metadata
    await this.loadProductRequestViewMetadata();
  }

  componentDidUpdate(
    _prevProps: IProductRequestsManagerProps,
    prevState: IProductRequestsManagerState
  ): void {
    // Save to localStorage whenever staged rows or edited values change
    const rowsChanged =
      prevState.productRequestCatalogRows !== this.state.productRequestCatalogRows ||
      prevState.productRequestCatalogEditedValues !== this.state.productRequestCatalogEditedValues ||
      prevState.productRequestWriteInRows !== this.state.productRequestWriteInRows ||
      prevState.productRequestWriteInEditedValues !== this.state.productRequestWriteInEditedValues;

    if (rowsChanged && this.persistenceService) {
      this.persistenceService.saveProductRequest(
        this.state.productRequestCatalogRows,
        this.state.productRequestCatalogEditedValues,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    }
  }

  /**
   * Compute and emit the current staged row count to the parent container.
   * Catalog rows always count; write-in rows count only when they have data.
   */
  private notifyStagedCountChange(
    catalogRows: ProductRequestRow[],
    writeInRows: ProductRequestRow[],
    writeInEditedValues: Record<string, Record<string, FieldValue>>
  ): void {
    if (!this.props.onStagedCountChange) return;
    const writInCount = writeInRows.filter(row => {
      const ev = writeInEditedValues[row._tempId] ?? {};
      return Boolean(ev.productdescription) || Boolean(ev.quantity);
    }).length;
    this.props.onStagedCountChange(catalogRows.length + writInCount);
  }

  /**
   * Clear all staged product request rows (called by parent on "Clear Staging").
   */
  public clearStaging(): void {
    const { productRequestWriteInColumns } = this.state;
    const defaultWriteInRow: ProductRequestRow = {
      _tempId: generateWriteInTempId(),
      _isWriteIn: true
    };
    const initialEditedValues = initializeRowWithDefaults(productRequestWriteInColumns);
    // Clear persisted state immediately on explicit clear
    if (this.persistenceService) {
      this.persistenceService.clear('productRequest');
    }
    this.setState({
      productRequestCatalogRows: [],
      productRequestCatalogEditedValues: {},
      productRequestWriteInRows: [defaultWriteInRow],
      productRequestWriteInEditedValues: { [defaultWriteInRow._tempId]: initialEditedValues }
    }, () => {
      this.notifyStagedCountChange([], [defaultWriteInRow], { [defaultWriteInRow._tempId]: initialEditedValues });
    });
  }

  protected onUnmount(): void {
    if (this.productRequestSearchDebounceTimer) {
      clearTimeout(this.productRequestSearchDebounceTimer);
    }
    
    // Clean up persistence service
    if (this.persistenceService) {
      this.persistenceService.destroy();
      this.persistenceService = undefined;
    }
  }

  // ============================================================================
  // PRICE REQUEST PERSISTENCE (Using StagingPersistenceService)
  // ============================================================================

  /**
   * Load product request view metadata (catalog + write-in)
   */
  private loadProductRequestViewMetadata = async (): Promise<void> => {
    const productRequestViewConfig = this.props.configService.getProductRequestViewConfig(
      this.props.parentEntityName
    );

    if (!productRequestViewConfig) {
      this.setState({ isLoading: false });
      return;
    }

    const detailEntityName = this.props.configService.getDetailEntityName(
      this.props.parentEntityName
    );

    if (!detailEntityName) {
      LoggerService.error('No detail entity found for parent entity', {
        parentEntityName: this.props.parentEntityName
      });
      this.setState({ isLoading: false });
      return;
    }

    const priorityColumns = this.props.configService.getPriorityColumns();

    // Request Type column to be added at end of each column set
    const requestTypeColumn: MergedColumnConfig = {
      logicalName: 'requesttype',
      labelKey: 'col.requestType',
      displayName: undefined,
      readOnly: false,
      required: true,
      width: 180,
      type: 'Picklist',
      fromView: false,
      isValidForRead: true,
      isValidForCreate: true,
      isValidForUpdate: true,
      editable: true,
      hidden: false
    };

    const productColumns = this.props.configService.getProductColumnsForEntity(
      this.props.parentEntityName
    );

    try {
      // Load CATALOG view columns
      const catalogViewConfig = productRequestViewConfig.catalogView;
      let catalogColumns: MergedColumnConfig[] = [];

      if (catalogViewConfig) {
        const hasValidCatalogQueryId =
          catalogViewConfig.savedQueryId &&
          catalogViewConfig.savedQueryId !== '00000000-0000-0000-0000-000000000000';


        if (hasValidCatalogQueryId) {
          const viewMetadata = await this.props.dataService.getViewMetadata(
            catalogViewConfig.savedQueryId,
            detailEntityName
          );

          if (viewMetadata) {
            catalogColumns = await this.props.dataService.createViewBasedColumnConfig(
              viewMetadata,
              catalogViewConfig.columns ?? [],
              productColumns,
              true, // isProductDetailView: true - use hybrid view logic
              false, // isWriteInView: false - catalog view
              priorityColumns
            );

            if (!this.isMounted) return;

            this.setState({
              productRequestCatalogViewMetadata: viewMetadata
            });
          }
        }

        // Fallback to config columns
        if (catalogColumns.length === 0 && catalogViewConfig.columns) {
          catalogColumns = catalogViewConfig.columns.map(col => ProductRequestsManager.toMergedColumn(col));
        }
      }

      // Load WRITE-IN view columns
      const writeInViewConfig = productRequestViewConfig.writeInView;
      let writeInColumns: MergedColumnConfig[] = [];

      if (writeInViewConfig) {
        const hasValidWriteInQueryId =
          writeInViewConfig.savedQueryId &&
          writeInViewConfig.savedQueryId !== '00000000-0000-0000-0000-000000000000';


        if (hasValidWriteInQueryId) {
          const viewMetadata = await this.props.dataService.getViewMetadata(
            writeInViewConfig.savedQueryId,
            detailEntityName
          );

          if (viewMetadata) {
            writeInColumns = await this.props.dataService.createViewBasedColumnConfig(
              viewMetadata,
              writeInViewConfig.columns ?? [],
              [],
              false,
              true,
              priorityColumns
            );

            if (!this.isMounted) return;

            this.setState({ productRequestWriteInViewMetadata: viewMetadata });
          }
        }

        // Fallback to config columns
        if (writeInColumns.length === 0 && writeInViewConfig.columns) {
          writeInColumns = writeInViewConfig.columns.map(col => ProductRequestsManager.toMergedColumn(col));
        }
      }

      // Add Request Type column and filter stock columns
      const allStockColumns = this.props.configService.getAllStockColumns();
      const catalogColumnsWithHidden = catalogColumns
        .filter(col => !allStockColumns.includes(col.logicalName))
        .map(col => ({
          ...col,
          hidden: col.hidden || this.props.configService.isColumnHidden(col.logicalName)
        }));

      const catalogColumnsWithRequestType = [
        ...catalogColumnsWithHidden,
        requestTypeColumn
      ];
      const writeInColumnsWithRequestType = [...writeInColumns, requestTypeColumn];


      if (!this.isMounted) return;

      this.setState(
        {
          productRequestCatalogColumns: catalogColumnsWithRequestType,
          productRequestWriteInColumns: writeInColumnsWithRequestType,
          productRequestViewConfig,
          isLoading: false
        },
        () => {
          // Attempt to restore persisted price request state before creating default row
          const persisted = this.persistenceService?.loadProductRequest();

          if (persisted) {
            const restoredCatalogCount = persisted.catalogRows.length;
            const restoredWriteInCount = persisted.writeInRows.filter(row => {
              const ev = persisted.writeInEditedValues[row._tempId] ?? {};
              return Boolean(ev.productdescription) || Boolean(ev.quantity);
            }).length;
            const totalRestored = restoredCatalogCount + restoredWriteInCount;

            // Ensure at least one write-in row exists
            const writeInRowsToRestore =
              persisted.writeInRows.length > 0
                ? persisted.writeInRows
                : [{ _tempId: generateWriteInTempId(), _isWriteIn: true }];


            this.setState(
              {
                productRequestCatalogRows: persisted.catalogRows,
                productRequestCatalogEditedValues: persisted.catalogEditedValues,
                productRequestWriteInRows: writeInRowsToRestore,
                productRequestWriteInEditedValues: persisted.writeInEditedValues
              },
              () => {
                this.notifyStagedCountChange(
                  this.state.productRequestCatalogRows,
                  this.state.productRequestWriteInRows,
                  this.state.productRequestWriteInEditedValues
                );
                if (totalRestored > 0 && this.props.onRestoredFromStorage) {
                  this.props.onRestoredFromStorage(totalRestored);
                }
              }
            );
          } else {
            // No persisted state - auto-add first write-in row
            if (this.state.productRequestWriteInRows.length === 0) {
              const newRow: ProductRequestRow = {
                _tempId: generateWriteInTempId(),
                _isWriteIn: true
              };

              const initialEditedValues = initializeRowWithDefaults(
                writeInColumnsWithRequestType
              );

              this.setState(prevState => ({
                productRequestWriteInRows: [newRow],
                productRequestWriteInEditedValues: {
                  ...prevState.productRequestWriteInEditedValues,
                  [newRow._tempId]: initialEditedValues
                }
              }));
            }
          }

          // Trigger initial search
          if (this.state.productRequestCatalogSearchResults.length === 0) {
            void this.searchProductsForProductRequest('');
          }
        }
      );
    } catch (error) {
      LoggerService.error('Error loading product request view metadata:', error);
      if (!this.isMounted) return;
      this.setState({ isLoading: false });
    }
  };

  /**
   * Search products for product requests catalog grid
   */
  private searchProductsForProductRequest = async (query: string): Promise<void> => {
    this.setState({ productRequestCatalogSearchLoading: true });

    try {
      const viewMetadata = this.state.productRequestCatalogViewMetadata;
      const isProductDetailView = true; // catalog view is always a product detail view

      if (!viewMetadata) {
        LoggerService.error(
          'Product Request catalog view metadata not loaded. Cannot search.'
        );
        this.setState({ productRequestCatalogSearchLoading: false });
        return;
      }

      const searchConfig =
        this.props.configService.getViewConfigForEntity(this.props.parentEntityName)
          .search ??
        this.props.configService.getSearchConfig() ?? {
          fields: ['name'],
          pageSize: 25
        };

      const baseProductColumns = this.props.configService.getProductColumnsForEntity(
        this.props.parentEntityName
      );
      // Note: Auto-set rule source fields no longer needed in query
      // Rules are now applied during staging in StagingContext
      const productColumns = baseProductColumns;
      const searchFields = this.props.configService.getSearchFields();

      const filterConditions = this.getProductRequestFilterConditions();
      const hiddenFilter = this.props.configService.getHiddenFilter(
        this.props.parentEntityName
      );
      const hiddenConditions = hiddenFilter?.conditions ?? [];
      const allConditions = [...hiddenConditions, ...filterConditions];

      const result = await this.props.dataService.searchVirtualTableRows(
        query,
        searchConfig.pageSize,
        1,
        viewMetadata,
        isProductDetailView,
        productColumns,
        allConditions,
        searchFields
      );

      // Auto-set rules are now applied during staging in StagingContext
      // No need for pre-population in catalogEditedValues

      this.setState({
        productRequestCatalogSearchResults: result.virtualRows,
        productRequestCatalogSearchLoading: false
      });
    } catch (error) {
      LoggerService.error('Error searching products for product request:', error);
      this.setState({ productRequestCatalogSearchLoading: false });
    }
  };

  /**
   * Get filter conditions for Product Requests catalog search (memoized)
   */
  private getProductRequestFilterConditions(): ProductFilterCondition[] {
    const { productRequestSelectedFilterKey } = this.state;
    if (!productRequestSelectedFilterKey) {
      return [];
    }

    // Check cache first
    const cached = this.cachedFilterConditions.get(productRequestSelectedFilterKey);
    if (cached) {
      return cached;
    }

    // Compute and cache
    const filter = this.props.configService.getProductFilterByKey(
      this.props.parentEntityName,
      productRequestSelectedFilterKey
    );

    const conditions = filter?.conditions ?? [];
    this.cachedFilterConditions.set(productRequestSelectedFilterKey, conditions);
    
    return conditions;
  }

  /**
   * Handle product request search query change (debounced)
   */
  private handleProductRequestSearchChange = (query: string): void => {
    this.setState({ productRequestCatalogSearch: query });

    if (this.productRequestSearchDebounceTimer) {
      clearTimeout(this.productRequestSearchDebounceTimer);
    }

    if (query.length === 0 || query.length >= 3) {
      this.productRequestSearchDebounceTimer = setTimeout(() => {
        void this.searchProductsForProductRequest(query);
      }, 400);
    }
  };

  /**
   * Handle filter change for Product Requests catalog search
   */
  private handleProductRequestFilterChange = (filterKey: string): void => {
    this.setState({ productRequestSelectedFilterKey: filterKey }, () => {
      void this.searchProductsForProductRequest(
        this.state.productRequestCatalogSearch
      );
    });
  };

  /**
   * Handle write-in row field change
   */
  private handleProductRequestWriteInRowChange = (
    rowId: string,
    field: string,
    value: FieldValue
  ): void => {
    this.setState(prevState => ({
      productRequestWriteInEditedValues: {
        ...prevState.productRequestWriteInEditedValues,
        [rowId]: {
          ...prevState.productRequestWriteInEditedValues[rowId],
          [field]: value
        }
      }
    }), () => {
      this.notifyStagedCountChange(
        this.state.productRequestCatalogRows,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    });
  };

  /**
   * Add a new write-in row
   */
  private handleAddProductRequestWriteInRow = (): void => {
    const { productRequestWriteInColumns } = this.state;
    const newRow: ProductRequestRow = {
      _tempId: generateWriteInTempId(),
      _isWriteIn: true
    };

    const initialEditedValues = initializeRowWithDefaults(
      productRequestWriteInColumns
    );

    this.setState(prevState => ({
      productRequestWriteInRows: [...prevState.productRequestWriteInRows, newRow],
      productRequestWriteInEditedValues: {
        ...prevState.productRequestWriteInEditedValues,
        [newRow._tempId]: initialEditedValues
      }
    }), () => {
      this.notifyStagedCountChange(
        this.state.productRequestCatalogRows,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    });
  };

  /**
   * Remove a write-in row
   */
  private handleRemoveProductRequestWriteInRow = (rowId: string): void => {
    this.setState(prevState => {
      const { [rowId]: _, ...remainingEditedValues } =
        prevState.productRequestWriteInEditedValues;
      return {
        productRequestWriteInRows: prevState.productRequestWriteInRows.filter(
          r => r._tempId !== rowId
        ),
        productRequestWriteInEditedValues: remainingEditedValues
      };
    }, () => {
      this.notifyStagedCountChange(
        this.state.productRequestCatalogRows,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    });
  };

  /**
   * Add a product from search results to catalog staging
   */
  private handleAddFromProductRequestSearch = (
    product: VirtualTableRow,
    editedValues: Record<string, FieldValue>
  ): void => {
    const alreadyAdded = this.state.productRequestCatalogRows.some(
      r => r._productId === product.productid
    );
    if (alreadyAdded) {
      return;
    }

    const newRow: ProductRequestRow = {
      _tempId: generateWriteInTempId(),
      _isWriteIn: false,
      _productId: product.productid,
      _productData: product,
      productdescription: product.name,
      name: product.name,
      [`${this.props.entityConfig.detailEntity}name`]: product.name,
      ...editedValues
    };

    this.setState(prevState => {
      const newCatalogRows = [...prevState.productRequestCatalogRows, newRow];
      const newEditedValues = {
        ...prevState.productRequestCatalogEditedValues,
        [product.productid]: editedValues
      };
      return {
        productRequestCatalogRows: newCatalogRows,
        productRequestCatalogEditedValues: newEditedValues
      };
    }, () => {
      this.notifyStagedCountChange(
        this.state.productRequestCatalogRows,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    });
  };

  /**
   * Remove a product from catalog staging
   */
  private handleRemoveFromProductRequestStaging = (productId: string): void => {
    this.setState(prevState => {
      const newEditedValues = { ...prevState.productRequestCatalogEditedValues };
      delete newEditedValues[productId];

      return {
        productRequestCatalogRows: prevState.productRequestCatalogRows.filter(
          r => r._productId !== productId
        ),
        productRequestCatalogEditedValues: newEditedValues
      };
    }, () => {
      this.notifyStagedCountChange(
        this.state.productRequestCatalogRows,
        this.state.productRequestWriteInRows,
        this.state.productRequestWriteInEditedValues
      );
    });
  };

  /**
   * Get request type options from config (memoized)
   */
  private getRequestTypeOptions = (): OptionSetOption[] => {
    // Return cached value if available
    if (this.cachedRequestTypeOptions) {
      return this.cachedRequestTypeOptions;
    }

    // Compute and cache
    const requestTypeConfig = this.props.configService.getRequestTypeColumnConfig();
    if (!requestTypeConfig?.options || requestTypeConfig.options.length === 0) {
      LoggerService.error(
        'productRequestDefaults.requestTypeColumn.options is required in config.json'
      );
      return [];
    }
    
    this.cachedRequestTypeOptions = requestTypeConfig.options;
    return this.cachedRequestTypeOptions;
  };

  /**
   * Submit product requests (creates detail records and calls Custom API)
   * This is exposed for the parent container to call
   */
  public submitProductRequests = async (): Promise<{ apiSuccess: boolean; apiMessage?: string }> => {
    const {
      productRequestCatalogRows,
      productRequestWriteInRows,
      productRequestWriteInEditedValues,
      productRequestCatalogColumns,
      productRequestWriteInColumns,
      productRequestCatalogViewMetadata,
      productRequestWriteInViewMetadata
    } = this.state;

    const { entityConfig, parentRecord } = this.props;

    // Filter write-in rows that have data
    const allWriteInRows = productRequestWriteInRows.filter(row => {
      const editedValues = productRequestWriteInEditedValues[row._tempId] ?? {};
      return Boolean(editedValues.productdescription) || Boolean(editedValues.quantity);
    });

    const totalRows = productRequestCatalogRows.length + allWriteInRows.length;
    if (totalRows === 0) {
      return { apiSuccess: true };
    }


    // Validate all rows
    const validationErrors: string[] = [];

    // Validate catalog rows
    for (const row of productRequestCatalogRows) {
      const rowValues: Record<string, FieldValue> = {};
      for (const key of Object.keys(row)) {
        if (!key.startsWith('_')) {
          rowValues[key] = row[key as keyof ProductRequestRow] as FieldValue;
        }
      }
      const missingFields = validateRequiredFields(
        productRequestCatalogColumns,
        rowValues,
        this.props.localizationService
      );
      if (missingFields.length > 0) {
        validationErrors.push(`Catalog product: ${missingFields.join(', ')}`);
      }
    }

    // Validate write-in rows
    for (const row of allWriteInRows) {
      const editedValues: Record<string, FieldValue> =
        productRequestWriteInEditedValues[row._tempId] ?? {};
      const missingFields = validateRequiredFields(
        productRequestWriteInColumns,
        editedValues,
        this.props.localizationService
      );
      if (missingFields.length > 0) {
        validationErrors.push(`Write-in product: ${missingFields.join(', ')}`);
      }
    }

    if (validationErrors.length > 0) {
      this.props.onShowToast(
        'error',
        `${this.props.localizationService.getString('toast.validationError')}: ${validationErrors[0]}`
      );
      throw new Error('Validation failed');
    }

    if (!entityConfig || !parentRecord) {
      this.props.onShowToast('error', this.props.localizationService.getString('error.configNotAvailable'));
      throw new Error('Missing configuration');
    }

    this.setState({ isSaving: true });

    try {
      const isDevelopment = ConfigService.isDevelopment();
      const uomId = this.props.configService.getDefaultUomId(isDevelopment);
      const systemFields = this.props.configService.getSystemFields(
        this.props.parentEntityName
      );
      const productFieldMappings = this.props.configService.getProductFieldMappings(
        this.props.parentEntityName
      );

      if (!systemFields) {
        throw new Error(
          `System fields not configured for entity '${this.props.parentEntityName}'`
        );
      }

      if (!productRequestCatalogViewMetadata || !productRequestWriteInViewMetadata) {
        throw new Error('Product Request view metadata not available');
      }

      // Create detail records
      const createdDetailIds: string[] = [];

      // Process catalog products
      for (const row of productRequestCatalogRows) {

        const recordData: Record<string, FieldValue> = {};
        for (const column of productRequestCatalogColumns) {
          if (
            column.editable &&
            row[column.logicalName as keyof ProductRequestRow] !== undefined
          ) {
            recordData[column.logicalName] = row[
              column.logicalName as keyof ProductRequestRow
            ] as FieldValue;
          }
        }

        const detailId = await this.props.dataService.createDetailRecord(
          entityConfig.detailEntity,
          this.props.parentRecordId,
          row._productId ?? null,
          false,
          systemFields,
          productRequestCatalogViewMetadata,
          parentRecord.transactionCurrencyId,
          uomId,
          productFieldMappings,
          recordData,
          row._productData,
          this.props.configService.getFieldConversions(this.props.parentEntityName)
        );

        createdDetailIds.push(detailId);
      }

      // Process write-in products
      for (const row of allWriteInRows) {
        const editedValues: Record<string, FieldValue> =
          productRequestWriteInEditedValues[row._tempId] ?? {};


        const detailId = await this.props.dataService.createDetailRecord(
          entityConfig.detailEntity,
          this.props.parentRecordId,
          null,
          true,
          systemFields,
          productRequestWriteInViewMetadata,
          parentRecord.transactionCurrencyId,
          uomId,
          productFieldMappings,
          editedValues,
          undefined,
          this.props.configService.getFieldConversions(this.props.parentEntityName)
        );

        createdDetailIds.push(detailId);
      }


      // Call custom API
      const customApiConfig = this.props.configService.getProductRequestCustomApi();
      // Capture API result for the caller (container will show global notification)
      let apiCallResult: { success: boolean; message?: string } = { success: true };
      if (customApiConfig?.actionName) {

        const parentInfo = await this.props.dataService.getParentRecordForProductRequest(
          this.props.parentEntityName,
          this.props.parentRecordId,
          this.props.configService
        );

        if (!parentInfo) {
          throw new Error(
            'Could not retrieve parent record information for product request'
          );
        }

        // Determine request type from first row
        let requestType = 0;
        if (productRequestCatalogRows.length > 0) {
          requestType = Number(productRequestCatalogRows[0].requesttype ?? 0);
        } else if (allWriteInRows.length > 0) {
          const firstWriteInEdited =
            productRequestWriteInEditedValues[allWriteInRows[0]._tempId] ?? {};
          requestType = Number(firstWriteInEdited.requesttype ?? 0);
        }

        const sourceTypeConfig = this.props.configService.getSourceTypeConfig(
          this.props.parentEntityName
        );
        const recordType = sourceTypeConfig?.recordType ?? 1;

        // Build productDetails array
        const productDetailsArray: ProductDetailPayload[] = [];
        let detailIndex = 0;

        // Add catalog products
        for (const row of productRequestCatalogRows) {
          const detailId = createdDetailIds[detailIndex++];
          productDetailsArray.push({
            detailId: detailId,
            productId: row._productId ?? null,
            quantity: Math.floor(Number(row.quantity) || 0),
            productName: row._productName ?? null,
            productCode: row._productCode ?? null,
            description:
              (typeof row.description === 'string' ? row.description : null) ?? null,
            productType: Number(row.emd_producttype ?? 0)
          });
        }

        // Add write-in products
        for (const row of allWriteInRows) {
          const editedValues = productRequestWriteInEditedValues[row._tempId] ?? {};
          const detailId = createdDetailIds[detailIndex++];
          productDetailsArray.push({
            detailId: detailId,
            productId: null,
            quantity: Math.floor(Number(editedValues.quantity) || 0),
            productName: String(editedValues.productdescription ?? '') || null,
            productCode: null,
            description: String(editedValues.description ?? '') || null,
            productType: Number(editedValues.emd_producttype ?? 0)
          });
        }

        const allItemsForCheck: ProductRequestRow[] = [
          ...productRequestCatalogRows,
          ...allWriteInRows.map(row => ({
            ...row,
            ...(productRequestWriteInEditedValues[row._tempId] ?? {})
          }))
        ];

        const existingCheckResult = await this.props.dataService.checkExistingProductRequest(
          this.props.parentRecordId,
          requestType,
          this.props.parentEntityName,
          parentInfo.customerId,
          allItemsForCheck,
          this.props.configService
        );


        const apiPayload = {
          type: requestType,
          selectedItems: createdDetailIds.map(id => `{${id}}`).join(','),
          isExisting: existingCheckResult.hasExisting,
          parentId: this.props.parentRecordId,
          recordNumber: parentInfo.recordNumber,
          customerId: parentInfo.customerId,
          productDetails: JSON.stringify(productDetailsArray),
          existingRecordId: existingCheckResult.existingRequest?.recordId ?? null,
          recordType: recordType
        };


        try {
          const result = await this.props.dataService.callProductRequestCustomApi(
            apiPayload,
            customApiConfig.actionName
          );

          if (result.success) {
            // success — apiCallResult captured below
          } else {
            // failure — apiCallResult captured below
          }
          apiCallResult = result;
        } catch (apiError) {
          LoggerService.error('Custom API call failed:', apiError);
          apiCallResult = {
            success: false,
            message: apiError instanceof Error ? apiError.message : 'API call failed'
          };
        }
      }

      
      // Clear persisted state after successful submit
      if (this.persistenceService) {
        this.persistenceService.clear('productRequest');
      }

      // Clear staging
      const clearedWriteInRow = { _tempId: generateWriteInTempId(), _isWriteIn: true };
      this.setState({
        productRequestCatalogRows: [],
        productRequestCatalogEditedValues: {},
        productRequestWriteInRows: [clearedWriteInRow],
        productRequestWriteInEditedValues: {},
        isSaving: false
      }, () => {
        this.notifyStagedCountChange([], [clearedWriteInRow], {});
      });

      // Notify parent that save is complete
      this.props.onRequestSave();
      return { apiSuccess: apiCallResult.success, apiMessage: apiCallResult.message };
    } catch (error) {
      LoggerService.error('Error submitting product requests:', error);
      this.setState({ isSaving: false });
      this.props.onShowToast(
        'error',
        this.props.localizationService.getString('toast.savedError')
      );
      throw error;
    }
  };

  render(): React.ReactElement {
    const {
      productRequestWriteInRows,
      productRequestWriteInEditedValues,
      productRequestCatalogSearchResults,
      productRequestCatalogEditedValues,
      productRequestCatalogSearchLoading,
      productRequestCatalogSearch,
      filterOptions,
      productRequestSelectedFilterKey,
      productRequestCatalogColumns,
      productRequestWriteInColumns,
      productRequestCatalogRows,
      isLoading
    } = this.state;

    const {
      localizationService,
      dataService,
      configService,
      currencyCode,
      currencySymbol,
      onShowToast
    } = this.props;

    return (
      <div className="pag-content pag-content-product-requests">
        <ProductRequestsTab
          writeInRows={productRequestWriteInRows}
          writeInEditedValues={productRequestWriteInEditedValues}
          onWriteInRowChange={this.handleProductRequestWriteInRowChange}
          onAddWriteInRow={this.handleAddProductRequestWriteInRow}
          onRemoveWriteInRow={this.handleRemoveProductRequestWriteInRow}
          catalogRows={productRequestCatalogRows}
          searchResults={productRequestCatalogSearchResults}
          catalogEditedValues={productRequestCatalogEditedValues}
          onAddFromSearch={this.handleAddFromProductRequestSearch}
          stagedProductIds={this.getStagedProductIds()}
          onRemoveFromStaging={this.handleRemoveFromProductRequestStaging}
          isSearching={productRequestCatalogSearchLoading}
          searchQuery={productRequestCatalogSearch}
          onSearchChange={this.handleProductRequestSearchChange}
          filterOptions={filterOptions}
          selectedFilterKey={productRequestSelectedFilterKey}
          onFilterChange={this.handleProductRequestFilterChange}
          catalogColumns={productRequestCatalogColumns}
          writeInColumns={productRequestWriteInColumns}
          requestTypeOptions={this.getRequestTypeOptions()}
          localizationService={localizationService}
          dataService={dataService}
          configService={configService}
          currencyCode={currencyCode}
          currencySymbol={currencySymbol}
          isLoading={isLoading}
          showToast={onShowToast}
        />
      </div>
    );
  }
}
