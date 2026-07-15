// ============================================================================
// ERROR HANDLING TYPES
// ============================================================================

/**
 * Dataverse Web API error structure
 * Used for consistent error handling across services
 */
export interface WebApiError {
  message?: string;
  raw?: {
    message?: string;
  };
  code?: number;
}

/**
 * Pre-localized notification for JS bridge
 * Stores formatted message with display metadata
 */
export interface GlobalNotification {
  message: string;
  level: 1 | 2 | 3 | 4; // D365 notification levels: 1=success, 2=warning, 3=error, 4=info
  duration: number; // milliseconds
}

// ============================================================================
// TWO-CONFIG ARCHITECTURE
// System config (global settings) + Entity config (entity-specific definitions)
// ============================================================================

/**
 * System configuration - global settings and reusable definitions
 * Loaded from system.config.json
 */
export interface SystemConfig {
  product: ProductConfig & {
    entity: string;
    columns: string[];
    hiddenColumns?: string[];
  };
  defaults: DefaultsConfig;
  fieldDefinitions: Record<string, FieldDefinition>;
  productRequest: ProductRequestDefaults;
  display: {
    formatOverrides: Record<string, DisplayFormat>;
    columnWeights: ColumnWeights;
  };
  search: SearchConfig;
  localization: LocalizationConfig;
}

/**
 * Entities configuration - entity-specific definitions only
 * Loaded from entities.config.json
 */
export interface EntitiesConfig {
  entities: EntityConfig[];
}

/**
 * Display format configuration for column value rendering
 * Used to override default formatting (e.g., show decimals as whole numbers)
 */
export interface DisplayFormat {
  /** Number of decimal places to display (default: 2 for Decimal/Money types) */
  decimalPlaces?: number;
}

/**
 * Product-specific configuration
 * Centralizes product entity field names and display settings
 */
export interface ProductConfig {
  /** Product code field name (e.g., "crcad_productcode_ex") */
  codeField: string;
  /** Columns that should appear first in the grid */
  priorityColumns: string[];
  /** Default stock column field name (e.g., "emd_centralwarehousestock") */
  stockColumn?: string;
}

/**
 * Auto-set rule for automatically populating field values based on conditions
 * Example: If product spec7 = 'YAZILIM', auto-set producttype = 1 (License)
 * Example: If product price has value, copy to emd_price: matchValue="*", setValue="$sourceValue"
 */
export interface AutoSetRule {
  /** Source field to check (from product entity) */
  sourceField: string;
  /** 
   * Value to match (case-insensitive string comparison)
   * Special values:
   * - "*" = match if field has any value (not null/empty)
   */
  matchValue: string;
  /** Target field to set (on detail entity) */
  targetField: string;
  /** 
   * Value to set when condition matches
   * Special values:
   * - "$sourceValue" = copy the value from sourceField
   */
  setValue: string | number | boolean;
  /**
   * Whether to override user-populated values (optional, default: false)
   * - false: Only set if field is empty/null (user values preserved)
   * - true: Always set, even if user has already populated the field
   */
  overrideValue?: boolean;
}

// ============================================================================
// CONDITIONAL FIELDS CONFIGURATION
// Config-driven conditional fields that must be filled before staging
// ============================================================================

/**
 * Condition for triggering conditional fields
 * Example: { attribute: 'emd_brand', operator: 'eq', value: 1 } for Adobe products
 */
export interface ConditionalFieldCondition {
  /** Product attribute to check */
  attribute: string;
  /** Comparison operator */
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'in';
  /** Value to compare against (single value or array for 'in' operator) */
  value: string | number | boolean | (string | number)[];
}

/**
 * Configuration for a single conditional field
 * These fields are shown in a panel when trigger conditions are met
 */
export interface ConditionalFieldConfig {
  /** Field logical name on the detail entity */
  logicalName: string;
  /** Localization key for the field label (fallback when metadata unavailable) */
  labelKey: string;
  /** Field type for rendering appropriate input */
  type: 'Text' | 'Integer' | 'OptionSet';
  /** Whether the field is required */
  required: boolean;
  /** Options for OptionSet fields (optional - fetched from metadata if not provided) */
  options?: OptionSetOption[];
  /** For OptionSet fields - true if Dataverse field expects string values ("0", "1") instead of integers */
  stringBased?: boolean;
}

/**
 * Field definition - reusable set of conditional fields
 * Defined once in system config, referenced by entities
 */
export interface FieldDefinition {
  /** Conditions that trigger these fields (AND logic) */
  triggerConditions: ConditionalFieldCondition[];
  /** Fields to display in the conditional fields panel */
  fields: ConditionalFieldConfig[];
}

/**
 * Field override - allows entity to customize specific fields from a definition
 * Example: { "emd_projectcode": { "required": true } }
 */
export type FieldOverrides = Record<string, Partial<ConditionalFieldConfig>>;

/**
 * Entity-level conditional fields configuration
 * Enables conditional fields feature with two modes:
 * 1. Reference mode: use: "fieldDefinitionName" + optional overrides
 * 2. Inline mode (legacy): enabled: true + triggerConditions + fields
 */
export interface EntityConditionalFields {
  /** Reference to a field definition in system config (e.g., "adobeLicenseFields") */
  use?: string;
  /** Field-specific overrides when using a definition reference */
  overrides?: FieldOverrides;
  
  // Legacy inline mode (kept for backward compatibility)
  /** Enable conditional fields for this entity */
  enabled?: boolean;
  /** Conditions that trigger the conditional fields panel (AND logic) */
  triggerConditions?: ConditionalFieldCondition[];
  /** Fields to display in the conditional fields panel */
  fields?: ConditionalFieldConfig[];
}

/**
 * State for the conditional fields panel
 * Tracks the product being staged and conditional field values
 */
export interface ConditionalFieldsPanelState {
  /** Whether the panel is open */
  isOpen: boolean;
  /** Product that triggered the panel */
  product?: VirtualTableRow;
  /** Edited values from the grid (passed through to staging) */
  editedValues?: Record<string, FieldValue>;
  /** Existing staged product ID if updating */
  existingStagedId?: string;
  /** Values entered in the conditional fields panel */
  conditionalValues: Record<string, FieldValue>;
}

/**
 * Sort configuration for product queries
 * Used to define sort order in FetchXML queries
 */
export interface ProductSortConfig {
  /** Field name to sort by (e.g., "emd_usagerank", "name") */
  attribute: string;
  /** Whether to sort in descending order (true) or ascending (false) */
  descending: boolean;
}

export interface DefaultsConfig {
  uomId?: {
    production: string;
    development: string;
  };
  productFilters?: ProductFilterOption[]; // Default product filters shared across entities
  subFilterDefinitions?: Record<string, ProductFilterOption[]>; // Named sub-filter sets, referenced by key from productFilters[].subFilters
  autoSetRules?: AutoSetRule[]; // Default auto-set rules applied to all entities (can be overridden per entity)
  defaultProductSort?: ProductSortConfig[]; // Default product sort order (e.g., by usage rank then name)
  systemFieldDefaults?: Partial<SystemFieldMappings>; // Default system fields inherited by all entities
  defaultStockColumns?: string[]; // Default stock columns inherited by entities without explicit stockColumns
  availableStockField?: string; // Field name for available stock queries (e.g., "emd_availablestock")
}

/**
 * Column weight configuration by type
 * Used to calculate proportional column widths in the grid
 */
export interface ColumnWeights {
  /** Weight for name/description columns (default: 3) */
  name?: number;
  /** Weight for Money/currency columns (default: 1.5) */
  Money?: number;
  /** Weight for Decimal/numeric columns (default: 1) */
  Decimal?: number;
  /** Weight for OptionSet/choice columns (default: 1.5) */
  OptionSet?: number;
  /** Weight for other text columns (default: 2) */
  default?: number;
}

// ============================================================================
// ENTITY VARIANTS CONFIGURATION
// Config-driven entity variants for multi-mode entities (e.g., Price Request vs Acquisition Order)
// ============================================================================

/**
 * Condition for matching a variant
 * Currently simplified to value matching - future can extend with field/operator
 */
export interface EntityVariantCondition {
  /** Value to match against the variantKey parameter */
  value: string | number;
}

/**
 * Entity variant configuration
 * Defines a specific mode/configuration for an entity based on runtime conditions
 */
export interface EntityVariant {
  /** Unique variant name (e.g., "priceRequest", "acquisitionOrder") */
  name: string;
  /** Conditions that trigger this variant (OR logic - any match selects this variant) */
  conditions: EntityVariantCondition[];
  
  // All variant-specific properties that can vary per mode
  defaultView?: string;
  savedQueryId?: string;
  isProductDetailView?: boolean;
  writeInEnabled?: boolean;
  writeInView?: WriteInViewConfig;
  productRequestEnabled?: boolean;
  productRequestView?: ProductRequestViewConfig;
  stockColumns?: string[];
  conditionalFields?: EntityConditionalFields;
  columnWeights?: ColumnWeights;
  columns?: ColumnConfig[];
  disableRowWhenStockZero?: boolean;
  limitQuantityToStock?: boolean;
  validateStockBeforeSave?: boolean;
  autoStageEnabled?: boolean; // If true, auto-stage a catalog row once all its required fields are filled
  autoSetRules?: AutoSetRule[];
  fieldConversions?: FieldConversion[]; // Config-driven field conversions (e.g., OptionSet → Decimal)
  fieldMappings?: EntityFieldMappings; // Variant-specific field mappings (merged with base, extends productFieldMappings array)
}

export interface EntityConfig {
  parentEntity: string;
  detailEntity: string;
  detailEntitySet?: string; // WebAPI entity set name (e.g., "opportunityproducts")
  recordNumberField?: string; // Field name for record number (e.g., "quotenumber", "crcad_opportunityid")
  fieldMappings?: EntityFieldMappings; // Optional field mappings for data creation (common across variants)
  
  // Variant support - entities with multiple modes/configurations
  variants?: EntityVariant[]; // Array of variant configurations
  defaultVariant?: string; // Name of the default variant to use when no variantKey provided or no match
  
  // Entity-level properties (can be at root for non-variant entities, or overridden in variants)
  defaultView?: string; // Optional default view name override per entity
  savedQueryId?: string; // Saved query GUID for the entity's default view (required for two-config architecture)
  isProductDetailView?: boolean; // Whether this view is for detail entity (true) or product entity (false)
  writeInEnabled?: boolean; // Enable write-in products tab for this entity
  writeInView?: WriteInViewConfig; // Write-in view configuration (separate from catalog views)
  hasCurrency?: boolean; // Whether entity has transactioncurrencyid field (default: true)
  hiddenFilter?: string; // Filter key from defaults.productFilters to apply silently (not shown in UI)
  stockColumns?: string[]; // Array of stock columns to show for this entity (empty or undefined = no stock columns)
  productRequestEnabled?: boolean; // Enable product requests tab for this entity
  productRequestView?: ProductRequestViewConfig; // Product request view configuration
  columnWeights?: ColumnWeights; // Entity-specific column width weights (overrides defaults)
  /** If true, disable row add button when stock column value is <= 0 (config-driven, not hardcoded) */
  disableRowWhenStockZero?: boolean;
  /** If true, limit quantity input max value to stock column value (config-driven, not hardcoded) */
  limitQuantityToStock?: boolean;
  /** If true, validate stock availability before save and block if exceeded */
  validateStockBeforeSave?: boolean;
  /** If true, prevent saving catalog products that already exist on the parent record */
  preventDuplicateProducts?: boolean;
  /** If true, auto-stage a catalog row once all its required fields are filled (no Add click needed) */
  autoStageEnabled?: boolean;
  /** Auto-set rules for product request catalog (set field values based on product data) */
  autoSetRules?: AutoSetRule[];
  /** Conditional fields configuration - requires additional fields before staging based on product conditions */
  conditionalFields?: EntityConditionalFields;
  /** Config-driven field conversions applied when saving records (e.g., OptionSet → Decimal) */
  fieldConversions?: FieldConversion[];
  /** Entity-level column overrides (exclude, labelKey, etc.) - merged with view-level columns */
  columns?: ColumnConfig[];
}

/**
 * Config-driven field conversion applied when saving records
 * Replaces hardcoded entity-specific conversion logic
 */
export interface FieldConversion {
  /** Source field name (e.g., "emd_taxrate") */
  sourceField: string;
  /** Target field name to write the result to (e.g., "crcad_taxrate") */
  targetField: string;
  /** Conversion type */
  type: 'optionSetToDecimal';
  /** Mapping of source option set value to target decimal value */
  mapping: Record<number, number>;
}

/**
 * Write-in view configuration - separate from catalog views
 * Columns come from Dataverse view, config only provides overrides
 */
export interface WriteInViewConfig {
  /** View name for identification */
  name: string;
  /** Dataverse saved query GUID for the write-in view */
  savedQueryId: string;
  /** Column overrides (required, editable, labelKey, exclude, etc.) */
  columns?: ColumnConfig[];
}

/**
 * Configuration for a system lookup field (always required, bound via @odata.bind)
 */
export interface SystemFieldConfig {
  /** API field name (e.g., "opportunityid", "crcad_reservationrecord") */
  logicalName: string;
  /** Navigation property for @odata.bind (defaults to logicalName if not set) */
  navProperty?: string;
  /** Entity set name for the lookup target (e.g., "opportunities", "products") */
  entitySet: string;
  /** Where to get the value for this field */
  source: 'parent' | 'product' | 'config' | 'parent-currency';
}

/**
 * Collection of system fields for an entity - these are always included in the payload
 */
export interface SystemFieldMappings {
  /** Parent entity lookup binding (required) */
  parentLookup: SystemFieldConfig;
  /** Product entity lookup binding (required for catalog products) */
  productLookup: SystemFieldConfig;
  /** Unit of Measure lookup binding (optional - only for entities with UoM, null to exclude default) */
  uomLookup?: SystemFieldConfig | null;
  /** Transaction currency lookup binding (optional - only for entities with currency, null to exclude default) */
  currencyLookup?: SystemFieldConfig | null;
  /** Static field values to always include in the payload (e.g., ispriceoverridden: true), null to exclude default */
  staticFields?: Record<string, string | number | boolean> | null;
  /** Static field values applied ONLY for write-in records (e.g., isproductoverridden: true), null to exclude default */
  writeInStaticFields?: Record<string, string | number | boolean> | null;
}

/**
 * Mapping from product entity field to detail entity field
 * Used to populate detail fields with product data (e.g., product name → productdescription)
 */
export interface ProductFieldMapping {
  /** Field name from product entity (e.g., "name", "crcad_productcode_ex") */
  fromProductField: string;
  /** Field name in detail entity (e.g., "productdescription", "emd_productcode") */
  toDetailField: string;
  /** If true, this field is always included in the payload (system-required) */
  required?: boolean;
}

/**
 * Config-driven field mappings structure
 * Separates system fields (lookups) from dynamic view-based fields
 */
export interface EntityFieldMappings {
  /** System lookup fields - always required, not from view columns */
  systemFields: SystemFieldMappings;
  /** Product-to-detail field mappings (optional - for populating detail fields from product data) */
  productFieldMappings?: ProductFieldMapping[];
}

export interface ViewConfig {
  name: string;
  savedQueryId: string;
  isProductDetailView?: boolean; // Flag to indicate this is a product detail entity view
  isWriteInView?: boolean; // Flag to identify write-in views (columns come 100% from Dataverse)
  columns: ColumnConfig[];
  search?: SearchConfig; // Optional per-view override
  productColumns?: string[];
}

export interface ColumnConfig {
  logicalName: string;
  labelKey?: string;
  readOnly?: boolean;
  required?: boolean;
  width?: number;
  type?: FieldType;
  editable?: boolean;
  mapTo?: string;
  exclude?: boolean;
  hidden?: boolean; // Fetch the field but don't render it in the grid
  maxLength?: number; // Maximum character length for Text/Memo fields (write-in tab enforcement)
}

export interface SearchConfig {
  fields: string[];
  pageSize: number;
}

/**
 * How a search term is matched against fields in FetchXML.
 * 'startsWith' → `term%` (begins-with); 'contains' → `%term%`.
 */
export type SearchMatchType = 'startsWith' | 'contains';

export interface LocalizationConfig {
  resourceType: string;
  resourceBaseName: string;
}

export type FieldType = 'Text' | 'Money' | 'Decimal' | 'Memo' | 'Lookup' | 'OptionSet' | 'Picklist' | 'DateTime';

/**
 * Generic field value type used across grid components
 * Represents any value that can be stored in a grid cell
 */
export type FieldValue = string | number | boolean | null | undefined;

/**
 * Represents a single option in an OptionSet
 */
export interface OptionSetOption {
  value: number;
  label: string;
  labelKey?: string; // Localization key for the label
  description?: string;
}

/**
 * Metadata for an OptionSet attribute including all options
 */
export interface OptionSetMetadata {
  entityName: string;
  attributeName: string;
  displayName?: string;
  options: OptionSetOption[];
  isGlobal: boolean;
  optionSetType?: string;
  defaultValue?: number; // Default option value from Dataverse metadata (DefaultFormValue)
}

export interface ViewMetadata {
  savedQueryId: string;
  name: string;
  columns: ViewColumnMetadata[];
  fetchXml?: string;
  layoutXml?: string;
}

export interface ViewColumnMetadata {
  logicalName: string;
  displayName: string;
  attributeType: string;
  width: number;
  isPrimaryKey: boolean;
  isValidForRead: boolean;
  isValidForCreate: boolean;
  isValidForUpdate: boolean;
  sourceEntity?: string;
  sourceAttribute?: string;
  originalLogicalName?: string;
}

export interface MergedColumnConfig {
  logicalName: string;
  labelKey?: string; // Optional - used when config provides override
  displayName?: string; // Display name from view metadata
  readOnly: boolean;
  required: boolean;
  width: number;
  type: FieldType;
  fromView: boolean; // Indicates if column came from view metadata
  isValidForRead: boolean;
  isValidForCreate: boolean;
  isValidForUpdate: boolean;
  editable: boolean;
  sourceLogicalName?: string;
  hidden: boolean; // Fetch the field but don't render it in the grid
  sourceEntity?: string; // Entity the attribute belongs to (for metadata lookups)
  options?: OptionSetOption[]; // Pre-loaded options for OptionSet fields
  defaultValue?: number; // Default value for OptionSet fields (from metadata)
  maxLength?: number; // Maximum character length for Text/Memo fields (write-in tab enforcement)
}

export interface EntityMetadata {
  logicalName: string;
  displayName?: string;
  entitySetName?: string;
  primaryIdAttribute?: string;
  attributes: AttributeMetadata[];
}

export interface AttributeMetadata {
  logicalName: string;
  displayName: string;
  attributeType: string;
  isPrimaryKey: boolean;
  isValidForRead: boolean;
  isValidForCreate: boolean;
  isValidForUpdate: boolean;
  isRequired?: boolean;
}

/**
 * OData response interface for API queries with pagination support
 * Used by DataService and ProductQueryService for entity retrieval
 */
export interface ODataResponse {
  entities: ComponentFramework.WebApi.Entity[];
  '@odata.nextLink'?: string;
}

export interface Product {
  productid: string;
  name: string;
  // Note: Product code field is dynamic - accessed via config.product.codeField
  // All additional fields from query are stored via the index signature below
  // Virtual staging fields - populated from view metadata
  quantity?: number;
  priceperunit?: number;
  description?: string;
  [key: string]: string | number | boolean | Date | undefined;
}

export interface VirtualTableRow {
  // Product fields
  productid: string;
  name: string;
  // Note: Product code field is dynamic - accessed via config.product.codeField
  
  // Virtual staging fields - dynamically added from view metadata
  quantity?: number;
  priceperunit?: number;
  description?: string;
  
  // Metadata
  _isVirtual: true;
  _modifiedFields?: string[]; // Track which staging fields have been modified
  
  // Allow additional dynamic fields from Dataverse queries
  // ESLint false positive: Index signature is intentionally broader than specific properties
  // to support dynamic fields from view metadata while maintaining type safety for known fields
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  [key: string]: string | number | boolean | Date | undefined | string[] | true;
}

export interface StagedProduct {
  id: string;
  productId: string;
  product?: VirtualTableRow; // Changed from Product to VirtualTableRow
  quantity?: number; // Optional - no default, validation enforces required
  unitPrice: number;
  description?: string;
  editedFields?: Record<string, FieldValue>; // All user-edited field values from view columns
  validationErrors: ValidationError[];
  isWriteIn?: boolean; // True if this is a write-in product (no catalog lookup)
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  timeout?: number;
  /** Where the toast appears. Defaults to 'top-right'. Use 'top-left' for on-load notifications. */
  position?: 'top-left' | 'top-right';
}

export interface PagingInfo {
  currentPage: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ProductSearchResult {
  products: Product[];
  paging: PagingInfo;
}

export interface ParentRecord {
  id: string;
  entityName: string;
  transactionCurrencyId?: string;
  transactionCurrencyCode?: string;
  transactionCurrencySymbol?: string;
  // Reservation parent: present (non-empty) once the reservation is bound to a Logo reserve.
  // The ProductAddGrid container uses it to decide whether to fire the batched Logo sync.
  emd_logocode?: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Product filter condition for FetchXML
 */
export interface ProductFilterCondition {
  // Leaf-condition fields. Omit attribute/operator when this entry is a nested group (see `conditions`).
  attribute?: string;
  operator?: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'like' | 'not-like' | 'not-null' | 'null' | 'in' | 'not-in';
  value?: string | number; // Single value (omit for not-null/null/in/not-in)
  values?: (string | number)[]; // Multiple values for 'in' / 'not-in' operators
  // Nested boolean group: when `conditions` is set, this entry renders as <filter type=type>
  // wrapping the child clauses (defaults to 'and'). Enables OR groups, e.g. null-tolerant exclusion:
  // { type: 'or', conditions: [ {attribute, operator:'null'}, {attribute, operator:'ne', value} ] }
  type?: 'and' | 'or';
  conditions?: ProductFilterCondition[];
}

/**
 * Product filter option configuration
 */
export interface ProductFilterOption {
  key: string; // Unique key for the filter option
  labelKey: string; // Localization key for display label
  isDefault?: boolean; // If true, this is the default filter
  hidden?: boolean; // If true, excluded from the visible filter dropdown (still resolvable as an entity hiddenFilter)
  conditions: ProductFilterCondition[]; // Filter conditions to apply (AND logic)
  subFilters?: ProductFilterOption[] | string; // Inline sub-filter options, or a key into defaults.subFilterDefinitions
}

/**
 * Entity-level product filter configuration
 */
export interface ProductFilterConfig {
  enabled: boolean; // Whether filters are enabled for this entity
  filters?: ProductFilterOption[]; // Custom filters (optional - falls back to defaults.productFilters)
}

/**
 * Active tab type for the ProductAddGrid control
 */
export type ActiveTab = 'catalog' | 'writeIn' | 'productRequests';

/**
 * Write-in row for freeform product entry (before staging)
 */
export interface WriteInRow {
  _tempId: string; // Temporary ID for tracking before staging
  _isWriteIn: true; // Flag to identify write-in rows
  // Dynamic fields from view metadata (editable columns like quantity, priceperunit, etc.)
  // ESLint false positive: Index signature is intentionally broader to support dynamic Dataverse fields
  // while maintaining type safety for known properties (_tempId, _isWriteIn)
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  [key: string]: string | number | boolean | Date | undefined | true; // Dynamic fields from view
}

// ============================================================================
// STAGING PERSISTENCE TYPES
// ============================================================================

/**
 * Persisted staging state for localStorage
 * Stores staged products when component is closed without saving
 */
export interface PersistedStagingState {
  /** Parent entity type (e.g., "opportunity", "quote") */
  parentEntity: string;
  /** Parent record GUID */
  parentRecordId: string;
  /** Parent variant key (for entities with multiple configurations, e.g., "1" or "2") */
  parentVariantKey?: string;
  /** Timestamp when saved (for TTL expiry) */
  timestamp: number;
  /** Staged catalog products */
  stagedProducts: StagedProduct[];
  /** Write-in rows (if any) */
  writeInRows?: WriteInRow[];
  /** Edited values for write-in rows */
  writeInEditedValues?: Record<string, Record<string, FieldValue>>;
}

/**
 * Persisted price request state for localStorage (Price Request tab)
 * Stores catalog rows and write-in rows independently from StagingContext
 */
export interface PersistedPriceRequestState {
  /** Parent entity type */
  parentEntity: string;
  /** Parent record GUID */
  parentRecordId: string;
  /** Timestamp when saved (for TTL expiry) */
  timestamp: number;
  /** Catalog (staged) product request rows */
  catalogRows: ProductRequestRow[];
  /** Edited values for catalog rows keyed by tempId */
  catalogEditedValues: Record<string, Record<string, FieldValue>>;
  /** Write-in rows */
  writeInRows: ProductRequestRow[];
  /** Edited values for write-in rows keyed by tempId */
  writeInEditedValues: Record<string, Record<string, FieldValue>>;
}

/**
 * Result of reconciling restored staging with current stock levels
 */
export interface StockReconciliationResult {
  /** Products that are still valid */
  validProducts: StagedProduct[];
  /** Products with adjusted quantities */
  adjustments: {
    product: StagedProduct;
    oldQuantity: number;
    newQuantity: number;
  }[];
  /** Products removed due to no stock */
  removed: StagedProduct[];
}

// ============================================================================
// PRODUCT REQUEST TYPES
// ============================================================================

/**
 * Product Request Defaults Configuration
 * Contains global settings for the Product Requests tab feature
 */
export interface ProductRequestDefaults {
  requestTypeColumn: RequestTypeColumnConfig;
  customApi: CustomApiConfig;
  sourceTypeMapping: Record<string, SourceTypeConfig>;
  /** localStorage key suffix for tab visibility signal (e.g., "price_request_tab") */
  tabVisibilityFlagName?: string;
}

/**
 * Configuration for the Request Type column (injected programmatically)
 */
export interface RequestTypeColumnConfig {
  logicalName: string;
  labelKey: string;
  type: 'OptionSet';
  required: boolean;
  options: RequestTypeOption[];
}

/**
 * Option for Request Type dropdown
 */
export interface RequestTypeOption {
  value: number; // 0=Price, 1=Acquisition
  labelKey: string;
}

/**
 * Custom API configuration for product requests
 */
export interface CustomApiConfig {
  actionName: string;
  existingRequestEntity: string;
  productDetailEntity: string;
}

/**
 * Source type configuration for mapping parent entity to API parameters
 */
export interface SourceTypeConfig {
  filterField: string; // e.g., "_emd_quote_value"
  recordType: number;  // 0=Quote, 1=Opportunity
}

/**
 * Product Request View Configuration with separate catalog and write-in views
 */
export interface ProductRequestViewConfig {
  /** Catalog view config - for products selected from search */
  catalogView: ProductRequestSubViewConfig;
  /** Write-in view config - for manually entered products */
  writeInView: ProductRequestSubViewConfig;
}

/**
 * Sub-view configuration for Product Request (catalog or write-in)
 */
export interface ProductRequestSubViewConfig {
  name: string;
  savedQueryId: string;
  columns?: ColumnConfig[];
}

/**
 * Product Request Row (unified for both write-in and catalog)
 */
export interface ProductRequestRow {
  _tempId: string;
  _isWriteIn: boolean;
  _productId?: string; // Product GUID if from catalog
  _productName?: string; // Product name if from catalog
  _productCode?: string; // Product code if from catalog
  _productData?: VirtualTableRow; // Original product data if from catalog
  requesttype?: number; // 0=Price, 1=Acquisition (REQUIRED)
  // Dynamic fields from view columns (quantity, description, emd_producttype, etc.)
  // ESLint false positive: Index signature accommodates both FieldValue and VirtualTableRow types
  // while maintaining explicit type definitions for underscore-prefixed metadata properties
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  [key: string]: FieldValue | VirtualTableRow | string | boolean | undefined;
}

/**
 * Information about an existing acquisition/pricing request
 */
export interface ExistingRequestInfo {
  recordId: string;
  products: Map<string, number>; // productId → quantity
  writeInProducts: Map<string, number>; // productName → quantity
}

/**
 * Result of checking for existing product requests
 */
export interface ExistingRequestCheckResult {
  hasExisting: boolean;
  existingRequest?: ExistingRequestInfo;
  itemsToProcess: ProductRequestRow[]; // Items that are new or changed
  allExist: boolean; // True if ALL items already exist with same quantity
}

/**
 * Payload for the Product Request Custom API
 */
export interface ProductRequestApiPayload {
  type: number; // 0=Price, 1=Acquisition
  selectedItems: string; // Comma-separated temp/detail IDs
  isExisting: boolean;
  parentId: string;
  recordNumber: string;
  customerId: string;
  productDetails: string; // JSON stringified array
  existingRecordId: string | null;
  recordType: number; // 0=Quote, 1=Opportunity
}

/**
 * Product detail item for the Custom API payload
 */
export interface ProductDetailPayload {
  detailId: string;
  productId: string | null;
  quantity: number;
  productName: string | null;
  productCode: string | null;
  description: string | null;
  productType: number;
}