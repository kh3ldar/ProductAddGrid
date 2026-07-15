import { EntityConfig, ViewConfig, ColumnConfig, ProductFilterConfig, ProductFilterOption, WriteInViewConfig, ProductConfig, SystemFieldMappings, ProductFieldMapping, DisplayFormat, ProductRequestDefaults, ProductRequestViewConfig, SourceTypeConfig, MergedColumnConfig, FieldType, OptionSetOption, EntityConditionalFields, ConditionalFieldCondition, VirtualTableRow, WriteInRow, FieldValue, EntityVariant, SystemConfig, EntitiesConfig, SearchConfig, ProductSortConfig, FieldConversion } from '../types';
import { LocalizationService } from './LocalizationService';
import { LoggerService } from './LoggerService';
// Note: We're importing the configs as modules. 
// TypeScript compiler settings may need to include "resolveJsonModule": true
import * as systemConfigJson from '../config/system.config.json';
import * as entitiesConfigJson from '../config/entities.config.json';

export class ConfigService {
  private systemConfig: SystemConfig;
  private entitiesConfig: EntitiesConfig;
  private localizationService?: LocalizationService;
  private variantCache = new Map<string, EntityConfig>();
  private _allStockColumnsCache?: string[];

  constructor(localizationService?: LocalizationService) {
    this.localizationService = localizationService;
    this.loadConfig();
    this.validateConfig();
    
  }

  private loadConfig(): void {
    this.systemConfig = systemConfigJson as SystemConfig;
    this.entitiesConfig = entitiesConfigJson as EntitiesConfig;
  }

  private validateConfig(): void {
    if (!this.systemConfig || !this.entitiesConfig) {
      throw new Error('Configuration is required');
    }

    if (!this.entitiesConfig.entities || this.entitiesConfig.entities.length === 0) {
      throw new Error('At least one entity configuration is required');
    }
  }

  // ============================================================================
  // ENTITY VARIANT RESOLUTION
  // Supports dynamic entity configuration based on runtime variantKey parameter
  // ============================================================================

  /**
   * Initialize variant resolution for an entity
   * MUST be called before accessing entity configuration when using variants
   * @param parentEntity - Entity logical name
   * @param variantKey - Variant key value from Custom Page (e.g., emd_type value)
   * @param runtimeOverrides - Optional runtime overrides from the parent form field values.
   *   When stockCheckEnabled is false, all stock-related flags are cleared regardless of config.
   */
  public initializeVariant(parentEntity: string, variantKey?: string, runtimeOverrides?: { stockCheckEnabled?: boolean }): void {
    const baseConfig = this.entitiesConfig.entities.find(e => e.parentEntity === parentEntity);
    if (!baseConfig) {
      return;
    }

    const resolved = this.resolveVariantConfig(baseConfig, variantKey);

    // Apply runtime overrides after static config resolution (takes precedence)
    if (runtimeOverrides?.stockCheckEnabled === false) {
      resolved.disableRowWhenStockZero = false;
      resolved.limitQuantityToStock = false;
      resolved.validateStockBeforeSave = false;
    }

    const cacheKey = variantKey !== undefined ? `${parentEntity}_${variantKey}` : parentEntity;
    this.variantCache.set(cacheKey, resolved);

  }

  /**
   * Resolve entity variant configuration based on variantKey
   * Merges base config (common properties) with variant-specific config
   */
  private resolveVariantConfig(entityConfig: EntityConfig, variantKey?: string): EntityConfig {
    // No variants defined - return base config as-is (backward compatible)
    if (!entityConfig.variants || entityConfig.variants.length === 0) {
      return entityConfig;
    }

    // Filter to valid EntityVariant objects (inline type checking)
    const variants = entityConfig.variants.filter((v): v is EntityVariant => {
      return (
        typeof v === 'object' && 
        v !== null &&
        typeof v.name === 'string' &&
        Array.isArray(v.conditions)
      );
    });
    
    if (variants.length === 0) {
      return entityConfig;
    }

    let selectedVariant: EntityVariant | undefined;

    // Try to find matching variant by variantKey
    if (variantKey !== undefined) {
      selectedVariant = variants.find((v) =>
        v.conditions.some((c) => String(c.value) === String(variantKey))
      );
    }

    // Fall back to default variant if no match
    if (!selectedVariant && entityConfig.defaultVariant) {
      selectedVariant = variants.find((v) => v.name === entityConfig.defaultVariant);
    }

    // Error if no variant found
    if (!selectedVariant) {
      const variantNames = variants.map((v) => v.name).join(', ');
      throw new Error(
        `No matching variant found for '${entityConfig.parentEntity}' ` +
        `(variantKey: ${variantKey ?? 'undefined'}, defaultVariant: ${entityConfig.defaultVariant ?? 'undefined'}). ` +
        `Available variants: ${variantNames}`
      );
    }

    // Merge: base common config + variant-specific config (variant takes precedence)
    // ARCHITECTURAL: Merge field mappings (base + variant-specific)
    let mergedFieldMappings = entityConfig.fieldMappings;
    if (selectedVariant.fieldMappings) {
      mergedFieldMappings = {
        systemFields: selectedVariant.fieldMappings.systemFields ?? entityConfig.fieldMappings?.systemFields,
        productFieldMappings: [
          ...(entityConfig.fieldMappings?.productFieldMappings ?? []),
          ...(selectedVariant.fieldMappings.productFieldMappings ?? [])
        ]
      };
    }
    
    const resolved: EntityConfig = {
      ...entityConfig,
      ...(selectedVariant as Partial<EntityConfig>),
      // Preserve common properties that shouldn't be overridden
      parentEntity: entityConfig.parentEntity,
      detailEntity: entityConfig.detailEntity,
      detailEntitySet: entityConfig.detailEntitySet,
      recordNumberField: entityConfig.recordNumberField,
      fieldMappings: mergedFieldMappings, // Use merged field mappings
      // Remove variants array from resolved config (no longer needed)
      variants: undefined,
      defaultVariant: undefined,
      // Preserve variant name for debugging
      name: selectedVariant.name
    } as EntityConfig;

    return resolved;
  }

  /**
   * Get search configuration
   */
  getSearchConfig(): SearchConfig {
    return this.systemConfig.search;
  }

  /**
   * Get entity configuration for a specific parent entity
   * Returns cached resolved variant if initializeVariant() was called, otherwise base config
   */
  getEntityConfig(parentEntityName: string): EntityConfig | undefined {
    // Check variant cache first (resolved config with variant applied)
    const cached = Array.from(this.variantCache.entries())
      .find(([key]) => key === parentEntityName || key.startsWith(`${parentEntityName}_`));
    
    if (cached) {
      return cached[1];
    }

    // Fallback to base config (backward compatible for entities without variants)
    return this.entitiesConfig.entities.find(e => e.parentEntity === parentEntityName);
  }

  /**
   * Get the detail entity name for a parent entity
   */
  getDetailEntityName(parentEntityName: string): string {
    return this.getEntityConfigOrThrow(parentEntityName).detailEntity;
  }

  /**
   * Resolve the active view for a given parent entity
   * Uses savedQueryId from entity config
   */
  getViewConfigForEntity(parentEntityName: string): ViewConfig {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    
    return {
      name: entityConfig.defaultView ?? `${parentEntityName} View`,
      savedQueryId: entityConfig.savedQueryId ?? '00000000-0000-0000-0000-000000000000',
      isProductDetailView: entityConfig.isProductDetailView ?? true,
      columns: [],
      search: this.systemConfig.search
    };
  }

  /**
   * Get merged column configuration for an entity
   * Combines entity-level columns with view-level columns
   * Entity-level columns take precedence (for exclusions, overrides, etc.)
   */
  getMergedColumnsForEntity(parentEntityName: string): ColumnConfig[] {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    const viewConfig = this.getViewConfigForEntity(parentEntityName);
    
    const entityColumns: ColumnConfig[] = entityConfig.columns ?? [];
    const viewColumns: ColumnConfig[] = viewConfig.columns ?? [];
    
    // Create a map of entity columns by logicalName for quick lookup
    const entityColumnMap = new Map<string, ColumnConfig>();
    entityColumns.forEach((col: ColumnConfig) => {
      entityColumnMap.set(col.logicalName.toLowerCase(), col);
    });
    
    // Merge: entity columns take precedence, then add view columns that aren't in entity config
    const merged = [...entityColumns];
    viewColumns.forEach((viewCol: ColumnConfig) => {
      if (!entityColumnMap.has(viewCol.logicalName.toLowerCase())) {
        merged.push(viewCol);
      }
    });
    
    return merged;
  }

  /**
   * Determine if a view should be treated as a product detail view
   * Always returns true - entity configs control actual behavior
   */
  isProductDetailView(_parentEntityName?: string, _viewName?: string): boolean {
    return true;
  }

  /**
   * Get entity configuration or throw error if not found
   * Provides clear error message with remediation steps
   * @param parentEntityName - Parent entity name
   * @returns EntityConfig (never null)
   * @throws Error if entity config not found
   */
  private getEntityConfigOrThrow(parentEntityName: string): EntityConfig {
    const entityConfig = this.getEntityConfig(parentEntityName);
    if (!entityConfig) {
      throw new Error(
        `No entity configuration found for '${parentEntityName}'. ` +
        `Please add configuration to entities.config.json.`
      );
    }
    return entityConfig;
  }

  /**
   * Get system fields configuration for an entity
   * System fields are always required for creating detail records (lookup bindings)
   * @param parentEntityName - The parent entity name
   * @returns SystemFieldMappings or null if not configured
   */
  getSystemFields(parentEntityName: string): SystemFieldMappings | null {
    const entityFields = this.getEntityConfigOrThrow(parentEntityName).fieldMappings?.systemFields;
    const defaults = this.systemConfig.defaults?.systemFieldDefaults;
    if (!entityFields && !defaults) return null;
    if (!defaults) return entityFields ?? null;
    if (!entityFields) return defaults as SystemFieldMappings;
    const merged = { ...defaults, ...entityFields };
    // Strip explicitly null-ed fields (entity excludes these defaults)
    for (const key of Object.keys(merged)) {
      if (merged[key as keyof typeof merged] === null) {
        delete merged[key as keyof typeof merged];
      }
    }
    return merged as SystemFieldMappings;
  }

  /**
   * Get product-to-detail field mappings for an entity
   * These define how product fields are mapped to detail entity fields
   * @param parentEntityName - The parent entity name
   * @returns Array of ProductFieldMapping or empty array
   */
  getProductFieldMappings(parentEntityName: string): ProductFieldMapping[] {
    const fieldMappings = this.getEntityConfigOrThrow(parentEntityName).fieldMappings;
    return fieldMappings?.productFieldMappings ?? [];
  }

  /**
   * Check if entity has transaction currency support
   * Returns false for entities like crcad_reservationrecord that don't have transactioncurrencyid
   */
  hasCurrency(parentEntityName: string): boolean {
    // Default to true if not explicitly set to false
    return this.getEntityConfigOrThrow(parentEntityName).hasCurrency !== false;
  }

  /**
   * Get product configuration
   * Note: product config is required in config.json - no fallback needed
   */
  getProductConfig(): ProductConfig {
    if (!this.systemConfig.product) {
      throw new Error('product configuration is required in config.json');
    }
    return this.systemConfig.product;
  }

  /**
   * Get the product code field name from config
   */
  getProductCodeField(): string {
    return this.getProductConfig().codeField;
  }

  /**
   * Get priority columns for grid display
   */
  getPriorityColumns(): string[] {
    return this.getProductConfig().priorityColumns;
  }

  /**
   * Get search fields from config
   */
  getSearchFields(): string[] {
    return this.systemConfig.search.fields ?? ['name'];
  }

  /**
   * Get detail entity set name for WebAPI calls
   * Requires explicit configuration in config.json
   */
  getDetailEntitySet(parentEntityName: string): string {
    const detailEntitySet = this.getEntityConfigOrThrow(parentEntityName).detailEntitySet;
    if (!detailEntitySet) {
      throw new Error(`Detail entity set not configured for '${parentEntityName}'. Add 'detailEntitySet' to entity config in config.json.`);
    }
    return detailEntitySet;
  }

  /**
   * Get the default Unit of Measure ID based on environment
   * @param isDevelopment - If true, returns development UoM ID; otherwise production
   */
  getDefaultUomId(isDevelopment = false): string | undefined {
    const uomConfig = this.systemConfig.defaults?.uomId;
    if (!uomConfig) {
      return undefined;
    }
    return isDevelopment ? uomConfig.development : uomConfig.production;
  }

  /**
   * Get the default product sort configuration
   * Returns array of sort rules (e.g., by usage rank descending, then name ascending)
   * Falls back to sorting by name if not configured
   */
  getDefaultProductSort(): ProductSortConfig[] {
    const sort = this.systemConfig.defaults?.defaultProductSort;
    if (!sort || sort.length === 0) {
      // Fallback to name ascending
      return [{ attribute: 'name', descending: false }];
    }
    return sort;
  }

  /**
   * Get product filter configuration for an entity
   * Uses default filters from system config (applies to all entities)
   */
  getProductFilterConfig(_parentEntityName: string): ProductFilterConfig | undefined {
    // In two-config architecture, filters are in defaults.productFilters
    const filters = this.systemConfig.defaults?.productFilters ?? [];
    
    if (filters.length === 0) {
      return undefined;
    }
    
    return {
      enabled: true, // Filters are enabled by default if they exist
      filters
    };
  }

  /**
   * Check if product filters are enabled for an entity
   */
  hasProductFilters(parentEntityName: string): boolean {
    const filterConfig = this.getProductFilterConfig(parentEntityName);
    return filterConfig?.enabled === true && (filterConfig?.filters?.length ?? 0) > 0;
  }

  /**
   * Get all filter options for an entity
   */
  getProductFilterOptions(parentEntityName: string): ProductFilterOption[] {
    const filterConfig = this.getProductFilterConfig(parentEntityName);
    if (!filterConfig?.enabled) {
      return [];
    }
    // Exclude hidden filters from the visible dropdown. They remain resolvable via getHiddenFilter()
    // (which reads the raw defaults list), so they can still be applied as a forced entity constraint.
    return (filterConfig.filters ?? []).filter(f => !f.hidden);
  }

  /**
   * Get the default filter key for an entity
   */
  getDefaultProductFilterKey(parentEntityName: string): string | undefined {
    const options = this.getProductFilterOptions(parentEntityName);
    const defaultOption = options.find(opt => opt.isDefault);
    return defaultOption?.key ?? options[0]?.key;
  }

  /**
   * Get a specific filter option by key
   */
  getProductFilterByKey(parentEntityName: string, filterKey: string): ProductFilterOption | undefined {
    const options = this.getProductFilterOptions(parentEntityName);
    return options.find(opt => opt.key === filterKey);
  }

  /**
   * Get sub-filter options for a given parent filter key.
   * subFilters may be an inline array or a string key into defaults.subFilterDefinitions.
   */
  getSubFilterOptions(parentEntityName: string, parentFilterKey: string): ProductFilterOption[] {
    const parent = this.getProductFilterByKey(parentEntityName, parentFilterKey);
    if (!parent?.subFilters) return [];
    if (typeof parent.subFilters === 'string') {
      return this.systemConfig.defaults?.subFilterDefinitions?.[parent.subFilters] ?? [];
    }
    return parent.subFilters;
  }

  /**
   * Get a specific sub-filter by key under a parent filter
   */
  getSubFilterByKey(
    parentEntityName: string,
    parentFilterKey: string,
    subFilterKey: string
  ): ProductFilterOption | undefined {
    return this.getSubFilterOptions(parentEntityName, parentFilterKey)
      .find(sf => sf.key === subFilterKey);
  }

  /**
   * Get hidden filter for an entity (applied silently, not shown in UI)
   * Returns the filter option matching the hiddenFilter key from entity config
   */
  getHiddenFilter(parentEntityName: string): ProductFilterOption | undefined {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (!entityConfig.hiddenFilter) {
      return undefined;
    }
    
    // Look up the filter from defaults.productFilters
    const defaultFilters = this.systemConfig.defaults?.productFilters ?? [];
    return defaultFilters.find(f => f.key === entityConfig.hiddenFilter);
  }

  /**
   * Get globally hidden columns (columns that should be fetched but not displayed)
   */
  getHiddenColumns(): string[] {
    return this.systemConfig.product.hiddenColumns ?? [];
  }

  /**
   * Check if a column should be hidden globally
   */
  isColumnHidden(logicalName: string): boolean {
    return this.getHiddenColumns().some(
      col => col.toLowerCase() === logicalName.toLowerCase()
    );
  }

  /**
   * Check if write-in products are enabled for an entity
   * Requires both writeInEnabled flag and a valid savedQueryId
   */
  isWriteInEnabled(parentEntityName: string): boolean {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    const hasValidConfig = entityConfig.writeInEnabled === true && 
      !!entityConfig.writeInView?.savedQueryId &&
      entityConfig.writeInView.savedQueryId !== '00000000-0000-0000-0000-000000000000';
    return hasValidConfig;
  }

  /**
   * Get write-in view configuration for an entity
   * Returns the full WriteInViewConfig object from entity config, not from views[]
   */
  getWriteInViewConfig(parentEntityName: string): WriteInViewConfig | null {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (!entityConfig.writeInEnabled || !entityConfig.writeInView) {
      return null;
    }
    return entityConfig.writeInView;
  }

  /**
   * Get stock columns to display for an entity
   * Returns array of stock column names configured for the entity
   */
  getStockColumns(parentEntityName: string): string[] {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (entityConfig.stockColumns !== undefined) return entityConfig.stockColumns;
    return this.systemConfig.defaults?.defaultStockColumns ?? [];
  }

  /**
   * Get the record number field for an entity (used in product requests)
   * Returns undefined if not configured (entity doesn't support product requests)
   */
  getRecordNumberField(parentEntityName: string): string | undefined {
    return this.getEntityConfigOrThrow(parentEntityName).recordNumberField;
  }

  /**
   * Check if stock columns should be shown for an entity
   */
  shouldShowStockColumn(parentEntityName: string): boolean {
    const stockColumns = this.getStockColumns(parentEntityName);
    return stockColumns.length > 0;
  }

  /**
   * Get all stock columns used across all entities
   */
  getAllStockColumns(): string[] {
    if (this._allStockColumnsCache) {
      return this._allStockColumnsCache;
    }

    const columns: string[] = [];
    
    this.entitiesConfig.entities.forEach(entity => {
      if (entity.stockColumns) {
        entity.stockColumns.forEach(col => {
          if (!columns.includes(col)) {
            columns.push(col);
          }
        });
      }
    });
    
    // Also include defaults
    const defaultStockColumns = this.systemConfig.defaults?.defaultStockColumns ?? [];
    defaultStockColumns.forEach(col => {
      if (!columns.includes(col)) {
        columns.push(col);
      }
    });

    this._allStockColumnsCache = columns;
    return columns;
  }

  /**
   * Get product columns with entity-specific stock columns and conditional fields trigger columns
   * @param parentEntityName - The parent entity name
   * @returns Array of product columns including entity's stock columns and conditional trigger fields
   */
  getProductColumnsForEntity(parentEntityName: string): string[] {
    const baseColumns = this.systemConfig.product.columns ?? [];
    const entityStockColumns = this.getStockColumns(parentEntityName);
    const allStockColumns = this.getAllStockColumns();
    
    // Get conditional fields trigger columns (e.g., emd_brand for Adobe products)
    const conditionalTriggerColumns = this.getConditionalFieldsTriggerColumns(parentEntityName);
    
    // If entity has no stock columns, filter out all stock columns
    if (entityStockColumns.length === 0) {
      const filtered = baseColumns.filter(col => !allStockColumns.includes(col));
      // Add conditional trigger columns if any
      return conditionalTriggerColumns.length > 0 
        ? [...filtered, ...conditionalTriggerColumns]
        : filtered;
    }
    
    // Entity has stock columns - include only those specified
    // Filter out other stock columns and add back the entity's stock columns
    const filtered = baseColumns.filter(col => !allStockColumns.includes(col));
    const withStock = [...filtered, ...entityStockColumns];
    
    // Add conditional trigger columns if any
    return conditionalTriggerColumns.length > 0
      ? [...withStock, ...conditionalTriggerColumns]
      : withStock;
  }

  /**
   * Get display format override for a specific column
   * Used to customize how values are rendered (e.g., decimal places)
   * @param logicalName - The column logical name to look up
   * @returns DisplayFormat configuration or undefined if no override exists
   */
  getDisplayFormat(logicalName: string): DisplayFormat | undefined {
    return this.systemConfig.display.formatOverrides?.[logicalName];
  }

  /**
   * Check if row should be disabled when stock is zero or less
   * This is the config-driven alternative to hardcoding entity checks
   */
  shouldDisableRowWhenStockZero(parentEntityName: string): boolean {
    return this.getEntityConfigOrThrow(parentEntityName).disableRowWhenStockZero === true;
  }

  /**
   * Check if quantity input should be limited to available stock
   * This is the config-driven alternative to hardcoding entity checks
   */
  shouldLimitQuantityToStock(parentEntityName: string): boolean {
    return this.getEntityConfigOrThrow(parentEntityName).limitQuantityToStock === true;
  }

  /**
   * Check if stock should be validated before save
   * When true, the component validates stock availability and blocks save if exceeded
   * This is the config-driven alternative to hardcoding entity checks
   */
  shouldValidateStockBeforeSave(parentEntityName: string): boolean {
    return this.getEntityConfigOrThrow(parentEntityName).validateStockBeforeSave === true;
  }

  /**
   * Check if catalog rows should auto-stage once all their required fields are filled
   * When true, the user no longer needs to click "Add" — the row stages itself as soon as
   * every required grid field has a value (and un-stages if a required field is cleared)
   * This is the config-driven alternative to hardcoding entity checks
   */
  isAutoStageEnabled(parentEntityName: string): boolean {
    return this.getEntityConfigOrThrow(parentEntityName).autoStageEnabled === true;
  }

  /**
   * Get auto-set rules for an entity
   * Falls back to global defaults if entity doesn't override
   * These rules auto-populate field values based on product data conditions
   * Example: If product's spec7 = 'YAZILIM', auto-set producttype = 1
   */
  getAutoSetRules(parentEntityName: string): import('../types').AutoSetRule[] {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    
    // Entity-specific rules take precedence
    if (entityConfig.autoSetRules && entityConfig.autoSetRules.length > 0) {
      return entityConfig.autoSetRules;
    }
    
    // Fall back to global defaults
    return this.systemConfig.defaults?.autoSetRules ?? [];
  }

  /**
   * Get field conversions for an entity
   * Returns empty array if entity has no fieldConversions configured
   */
  getFieldConversions(parentEntityName: string): FieldConversion[] {
    return this.getEntityConfigOrThrow(parentEntityName).fieldConversions ?? [];
  }

  /**
   * Get the available stock field name from config
   */
  getAvailableStockField(): string {
    return this.systemConfig.defaults?.availableStockField ?? 'emd_availablestock';
  }

  /**
   * Get the tab visibility flag name for the JS bridge
   */
  getTabVisibilityFlagName(): string | undefined {
    return this.systemConfig.productRequest?.tabVisibilityFlagName;
  }

  /**
   * Detect if running in a development environment
   */
  static isDevelopment(): boolean {
    return window.location.hostname.toLowerCase().includes('test');
  }

  // ============================================================================
  // CONDITIONAL FIELDS METHODS
  // Config-driven conditional fields that must be filled before staging
  // ============================================================================

  /**
   * Check if conditional fields are enabled for an entity
   * Requires enabled flag and at least one field defined
   */
  isConditionalFieldsEnabled(parentEntityName: string): boolean {
    const config = this.getConditionalFieldsConfig(parentEntityName);
    return config !== null && (config.fields?.length ?? 0) > 0;
  }

  /**
   * Get conditional fields configuration for an entity
   * Returns null if not enabled or not configured
   * Resolves field definitions from registry if using reference pattern
   */
  getConditionalFieldsConfig(parentEntityName: string): EntityConditionalFields | null {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (!entityConfig.conditionalFields) {
      return null;
    }

    const conditionalFields = entityConfig.conditionalFields;

    // Pattern 1: Reference pattern - use field definition from registry
    if (conditionalFields.use) {
      return this.resolveFieldDefinition(conditionalFields);
    }

    // Pattern 2: Inline pattern (legacy) - use fields directly from entity config
    if (conditionalFields.enabled && conditionalFields.fields && conditionalFields.triggerConditions) {
      return {
        enabled: true,
        triggerConditions: conditionalFields.triggerConditions,
        fields: conditionalFields.fields
      };
    }

    return null;
  }

  /**
   * Resolve field definition from registry and apply entity-specific overrides
   * @private
   */
  private resolveFieldDefinition(conditionalFields: EntityConditionalFields): EntityConditionalFields | null {
    if (!conditionalFields.use) {
      return null;
    }

    // Look up the field definition in the system config registry
    const definition = this.systemConfig.fieldDefinitions?.[conditionalFields.use];
    if (!definition) {
      LoggerService.error(`Field definition '${conditionalFields.use}' not found in system config`);
      return null;
    }

    // Start with the base definition
    let resolvedFields = [...definition.fields];

    // Apply entity-specific overrides if any
    if (conditionalFields.overrides) {
      resolvedFields = resolvedFields.map(field => {
        const override = conditionalFields.overrides?.[field.logicalName];
        if (override) {
          return { ...field, ...override };
        }
        return field;
      });
    }

    return {
      enabled: true,
      triggerConditions: definition.triggerConditions,
      fields: resolvedFields
    };
  }

  /**
   * Check if a product/row meets conditional field trigger conditions
   * Uses AND logic - all conditions must be met
   * @param product - The product or row data to check
   * @param parentEntityName - Entity name for config lookup
   * @returns true if product meets ALL trigger conditions
   */
  productRequiresConditionalFields(
    product: VirtualTableRow | WriteInRow,
    parentEntityName: string
  ): boolean {
    const config = this.getConditionalFieldsConfig(parentEntityName);
    if (!config?.triggerConditions?.length) {
      return false;
    }

    // Check all trigger conditions (AND logic)
    return config.triggerConditions.every(condition => {
      const productValue = (product as Record<string, FieldValue>)[condition.attribute];
      return this.evaluateCondition(productValue, condition);
    });
  }

  /**
   * Evaluate a single conditional field condition
   * @private
   */
  private evaluateCondition(value: FieldValue, condition: ConditionalFieldCondition): boolean {
    switch (condition.operator) {
      case 'eq':
        return value === condition.value;
      case 'ne':
        return value !== condition.value;
      case 'gt':
        return typeof value === 'number' && value > (condition.value as number);
      case 'lt':
        return typeof value === 'number' && value < (condition.value as number);
      case 'in':
        { const values = Array.isArray(condition.value) ? condition.value : [condition.value];
        return values.includes(value as string | number); }
      default:
        return false;
    }
  }

  /**
   * Get extra product columns needed for conditional fields trigger conditions
   * Returns trigger condition attributes that aren't already in base product columns
   */
  getConditionalFieldsTriggerColumns(parentEntityName: string): string[] {
    const config = this.getConditionalFieldsConfig(parentEntityName);
    if (!config?.triggerConditions) {
      return [];
    }
    
    // Get base columns without conditional fields to avoid circular dependency
    const baseColumns = this.systemConfig.product.columns ?? [];
    const entityStockColumns = this.getStockColumns(parentEntityName);
    const allColumns = [...baseColumns, ...entityStockColumns];
    
    const extraFields: string[] = [];
    
    for (const condition of config.triggerConditions) {
      if (!allColumns.includes(condition.attribute) && !extraFields.includes(condition.attribute)) {
        extraFields.push(condition.attribute);
      }
    }
    
    return extraFields;
  }

  // ============================================================================
  // PRODUCT REQUEST METHODS
  // ============================================================================

  /**
   * Get product request defaults configuration
   * Contains request type column definition, custom API config, etc.
   */
  getProductRequestDefaults(): ProductRequestDefaults | null {
    return this.systemConfig.productRequest ?? null;
  }

  /**
   * Check if product requests are enabled for an entity
   * Requires productRequestEnabled flag and at least one valid view config
   */
  isProductRequestEnabled(parentEntityName: string): boolean {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (!entityConfig.productRequestEnabled || !entityConfig.productRequestView) {
      return false;
    }
    // Check if at least one view has a valid savedQueryId
    const catalogValid = entityConfig.productRequestView.catalogView?.savedQueryId && 
      entityConfig.productRequestView.catalogView.savedQueryId !== '00000000-0000-0000-0000-000000000000';
    const writeInValid = entityConfig.productRequestView.writeInView?.savedQueryId && 
      entityConfig.productRequestView.writeInView.savedQueryId !== '00000000-0000-0000-0000-000000000000';
    return !!(catalogValid || writeInValid);
  }

  /**
   * Get product request view configuration for an entity
   * Returns the full ProductRequestViewConfig object from entity config
   */
  getProductRequestViewConfig(parentEntityName: string): ProductRequestViewConfig | null {
    const entityConfig = this.getEntityConfigOrThrow(parentEntityName);
    if (!entityConfig.productRequestEnabled || !entityConfig.productRequestView) {
      return null;
    }
    return entityConfig.productRequestView;
  }

  /**
   * Get entity-specific column weights for grid width calculation
   * Returns undefined if no custom weights are configured (use defaults)
   */
  getColumnWeights(parentEntityName: string): import('../types').ColumnWeights | undefined {
    return this.getEntityConfigOrThrow(parentEntityName).columnWeights;
  }

  /**
   * Get the request type column configuration
   * This column is injected programmatically (not from Dataverse view)
   * @param localizationService - Optional localization service for resolving labels
   */
  getRequestTypeColumnConfig(localizationService?: LocalizationService): MergedColumnConfig | null {
    const defaults = this.getProductRequestDefaults();
    if (!defaults) return null;
    
    const { requestTypeColumn } = defaults;
    const localizer = localizationService ?? this.localizationService;
    
    // Resolve option labels
    const options: OptionSetOption[] = requestTypeColumn.options.map(opt => ({
      value: opt.value,
      label: localizer?.getString(opt.labelKey) ?? opt.labelKey
    }));
    
    return {
      logicalName: requestTypeColumn.logicalName,
      labelKey: requestTypeColumn.labelKey,
      displayName: localizer?.getString(requestTypeColumn.labelKey) ?? requestTypeColumn.labelKey,
      type: 'OptionSet' as FieldType,
      required: requestTypeColumn.required,
      editable: true,
      readOnly: false,
      width: 180,
      fromView: false, // Injected, not from view
      isValidForRead: true,
      isValidForCreate: true,
      isValidForUpdate: true,
      hidden: false,
      options
    };
  }

  /**
   * Get source type configuration for Custom API call
   * Uses sourceTypeMapping keys from config to find matching source type
   */
  getSourceTypeConfig(parentEntityName: string): SourceTypeConfig | null {
    const defaults = this.getProductRequestDefaults();
    if (!defaults?.sourceTypeMapping) return null;
    
    // Check if parent entity is a key in sourceTypeMapping
    const sourceType = defaults.sourceTypeMapping[parentEntityName];
    return sourceType ?? null;
  }

  /**
   * Get Custom API configuration for Product Requests
   */
  getProductRequestCustomApi(): { actionName: string; existingRequestEntity?: string; productDetailEntity?: string } | null {
    const defaults = this.getProductRequestDefaults();
    if (!defaults?.customApi) return null;
    return defaults.customApi;
  }

  /**
   * Set the localization service for resolving labels
   */
  setLocalizationService(localizationService: LocalizationService): void {
    this.localizationService = localizationService;
  }

}