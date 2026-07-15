/**
 * RecordOperationsService
 * 
 * Handles all Dataverse record create/update operations for the ProductAddGrid control.
 * 
 * Responsibilities:
 * - Creating detail entity records (opportunityproduct, quotedetail, salesorderdetail, etc.)
 * - Retrieving parent record information (currency, customer, record number)
 * - Building record payloads from staged products and view metadata
 * - Type conversion for Dataverse Web API compatibility
 * - Applying field mappings from product entity to detail entity
 * - Tax rate conversion for write-in products
 * - Custom API action execution on records
 * 
 * Architecture:
 * - Injected dependencies: Context, MetadataService
 * - Uses config-driven systemFields for field mappings
 * - Suffix matching for publisher-prefixed fields
 * - Pattern-based type conversion (no hardcoded entity logic)
 */

import { 
  StagedProduct, 
  ParentRecord, 
  ViewMetadata, 
  ViewColumnMetadata, 
  SystemFieldMappings, 
  ProductFieldMapping, 
  FieldValue,
  ConditionalFieldConfig,
  VirtualTableRow,
  FieldConversion
} from '../types';
import { normalizeKey } from '../utils/stringUtils';
import { extractErrorMessage, isMissingFieldError } from '../utils/errorUtils';
import { LoggerService } from './LoggerService';
import { MetadataService } from './MetadataService';
import { ConfigService } from './ConfigService';

export class RecordOperationsService {
  private context: ComponentFramework.Context<unknown>;
  private webApi: ComponentFramework.WebApi;
  private metadataService: MetadataService;

  constructor(
    context: ComponentFramework.Context<unknown>,
    metadataService: MetadataService
  ) {
    this.context = context;
    this.webApi = context.webAPI;
    this.metadataService = metadataService;
  }

  // =============================================================================
  // PUBLIC API - Parent Record Operations
  // =============================================================================

  /**
   * Get parent record information (includes currency if entity has it)
   * @param entityName - Parent entity logical name
   * @param recordId - Parent record ID
   * @param hasCurrency - Whether entity has transactioncurrencyid field (default: true)
   */
  async getParentRecord(entityName: string, recordId: string, hasCurrency = true, extraSelect?: string[]): Promise<ParentRecord> {
    try {
      // Build the $select list: currency (when the entity has it) plus any caller-requested extra
      // columns (e.g. the reservation path requests emd_logocode to detect Logo-bound vs draft).
      const selectFields = [
        ...(hasCurrency ? ['_transactioncurrencyid_value'] : []),
        ...(extraSelect ?? [])
      ];

      // Only query currency field if entity has it
      if (hasCurrency) {
        // OData requires _<field>_value format to select a lookup GUID
        const queryOptions = `?$select=${selectFields.join(',')}`;

        const response = await this.webApi.retrieveRecord(entityName, recordId, queryOptions);

        const currencyId = String(response._transactioncurrencyid_value ?? '');

        return {
          id: recordId,
          entityName,
          transactionCurrencyId: currencyId,
          ...response
        };
      } else if (selectFields.length > 0) {
        // No currency, but the caller asked for extra columns — retrieve just those and spread them.
        const queryOptions = `?$select=${selectFields.join(',')}`;
        const response = await this.webApi.retrieveRecord(entityName, recordId, queryOptions);

        return {
          id: recordId,
          entityName,
          transactionCurrencyId: '', // No currency for this entity
          ...response
        };
      } else {
        // Entity doesn't have currency field and nothing extra requested - return bare record
        return {
          id: recordId,
          entityName,
          transactionCurrencyId: '' // No currency for this entity
        };
      }
    } catch (error: unknown) {
      const errorMessage = extractErrorMessage(error);
      
      // Check if error is due to missing transactioncurrencyid field (HTTP 400)
      if (isMissingFieldError(error) && errorMessage.toLowerCase().includes('transactioncurrencyid')) {
        // Entity doesn't have currency field - return record without currency
        return {
          id: recordId,
          entityName,
          transactionCurrencyId: '' // No currency for this entity
        };
      }
      
      // For other errors, rethrow
      LoggerService.error('Error retrieving parent record:', error);
      throw new Error(`Failed to retrieve parent record: ${errorMessage}`);
    }
  }

  /**
   * Get parent record information for product request (includes record number and customer)
   * Uses recordNumberField from entity config instead of hardcoded field names
   */
  async getParentRecordForProductRequest(
    entityName: string,
    recordId: string,
    configService: ConfigService
  ): Promise<{ recordNumber: string; customerId: string } | null> {
    try {
      const recordNumberField = configService.getRecordNumberField(entityName);
      
      if (!recordNumberField) {
        return null;
      }

      const selectFields = `${recordNumberField},_customerid_value`;
      const response = await this.webApi.retrieveRecord(entityName, recordId, `?$select=${selectFields}`);
      
      return {
        recordNumber: String(response[recordNumberField] ?? ''),
        customerId: String(response._customerid_value ?? '')
      };
    } catch (error) {
      LoggerService.error('Error fetching parent record for product request:', error);
      return null;
    }
  }

  // =============================================================================
  // PUBLIC API - Record Creation Operations
  // =============================================================================

  /**
   * Check for existing products on parent record
   * Returns array of productIds that already exist
   * @param parentLookupField Parent lookup field logical name (e.g., 'opportunityid')
   * @param parentRecordId Parent record ID
   * @param productLookupField Product lookup field logical name (e.g., 'productid')
   * @param detailEntitySet Detail entity set name (e.g., 'opportunityproducts')
   */
  async getExistingProductIds(
    parentLookupField: string,
    parentRecordId: string,
    productLookupField: string,
    detailEntitySet: string
  ): Promise<string[]> {
    try {
      // Query detail records for this parent, selecting only the product lookup field.
      // Exclude inactive detail records (statecode = 0 is active for all Dataverse entities)
      // so a product that only exists on an inactive line is not treated as a duplicate.
      const filter = `_${parentLookupField}_value eq ${parentRecordId} and statecode eq 0`;
      const select = `_${productLookupField}_value`;
      const query = `?$select=${select}&$filter=${filter}`;
      
      
      const response = await this.webApi.retrieveMultipleRecords(detailEntitySet, query);
      
      // Extract product IDs from the results
      const existingProductIds = response.entities
        .map(record => record[`_${productLookupField}_value`] as string | null | undefined)
        .filter((id): id is string => !!id)
        .map(id => id.toLowerCase());
      
      
      return existingProductIds;
    } catch (error) {
      LoggerService.error('Error checking for existing products:', error);
      // On error, return empty array to allow save to proceed
      return [];
    }
  }

  /**
   * Saves staged products to Dataverse
   * @param stagedProducts Products to save
   * @param parentRecordId Parent record ID
   * @param detailEntityName Detail entity logical name
   * @param systemFields System field mappings
   * @param catalogViewMetadata View metadata for catalog products
   * @param writeInViewMetadata View metadata for write-in products (null if not enabled)
   * @param currencyId Currency lookup ID (optional)
   * @param uomId UOM lookup ID (optional)
   * @param productFieldMappings Product field mappings (optional)
   * @param conditionalFields Conditional field configs for type-aware conversion (optional)
   */
  async saveProducts(
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
    if (stagedProducts.length === 0) {
      return [];
    }

    try {
      // Create each product record sequentially using WebAPI
      let successCount = 0;
      const errors: string[] = [];
      // GUIDs of the lines actually created, in order. Returned to the caller so the reservation
      // path can hand them to the batched emd_SyncReservationLines dispatcher (or to its compensate
      // mode if the loop aborts mid-way).
      const createdIds: string[] = [];

      for (const staged of stagedProducts) {
        try {
          const isWriteIn = staged.isWriteIn === true;
          const stagedProductId = staged.product?.productid ?? staged.productId;

          // Pattern-based: Select correct view metadata based on product type
          const viewMetadata = isWriteIn
            ? (writeInViewMetadata ?? catalogViewMetadata)  // Fallback if write-in view not configured
            : catalogViewMetadata;


          // Build the record data using config-driven system fields
          const recordData: ComponentFramework.WebApi.Entity = {};

          this.buildRecordDataFromSystemFields(
            recordData,
            systemFields,
            parentRecordId,
            stagedProductId,
            uomId,
            currencyId,
            isWriteIn
          );

          // Add product field mappings (product data -> detail fields)
          if (!isWriteIn && productFieldMappings && productFieldMappings.length > 0) {
            this.applyProductFieldMappings(recordData, staged.product, productFieldMappings);
          }

          // Add dynamic fields from view columns
          this.addDynamicFieldsFromView(recordData, staged, viewMetadata, systemFields, conditionalFields);

          // Reservation batch-add: stamp the transient defer signal so ProcessReservationLinePlugin
          // does all per-line bookkeeping but skips ONLY the per-line Logo push — the single batched
          // push is fired afterwards by emd_SyncReservationLines.
          if (skipLogoPushSignalField) {
            recordData[skipLogoPushSignalField] = true;
          }

          // Create the record using WebAPI
          const result = await this.webApi.createRecord(detailEntityName, recordData);
          createdIds.push(result.id);
          successCount++;

        } catch (recordError) {
          const productName = staged.isWriteIn ? 'Write-in product' : (staged.product?.name ?? staged.productId);
          const errorMsg = `Failed to create record for ${productName}: ${extractErrorMessage(recordError)}`;
          LoggerService.error(errorMsg);

          // Reservation path: "N lines + the Logo push" is a true unit — abort on the first failure
          // rather than accumulate-and-continue, so we never batch-push a partially-created set. The
          // already-created IDs ride along on the error so the caller can compensate (delete) them.
          if (abortOnFirstFailure) {
            const abortError = new Error(errorMsg) as Error & { createdIds?: string[] };
            abortError.createdIds = createdIds;
            throw abortError;
          }

          errors.push(errorMsg);
        }
      }

      // If any errors occurred, throw with summary
      if (errors.length > 0) {
        if (successCount === 0) {
          throw new Error(`Failed to create any records: ${errors[0]}`);
        }
      }

      return createdIds;

    } catch (error) {
      LoggerService.error('SAVE PRODUCTS ERROR:', error);
      throw error;
    }
  }

  /**
   * Create a single detail record (for Product Requests)
   * Returns the ID of the created record
   */
  async createDetailRecord(
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
    fieldConversions?: FieldConversion[]
  ): Promise<string> {
    const recordData: ComponentFramework.WebApi.Entity = {};
    
    // Build system fields (parent, product, uom, currency lookups)
    this.buildRecordDataFromSystemFields(
      recordData,
      systemFields,
      parentRecordId,
      productId ?? undefined,
      uomId,
      currencyId,
      isWriteIn
    );

    // Apply product field mappings (catalog products only)
    if (!isWriteIn && productFieldMappings && productFieldMappings.length > 0 && product) {
      this.applyProductFieldMappings(recordData, product, productFieldMappings);
    }
    
    // Add field values from the row
    if (fieldValues && viewMetadata.columns) {
      for (const column of viewMetadata.columns) {
        const value = fieldValues[column.logicalName];
        if (value !== undefined && value !== null && value !== '') {
          // Skip system fields that are handled separately
          const systemFieldNames = [
            systemFields.parentLookup.logicalName,
            systemFields.productLookup.logicalName,
            systemFields.uomLookup?.logicalName,
            systemFields.currencyLookup?.logicalName
          ].filter(Boolean);
          
          if (!systemFieldNames.includes(column.logicalName)) {
            const convertedValue = this.convertValueByColumnType(value, column);
            if (convertedValue !== undefined) {
              recordData[column.logicalName] = convertedValue;
            }
          }
        }
      }
    }

    // Apply config-driven field conversions (e.g., OptionSet → Decimal)
    if (fieldValues && fieldConversions && fieldConversions.length > 0) {
      this.applyFieldConversions(recordData, fieldValues, fieldConversions);
    }
    
    const result = await this.webApi.createRecord(detailEntityName, recordData);
    return result.id;
  }

  /**
   * Call a custom API action on a detail record
   */
  async callCustomApi(
    actionName: string,
    entityName: string,
    recordId: string
  ): Promise<void> {
    // Build the bound action URL
    // Format: /api/data/v9.2/{entityset}({id})/Microsoft.Dynamics.CRM.{actionName}
    const entitySet = await this.metadataService.getEntitySetName(entityName);
    
    if (!entitySet) {
      throw new Error(`Could not determine entity set for ${entityName}`);
    }

    
    // Use Xrm.WebApi.execute for bound actions
    const request = {
      entity: {
        entityType: entityName,
        id: recordId
      },
      getMetadata: () => ({
        boundParameter: 'entity',
        operationType: 0, // 0 = Action
        operationName: actionName,
        parameterTypes: {}
      })
    };

    // Execute the action
    const response = await (window as unknown as { Xrm: { WebApi: { execute: (req: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }> } } }).Xrm.WebApi.execute(request);
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Custom API failed: ${JSON.stringify(errorData)}`);
    }
    
  }

  // =============================================================================
  // PRIVATE HELPERS - Record Construction
  // =============================================================================

  /**
   * Build record data using new config-driven systemFields structure
   */
  private buildRecordDataFromSystemFields(
    recordData: ComponentFramework.WebApi.Entity,
    systemFields: SystemFieldMappings,
    parentRecordId: string,
    productId: string | undefined,
    uomId: string | undefined,
    currencyId: string | undefined,
    isWriteIn: boolean
  ): void {
    // Parent lookup binding (always required)
    const parentConfig = systemFields.parentLookup;
    const parentNavProp = parentConfig.navProperty ?? parentConfig.logicalName;
    recordData[`${parentNavProp}@odata.bind`] = `/${parentConfig.entitySet}(${parentRecordId})`;
    
    if (isWriteIn) {
      // Write-in product: apply write-in static fields from config (no product/uom lookup)
      if (systemFields.writeInStaticFields) {
        for (const [fieldName, value] of Object.entries(systemFields.writeInStaticFields)) {
          recordData[fieldName] = value;
        }
      }
    } else {
      // Product lookup binding (required for catalog products)
      const productConfig = systemFields.productLookup;
      const productNavProp = productConfig.navProperty ?? productConfig.logicalName;
      recordData[`${productNavProp}@odata.bind`] = `/${productConfig.entitySet}(${productId})`;
      
      // UoM lookup binding (optional - for entities that require UoM)
      if (systemFields.uomLookup && uomId) {
        const uomConfig = systemFields.uomLookup;
        const uomNavProp = uomConfig.navProperty ?? uomConfig.logicalName;
        recordData[`${uomNavProp}@odata.bind`] = `/${uomConfig.entitySet}(${uomId})`;
      }
    }
    
    // Currency lookup binding (optional - for entities with currency)
    if (systemFields.currencyLookup && currencyId) {
      const currencyConfig = systemFields.currencyLookup;
      const currencyNavProp = currencyConfig.navProperty ?? currencyConfig.logicalName;
      recordData[`${currencyNavProp}@odata.bind`] = `/${currencyConfig.entitySet}(${currencyId})`;
    }
    
    // Static fields (optional - for fields that should always have a fixed value)
    if (systemFields.staticFields) {
      for (const [fieldName, value] of Object.entries(systemFields.staticFields)) {
        recordData[fieldName] = value;
      }
    }
  }

  /**
   * Apply product-to-detail field mappings from config
   * For mappings with required: true, the field is always included (even if empty)
   */
  private applyProductFieldMappings(
    recordData: ComponentFramework.WebApi.Entity,
    product: VirtualTableRow | undefined,
    mappings: ProductFieldMapping[]
  ): void {
    if (!product) return;
    
    for (const mapping of mappings) {
      const productValue = product[mapping.fromProductField];
      
      // If mapping is required, always include the field
      if (mapping.required) {
        recordData[mapping.toDetailField] = productValue ?? '';
      } else if (productValue !== undefined && productValue !== null && productValue !== '') {
        // Only include non-required fields if they have a value
        recordData[mapping.toDetailField] = productValue;
      }
    }
  }

  /**
   * Apply config-driven field conversions to the record payload
   * Generic handler for patterns like OptionSet → Decimal
   */
  private applyFieldConversions(
    recordData: ComponentFramework.WebApi.Entity,
    fieldValues: Record<string, FieldValue>,
    conversions: FieldConversion[]
  ): void {
    for (const conversion of conversions) {
      const sourceValue = fieldValues[conversion.sourceField];
      if (typeof sourceValue === 'number') {
        // Numeric keys in JSON come as string keys at runtime, so use String() for lookup
        const result = conversion.mapping[sourceValue];
        if (result !== undefined) {
          recordData[conversion.targetField] = result;
        }
      }
    }
  }

  /**
   * Parse a value to a number, stripping locale-formatted thousand separators.
   * Returns undefined if the value is not a string/number or the result is NaN.
   */
  private parseNumericString(value: unknown): number | undefined {
    const str = (typeof value === 'string' || typeof value === 'number') ? String(value) : '';
    const num = parseFloat(str.replace(/,/g, ''));
    return isNaN(num) ? undefined : num;
  }

  /**
   * Convert field value to appropriate type based on column metadata
   * Handles type conversion for Dataverse API (strings → numbers, OptionSet labels → values, etc.)
   */
  private convertValueByColumnType(value: unknown, column: ViewColumnMetadata): unknown {
    // Handle null/undefined/empty string - these should be excluded from payload
    if (value === null || value === undefined || value === '') {
      return undefined;
    }

    // Use attributeType from ViewColumnMetadata for type checking
    const attrType = column.attributeType;

    // Handle numeric types
    if (attrType === 'Decimal' || attrType === 'Money' || attrType === 'Double') {
      if (typeof value === 'number') return value;
      const num = this.parseNumericString(value);
      return num;
    }

    // Handle integer types
    if (attrType === 'Integer') {
      if (typeof value === 'number') return Math.floor(value);
      const num = this.parseNumericString(value);
      return num !== undefined ? Math.floor(num) : undefined;
    }

    // Handle OptionSet/Picklist
    if (attrType === 'Picklist' || attrType === 'State' || attrType === 'Status') {
      // OptionSet fields must be sent as numeric value, not label
      if (typeof value === 'number') return value;
      // Try direct conversion to number (if value is already numeric string)
      const picklistNum = Number(value);
      return isNaN(picklistNum) ? undefined : picklistNum;
      // Note: Label → value mapping would require options metadata which ViewColumnMetadata doesn't have
    }

    // Handle boolean
    if (attrType === 'Boolean') {
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === '1' || value === 1;
    }

    // Handle text types
    if (attrType === 'String' || attrType === 'Memo') {
      return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ? String(value) : '';
    }

    // Handle DateTime
    if (attrType === 'DateTime') {
      // DateTime values (ISO strings or Date objects) - keep as-is
      return value;
    }

    // For Lookup and other types, return as-is
    return value;
  }

  /**
   * Add dynamic fields from view columns to record data
   * Only includes columns that are valid for create and have user-edited values
   * Read-only columns from the view are ignored (not saved)
   * @param conditionalFields Optional conditional field configs for type-aware conversion
   */
  private addDynamicFieldsFromView(
    recordData: ComponentFramework.WebApi.Entity,
    staged: StagedProduct,
    viewMetadata: ViewMetadata,
    systemFields?: SystemFieldMappings | null,
    conditionalFields?: ConditionalFieldConfig[]
  ): void {
    // Build set of system field logical names to exclude from dynamic fields
    const systemFieldNames = new Set<string>();
    if (systemFields) {
      systemFieldNames.add(systemFields.parentLookup.logicalName.toLowerCase());
      systemFieldNames.add(systemFields.productLookup.logicalName.toLowerCase());
      if (systemFields.uomLookup) {
        systemFieldNames.add(systemFields.uomLookup.logicalName.toLowerCase());
      }
      if (systemFields.currencyLookup) {
        systemFieldNames.add(systemFields.currencyLookup.logicalName.toLowerCase());
      }
    }
    
    // Also exclude common metadata/UI fields and StagedProduct internal properties
    const excludedFields = new Set([
      'productid', 'name', '_isvirtual', '_modifiedfields', 
      'id', 'validationerrors', 'haspendingchanges', 'iswritein',
      'editedfields', 'product', 'unitprice'
    ]);
    
    // Process view columns that are valid for create AND editable (not read-only)
    for (const column of viewMetadata.columns) {
      const fieldName = column.logicalName.toLowerCase();
      
      // Skip system fields (handled separately)
      if (systemFieldNames.has(fieldName)) continue;
      
      // Skip excluded metadata fields
      if (excludedFields.has(fieldName)) continue;
      
      // Skip if not valid for create
      if (!column.isValidForCreate) continue;
      
      // Skip read-only columns - only save editable fields
      if (!column.isValidForUpdate) continue;
      
      // Priority for getting values:
      // 1. editedFields (user-edited values from UI) - with suffix matching
      // 2. Staged top-level properties (direct field access: quantity, description, etc.)
      // 3. staged.product property (original product data)
      let value: unknown;
      
      // First check editedFields (all user edits stored here)
      // ARCHITECTURAL: Use suffix matching because editedFields may use config logical names
      // (e.g., "quantity") while view columns have actual Dataverse names (e.g., "crcad_quantity")
      if (staged.editedFields) {
        // Try exact match first
        if (column.logicalName in staged.editedFields) {
          value = staged.editedFields[column.logicalName];
        } else {
          // Suffix matching: if column is "crcad_quantity", check for "quantity" in editedFields
          const normalizedColumn = normalizeKey(column.logicalName);
          for (const editKey of Object.keys(staged.editedFields)) {
            const normalizedEditKey = normalizeKey(editKey);
            // Match if the column ends with _editKey (e.g., crcad_quantity ends with _quantity)
            if (normalizedColumn.endsWith(`_${normalizedEditKey}`) || normalizedColumn === normalizedEditKey) {
              value = staged.editedFields[editKey];
              break;
            }
          }
        }
      }
      
      // Fall back to staged top-level properties (also with suffix matching)
      if (value === undefined) {
        const stagedRecord = staged as unknown as Record<string, unknown>;
        // Try exact match first
        if (column.logicalName in stagedRecord) {
          value = stagedRecord[column.logicalName];
        } else {
          // Suffix matching for staged properties
          const normalizedColumn = normalizeKey(column.logicalName);
          for (const propKey of Object.keys(stagedRecord)) {
            const normalizedPropKey = normalizeKey(propKey);
            if (normalizedColumn.endsWith(`_${normalizedPropKey}`) || normalizedColumn === normalizedPropKey) {
              value = stagedRecord[propKey];
              break;
            }
          }
        }
      }
      
      // Fall back to product data
      if (value === undefined && staged.product) {
        value = staged.product[column.logicalName];
      }
      
      // Convert value based on column type before adding to payload
      const convertedValue = this.convertValueByColumnType(value, column);
      
      // Only add if converted value is valid (exclude undefined, null, empty string)
      if (convertedValue !== undefined && convertedValue !== null && convertedValue !== '') {
        // User-edited values from view can overwrite productFieldMappings
        recordData[column.logicalName] = convertedValue;
      }
    }
    
    // ARCHITECTURAL FIX: Also process editedFields that aren't in view columns
    // This handles conditional fields and any other user-edited fields that may not be in the view
    // (e.g., conditional fields like emd_existingcustomer, emd_licenseduration, emd_projectcode)
    if (staged.editedFields) {
      const processedFields = new Set(Object.keys(recordData).map(k => k.toLowerCase()));
      
      for (const [fieldName, value] of Object.entries(staged.editedFields)) {
        const normalizedFieldName = fieldName.toLowerCase();
        
        // Skip if already processed from view columns
        if (processedFields.has(normalizedFieldName)) continue;
        
        // Skip system fields
        if (systemFieldNames.has(normalizedFieldName)) continue;
        
        // Skip excluded metadata fields
        if (excludedFields.has(normalizedFieldName)) continue;
        
        // Skip if value is invalid
        if (value === undefined || value === null || value === '') continue;
        
        // For fields not in view metadata, check if it's a conditional field with known type
        // If so, respect the configured type instead of guessing
        let convertedValue: unknown;
        const conditionalField = conditionalFields?.find(
          cf => cf.logicalName.toLowerCase() === normalizedFieldName
        );
        
        if (conditionalField) {
          // Use the conditional field's configured type
          switch (conditionalField.type) {
            case 'Text':
              // Text fields should always be strings, even if they contain only numbers
              convertedValue = String(value);
              break;
            case 'Integer':
              convertedValue = typeof value === 'number' ? Math.floor(value) : parseInt(String(value), 10);
              if (isNaN(convertedValue as number)) convertedValue = undefined;
              break;
            case 'OptionSet':
              // OptionSet fields should be numeric values
              // Check if stringBased flag is set - if so, send as string
              if (conditionalField.stringBased) {
                convertedValue = String(value);
              } else {
                convertedValue = typeof value === 'number' ? value : Number(value);
                if (isNaN(convertedValue as number)) convertedValue = undefined;
              }
              break;
            default:
              convertedValue = value;
          }
        } else if (typeof value === 'number') {
          // Could be Integer, Decimal, or OptionSet
          convertedValue = value;
        } else if (typeof value === 'boolean') {
          convertedValue = value;
        } else {
          // For unknown string fields, preserve as string (don't guess numeric conversion)
          convertedValue = value;
        }
        
        recordData[fieldName] = convertedValue;
      }
    }
  }
}
