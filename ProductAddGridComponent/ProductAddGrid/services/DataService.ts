import {
  // Core product types
  Product,
  ProductSearchResult,
  VirtualTableRow,
  StagedProduct,
  // Parent/child records
  ParentRecord,
  ProductRequestRow,
  // Metadata types
  ViewMetadata,
  AttributeMetadata,
  // Column & field types
  MergedColumnConfig,
  ColumnConfig,
  FieldValue,
  // OptionSet types
  OptionSetMetadata,
  // Configuration types
  SystemFieldMappings,
  ProductFieldMapping,
  ConditionalFieldConfig,
  ProductFilterCondition,
  SearchMatchType,
  // API response types
  ExistingRequestCheckResult,
  ProductRequestApiPayload,
  // Paging
  PagingInfo
} from '../types';
import { ConfigService } from './ConfigService';
import { MetadataService } from './MetadataService';
import { FormattingService } from './FormattingService';
import { ColumnService } from './ColumnService';
import { ProductQueryService } from './ProductQueryService';
import { RecordOperationsService } from './RecordOperationsService';
import { CustomApiService } from './CustomApiService';
import { withAuthRetry } from '../utils/errorUtils';

export class DataService {
  private context: ComponentFramework.Context<unknown>;
  private webApi: ComponentFramework.WebApi;
  private metadataService: MetadataService;
  private formattingService: FormattingService;
  private columnService: ColumnService;
  private productQueryService: ProductQueryService;
  private recordOpsService: RecordOperationsService;
  private customApiService: CustomApiService;

  constructor(context: ComponentFramework.Context<unknown>, configService?: ConfigService) {
    this.context = context;
    // Wrap webAPI once, here, so every downstream service transparently retries the
    // "no user is logged in" race that can hit the first authenticated call in a
    // freshly opened Custom Page dialog (auth handshake still settling). Proxy the context
    // itself rather than spreading it, so every other property (mode, utils, parameters, ...)
    // still resolves against the live platform object instead of a shallow-copied snapshot.
    const wrappedWebApi = withAuthRetry(context.webAPI);
    const resilientContext = new Proxy(context, {
      get: (target, prop, receiver) =>
        prop === 'webAPI' ? wrappedWebApi : Reflect.get(target, prop, receiver)
    });
    this.webApi = wrappedWebApi;
    this.metadataService = new MetadataService(resilientContext);
    this.formattingService = new FormattingService(resilientContext);
    this.columnService = new ColumnService(resilientContext, this.metadataService);
    // Use provided ConfigService or create new one
    const config = configService ?? new ConfigService();
    this.productQueryService = new ProductQueryService(resilientContext, this.metadataService, this.columnService, config);
    this.recordOpsService = new RecordOperationsService(resilientContext, this.metadataService);
    this.customApiService = new CustomApiService(resilientContext);
  }

  // =============================================================================
  // PUBLIC API - Metadata Operations (delegated to MetadataService)
  // =============================================================================

  /**
   * Get OptionSet metadata including all options
   * @param entityName - Entity logical name
   * @param attributeName - Attribute logical name
   * @returns OptionSetMetadata or null if not found/not an OptionSet
   */
  public async getOptionSetMetadata(
    entityName: string,
    attributeName: string
  ): Promise<OptionSetMetadata | null> {
    return this.metadataService.getOptionSetMetadata(entityName, attributeName);
  }

  /**
   * Get individual attribute metadata
   * @param entityName - Entity logical name
   * @param attributeName - Attribute logical name
   * @returns AttributeMetadata or null if not found
   */
  public async getAttributeMetadata(entityName: string, attributeName: string): Promise<AttributeMetadata | null> {
    return this.metadataService.getAttributeMetadata(entityName, attributeName);
  }

  /**
   * Get currency formatting information
   * @param currencyId - Currency record ID
   * @returns Currency entity record or null if not found
   */
  public async getCurrencyInfo(currencyId: string): Promise<ComponentFramework.WebApi.Entity | null> {
    return this.formattingService.getCurrencyInfo(currencyId);
  }

  /**
   * Format currency value based on user settings
   * @param value - Numeric value to format
   * @param currencyCode - Optional ISO currency code (e.g., 'USD', 'EUR', 'TRY')
   * @returns Formatted currency string
   */
  public formatCurrency(value: number, currencyCode?: string): string {
    return this.formattingService.formatCurrency(value, currencyCode);
  }

  /**
   * Format decimal value based on user settings
   * @param value - Numeric value to format
   * @param decimalPlaces - Number of decimal places (default: 2)
   * @returns Formatted decimal string
   */
  public formatDecimal(value: number, decimalPlaces = 2): string {
    return this.formattingService.formatDecimal(value, decimalPlaces);
  }

  /**
   * Retrieve view metadata from Dataverse saved query
   * @param savedQueryId - GUID of the saved query
   * @param entityName - Target entity name (default: 'product')
   * @returns View metadata with column definitions or null if not found
   */
  public async getViewMetadata(savedQueryId: string, entityName = 'product'): Promise<ViewMetadata | null> {
    return this.columnService.getViewMetadata(savedQueryId, entityName);
  }

  /**
   * Create view-based column configuration by merging view metadata with static config
   * @param viewMetadata - View metadata from Dataverse
   * @param staticColumns - Static column configurations from config.json
   * @param productColumns - Product columns for hybrid views
   * @param isProductDetailView - Whether this is a product detail view (hybrid)
   * @param isWriteInView - Whether this is a write-in product view
   * @param priorityColumns - Columns that should appear first
   * @returns Merged column configuration array
   */
  public async createViewBasedColumnConfig(
    viewMetadata: ViewMetadata,
    staticColumns: ColumnConfig[],
    productColumns: string[] = [],
    isProductDetailView = false,
    isWriteInView = false,
    priorityColumns: string[] = ['name']
  ): Promise<MergedColumnConfig[]> {
    return this.columnService.createViewBasedColumnConfig(
      viewMetadata,
      staticColumns,
      productColumns,
      isProductDetailView,
      isWriteInView,
      priorityColumns
    );
  }

  // =============================================================================
  // PUBLIC API - Product Query Operations (delegated to ProductQueryService)
  // =============================================================================

  /**
   * Create virtual table rows by combining product data with view metadata staging fields
   */
  public createVirtualTableRows(products: Product[], viewMetadata: ViewMetadata, productColumns: string[] = ['productid', 'name']): VirtualTableRow[] {
    return this.productQueryService.createVirtualTableRows(products, viewMetadata, productColumns);
  }

  /**
   * Search for virtual table rows
   */
  public async searchVirtualTableRows(
    query: string,
    pageSize: number,
    page: number,
    viewMetadata?: ViewMetadata | null,
    isProductDetailView?: boolean,
    productColumns?: string[],
    filterConditions?: ProductFilterCondition[],
    searchFields?: string[],
    matchType?: SearchMatchType
  ): Promise<{ virtualRows: VirtualTableRow[]; paging: PagingInfo }> {
    return this.productQueryService.searchVirtualTableRows(
      query,
      pageSize,
      page,
      viewMetadata,
      isProductDetailView,
      productColumns,
      filterConditions,
      searchFields,
      matchType
    );
  }

  /**
   * Search products using FetchXML
   */
  public async searchProductsWithFetchXML(
    searchQuery: string,
    pageSize: number,
    pageNumber: number,
    viewMetadata?: ViewMetadata | null,
    isProductDetailView?: boolean,
    configuredProductColumns?: string[],
    filterConditions?: ProductFilterCondition[],
    searchFields?: string[]
  ): Promise<ProductSearchResult> {
    return this.productQueryService.searchProductsWithFetchXML(
      searchQuery,
      pageSize,
      pageNumber,
      viewMetadata,
      isProductDetailView,
      configuredProductColumns,
      filterConditions,
      searchFields
    );
  }

  /**
   * Get available stock for products
   */
  public async getProductsAvailableStock(productIds: string[]): Promise<Map<string, number>> {
    return this.productQueryService.getProductsAvailableStock(productIds);
  }

  // =============================================================================
  // PUBLIC API - Record Operations (delegated to RecordOperationsService)
  // =============================================================================

  public async getParentRecord(entityName: string, recordId: string, hasCurrency = true, extraSelect?: string[]): Promise<ParentRecord> {
    return this.recordOpsService.getParentRecord(entityName, recordId, hasCurrency, extraSelect);
  }

  public async getParentRecordForProductRequest(
    entityName: string,
    recordId: string,
    configService: ConfigService
  ): Promise<{ recordNumber: string; customerId: string } | null> {
    return this.recordOpsService.getParentRecordForProductRequest(entityName, recordId, configService);
  }

  public async getExistingProductIds(
    parentLookupField: string,
    parentRecordId: string,
    productLookupField: string,
    detailEntitySet: string
  ): Promise<string[]> {
    return this.recordOpsService.getExistingProductIds(
      parentLookupField,
      parentRecordId,
      productLookupField,
      detailEntitySet
    );
  }

  public async saveProducts(
    stagedProducts: StagedProduct[],
    parentRecordId: string,
    detailEntityName: string,
    systemFields: SystemFieldMappings,
    catalogViewMetadata: ViewMetadata,
    writeInViewMetadata: ViewMetadata | null,
    currencyId?: string,
    uomId?: string,
    productFieldMappings?: ProductFieldMapping[],
    conditionalFields?: ConditionalFieldConfig[],
    abortOnFirstFailure = false,
    skipLogoPushSignalField?: string
  ): Promise<string[]> {
    return this.recordOpsService.saveProducts(
      stagedProducts,
      parentRecordId,
      detailEntityName,
      systemFields,
      catalogViewMetadata,
      writeInViewMetadata,
      currencyId,
      uomId,
      productFieldMappings,
      conditionalFields,
      abortOnFirstFailure,
      skipLogoPushSignalField
    );
  }

  public async createDetailRecord(
    detailEntityName: string,
    parentRecordId: string,
    productId: string | null,
    isWriteIn: boolean,
    systemFields: SystemFieldMappings,
    viewMetadata: ViewMetadata,
    currencyId?: string,
    uomId?: string,
    productFieldMappings?: ProductFieldMapping[],
    fieldValues?: Record<string, FieldValue>,
    product?: VirtualTableRow,
    fieldConversions?: import('../types').FieldConversion[]
  ): Promise<string> {
    return this.recordOpsService.createDetailRecord(
      detailEntityName,
      parentRecordId,
      productId,
      isWriteIn,
      systemFields,
      viewMetadata,
      currencyId,
      uomId,
      productFieldMappings,
      fieldValues,
      product,
      fieldConversions
    );
  }

  public async callCustomApi(
    actionName: string,
    entityName: string,
    recordId: string
  ): Promise<void> {
    return this.recordOpsService.callCustomApi(actionName, entityName, recordId);
  }

  /**
   * Get entity set name for an entity from metadata
   * Note: For detail entities, use detailEntitySet from config instead of calling this method
   */
  private async getEntitySetName(entityName: string): Promise<string | null> {
    // Get from entity metadata (no hardcoded fallbacks)
    const metadata = await this.metadataService.getEntityMetadata(entityName);
    return metadata?.entitySetName ?? null;
  }

  // =============================================================================
  // PUBLIC API - Custom API Operations (delegated to CustomApiService)
  // =============================================================================

  /**
   * Check for existing product request record
   * Delegates to CustomApiService
   */
  public async checkExistingProductRequest(
    parentId: string,
    requestType: number,
    parentEntityType: string,
    customerId: string,
    items: ProductRequestRow[],
    configService: ConfigService
  ): Promise<ExistingRequestCheckResult> {
    return this.customApiService.checkExistingProductRequest(
      parentId,
      requestType,
      parentEntityType,
      customerId,
      items,
      configService
    );
  }

  /**
   * Call product request custom API
   * Delegates to CustomApiService
   */
  public async callProductRequestCustomApi(
    payload: ProductRequestApiPayload,
    actionName: string
  ): Promise<{ success: boolean; message?: string }> {
    return this.customApiService.callProductRequestCustomApi(payload, actionName);
  }

  /**
   * Batch-push just-created reservation lines to Logo via emd_SyncReservationLines.
   * Delegates to CustomApiService.
   */
  public async syncReservationLines(
    reservationId: string,
    lineIds: string[],
    mode: 'sync' | 'compensate' = 'sync'
  ): Promise<{ success: boolean; message?: string }> {
    return this.customApiService.syncReservationLines(reservationId, lineIds, mode);
  }


}