/**
 * ColumnService
 * 
 * Responsibility: View metadata and column configuration
 * 
 * Handles all view-related metadata operations including FetchXML parsing,
 * column resolution, and merging view metadata with static configuration.
 * Provides hybrid view support for product detail entities.
 */

import { 
  ViewMetadata, 
  ViewColumnMetadata, 
  MergedColumnConfig, 
  ColumnConfig, 
  EntityMetadata, 
  AttributeMetadata, 
  FieldType, 
  OptionSetOption 
} from '../types';
import { MetadataService } from './MetadataService';
import { CacheService } from './CacheService';
import { LoggerService } from './LoggerService';
import { formatLogicalName } from '../utils/gridUtils';
import { normalizeKey } from '../utils/stringUtils';

/**
 * Maps column logical name to entity/attribute target
 */
interface ColumnTarget {
  entity: string;
  attribute: string;
}

/**
 * Singleton DOMParser for XML parsing operations
 */
const domParser = new DOMParser();

export class ColumnService {
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

  /**
   * PUBLIC API: Retrieve view metadata from Dataverse saved query
   * 
   * Fetches saved query (view) definition including FetchXML and LayoutXML,
   * parses column information, and returns structured metadata.
   * 
   * @param savedQueryId - GUID of the saved query
   * @param entityName - Target entity name (default: 'product')
   * @returns View metadata with column definitions or null if not found
   */
  public async getViewMetadata(savedQueryId: string, entityName = 'product'): Promise<ViewMetadata | null> {
    try {
      // First, get the saved query (view) definition
      const viewResponse = await this.webApi.retrieveRecord(
        'savedquery',
        savedQueryId,
        '?$select=name,fetchxml,layoutxml'
      );

      if (!viewResponse.layoutxml) {
        return null;
      }

      // Parse the layout XML to extract column information
      const layoutDoc = domParser.parseFromString(viewResponse.layoutxml as string, 'text/xml');
      const cells = layoutDoc.querySelectorAll('cell');

      const columns: ViewColumnMetadata[] = [];

      const { fieldMap, aliasEntityMap } = this.buildFetchXmlFieldMaps(viewResponse.fetchxml as string | undefined);

      // Get entity metadata for attribute types
      const entityMetadata = await this.metadataService.getEntityMetadata(entityName);
      
      // ARCHITECTURAL: Respect view configuration - only display columns explicitly in the view cells
      // Jump field is for navigation, not for forcing columns to appear
      // If the view designer didn't include the jump field as a visible column, we honor that.
      
      // Process cells in parallel but preserve view column order
      // Create array of cell info with indices first
      const cellsArray = Array.from(cells).map((cell, index) => ({
        index,
        logicalName: cell.getAttribute('name'),
        width: parseInt(cell.getAttribute('width') ?? '100', 10)
      }));
      
      // Process all columns in parallel and collect results with their indices
      const columnResults = await Promise.all(
        cellsArray.map(async (cellInfo) => {
          if (!cellInfo.logicalName) return null;
          
          const tempColumns: ViewColumnMetadata[] = [];
          await this.processColumnField(
            cellInfo.logicalName, 
            cellInfo.width, 
            entityMetadata, 
            tempColumns, 
            entityName, 
            fieldMap, 
            aliasEntityMap
          );
          
          return tempColumns.length > 0 ? { index: cellInfo.index, column: tempColumns[0] } : null;
        })
      );
      
      // Sort by original index and add to columns array in view order
      columnResults
        .filter((result): result is { index: number; column: ViewColumnMetadata } => result !== null)
        .sort((a, b) => a.index - b.index)
        .forEach(result => columns.push(result.column));

      return {
        savedQueryId,
        name: viewResponse.name as string,
        columns,
        fetchXml: viewResponse.fetchxml as string | undefined,
        layoutXml: viewResponse.layoutxml as string | undefined
      };

    } catch (error) {
      LoggerService.error('Error retrieving view metadata:', error);
      return null;
    }
  }

  /**
   * PUBLIC API: Create merged column configuration from view metadata and static config
   * 
   * Combines dynamic view metadata with static configuration overrides,
   * handles priority columns, suffix matching for publisher-prefixed fields,
   * and automatic exclusion patterns.
   * 
   * @param viewMetadata - View metadata from Dataverse
   * @param staticColumns - Static column configuration overrides
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
    // formatLogicalName is now imported from gridUtils
    // normalizeKey is now imported from stringUtils (global memoized utility)
    const prioritySet = new Set(priorityColumns.map(normalizeKey));

    const overridesByLogicalName = new Map<string, ColumnConfig>();
    staticColumns.forEach(column => {
      const logicalKey = normalizeKey(column.logicalName);
      if (!logicalKey) return; // Skip malformed entries without logicalName
      if (!overridesByLogicalName.has(logicalKey)) {
        overridesByLogicalName.set(logicalKey, column);
      }

      if (column.mapTo && column.mapTo !== column.logicalName) {
        const mappedKey = normalizeKey(column.mapTo);
        if (!overridesByLogicalName.has(mappedKey)) {
          overridesByLogicalName.set(mappedKey, column);
        }
      }
    });

    // Debug: Log all overrides (only compute expensive arrays when debug is enabled)
    if (LoggerService.isDebugEnabled()) {
      const excludedOverrides = Array.from(overridesByLogicalName.entries())
        .filter(([, v]) => v.exclude)
        .map(([k]) => k);
      LoggerService.debug('Column overrides with exclude flag:', excludedOverrides);
    }

    const addedLogicalNames = new Set<string>();
    const priorityResults: MergedColumnConfig[] = [];
    const regularResults: MergedColumnConfig[] = [];

    const getResultBucket = (logicalName: string): MergedColumnConfig[] => {
      return prioritySet.has(normalizeKey(logicalName)) ? priorityResults : regularResults;
    };

    const addMergedColumn = (logicalName: string, column: {
      labelKey?: string;
      displayName?: string;
      readOnly?: boolean;
      required?: boolean;
      width?: number;
      type?: FieldType;
      fromView?: boolean;
      isValidForRead?: boolean;
      isValidForCreate?: boolean;
      isValidForUpdate?: boolean;
      editable?: boolean;
      sourceLogicalName?: string;
      hidden?: boolean;
      sourceEntity?: string;
      options?: OptionSetOption[];
      defaultValue?: number; // Default value for OptionSet fields
      maxLength?: number;
    }): void => {
      if (!logicalName) {
        return;
      }

      const normalized = normalizeKey(logicalName);
      if (addedLogicalNames.has(normalized)) {
        return;
      }

      const explicitReadOnly = column.readOnly;
      const explicitEditable = column.editable;
      const editable = explicitEditable ?? (explicitReadOnly !== undefined ? !explicitReadOnly : true);
      const readOnly = explicitReadOnly ?? !editable;
      
      // Always preserve displayName as fallback - don't set to undefined just because labelKey exists
      // The rendering logic will try labelKey first, then displayName, then formatted logicalName
      const displayName = column.displayName ?? formatLogicalName(logicalName);

      const normalizedSource = column.sourceLogicalName
        ? normalizeKey(column.sourceLogicalName)
        : undefined;
      const sourceLogicalName = normalizedSource && normalizedSource !== normalized
        ? column.sourceLogicalName
        : undefined;

      const mergedColumn: MergedColumnConfig = {
        logicalName,
        labelKey: column.labelKey,
        displayName,
        readOnly,
        required: column.required ?? false,
        width: column.width ?? 120,
        type: column.type ?? 'Text',
        fromView: column.fromView ?? false,
        isValidForRead: column.isValidForRead ?? true,
        isValidForCreate: column.isValidForCreate ?? true,
        isValidForUpdate: column.isValidForUpdate ?? true,
        editable,
        sourceLogicalName,
        hidden: column.hidden ?? false,
        sourceEntity: column.sourceEntity,
        options: column.options,
        defaultValue: column.defaultValue,
        maxLength: column.maxLength
      };

      getResultBucket(logicalName).push(mergedColumn);
      addedLogicalNames.add(normalized);
    };

    const addStaticColumn = (column: ColumnConfig): void => {
      if (column.exclude) {
        return;
      }

      const targetLogicalName = column.mapTo ?? column.logicalName;
      
      addMergedColumn(targetLogicalName, {
        labelKey: column.labelKey,
        displayName: column.labelKey ? undefined : column.logicalName,
        readOnly: column.readOnly,
        required: column.required,
        width: column.width,
        type: column.type,
        fromView: false,
        editable: column.editable,
        sourceLogicalName: normalizeKey(targetLogicalName) !== normalizeKey(column.logicalName)
          ? column.logicalName
          : undefined,
        hidden: column.hidden,
        maxLength: column.maxLength
      });
    };

    const getOverride = (viewColumn: ViewColumnMetadata): ColumnConfig | undefined => {
      const aliasBase = viewColumn.logicalName.split('.').pop();
      const candidates = [
        viewColumn.logicalName,
        viewColumn.originalLogicalName,
        aliasBase
      ];

      // First try exact matching
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        const override = overridesByLogicalName.get(normalizeKey(candidate));
        if (override) {
          return override;
        }
      }

      // If no exact match, try suffix matching for publisher-prefixed fields
      // e.g., "crcad_quantity" should match config key "quantity"
      const normalizedColumn = normalizeKey(viewColumn.logicalName);
      for (const [configKey, override] of overridesByLogicalName) {
        if (normalizedColumn.endsWith(`_${configKey}`)) {
          return override;
        }
      }

      return undefined;
    };

    const processViewColumn = async (viewColumn: ViewColumnMetadata): Promise<void> => {
      const override = getOverride(viewColumn);


      if (override?.exclude) {
        return;
      }

      // ARCHITECTURAL: Auto-exclude detail entity name fields in these scenarios:
      // 1. Write-in views: use 'productdescription' as name field
      // 2. Hybrid views with product columns: already showing product 'name', don't duplicate
      // Covers: opportunityproductname, quotedetailname, salesorderdetailname, etc.
      const shouldAutoExcludeNameField = isWriteInView || (isProductDetailView && productColumns.length > 0);
      if (shouldAutoExcludeNameField) {
        const normalized = normalizeKey(viewColumn.logicalName);
        // Exclude any field ending with 'name' EXCEPT 'productdescription'
        if (normalized.endsWith('name') && normalized !== 'productdescription') {
          return;
        }
      }

      const aliasBase = viewColumn.logicalName.split('.').pop();
      const targetLogicalName = override?.mapTo
        ?? override?.logicalName
        ?? aliasBase
        ?? viewColumn.logicalName;

      const labelKey = override?.labelKey;
      const required = override?.required;
      const readOnly = override?.readOnly;
      // Fix: For write-in views, default editable to true; otherwise use override, readOnly, or view metadata
      const editable = override?.editable ?? (isWriteInView ? (readOnly !== undefined ? !readOnly : true) : (readOnly !== undefined ? !readOnly : viewColumn.isValidForUpdate));
      const width = override?.width ?? (viewColumn.width > 0 ? viewColumn.width : undefined);
      const type = override?.type ?? this.mapAttributeTypeToFieldType(viewColumn.attributeType);
      
      const sourceLogicalName = normalizeKey(targetLogicalName) !== normalizeKey(viewColumn.logicalName)
        ? viewColumn.logicalName
        : undefined;

      // Determine the source entity for metadata lookups
      const sourceEntity = viewColumn.sourceEntity;

      // Load OptionSet options for editable OptionSet columns
      let options: OptionSetOption[] | undefined;
      let optionSetDisplayName: string | undefined;
      let optionSetDefaultValue: number | undefined;
      if (type === 'OptionSet' && editable && sourceEntity) {
        const optionSetMetadata = await this.metadataService.getOptionSetMetadata(sourceEntity, targetLogicalName);
        if (optionSetMetadata?.options) {
          options = optionSetMetadata.options;
          // Safely assign displayName if present
          if (optionSetMetadata.displayName !== undefined) {
            optionSetDisplayName = optionSetMetadata.displayName;
          }
          // Capture default value for OptionSet initialization
          if (optionSetMetadata.defaultValue !== undefined) {
            optionSetDefaultValue = optionSetMetadata.defaultValue;
          }
        }
      }

      // Use OptionSet metadata displayName if available, otherwise fall back to view column displayName
      const resolvedDisplayName = optionSetDisplayName ?? viewColumn.displayName;

      addMergedColumn(targetLogicalName, {
        labelKey,
        displayName: resolvedDisplayName,
        readOnly,
        required,
        width,
        type,
        fromView: true,
        isValidForRead: viewColumn.isValidForRead,
        isValidForCreate: viewColumn.isValidForCreate,
        isValidForUpdate: viewColumn.isValidForUpdate,
        editable,
        sourceLogicalName,
        hidden: override?.hidden,
        sourceEntity,
        options,
        defaultValue: optionSetDefaultValue,
        maxLength: override?.maxLength
      });
    };

    try {

      // STEP 1: Process priority product columns FIRST (name, crcad_productcode_ex)
      // These must appear in exact order at the beginning
      if (isProductDetailView && productColumns.length > 0) {
        
        // Process priority columns in order
        for (const priorityColumn of priorityColumns) {
          const normalized = normalizeKey(priorityColumn);
          if (!productColumns.some(col => normalizeKey(col) === normalized)) continue;
          if (addedLogicalNames.has(normalized)) continue;
          
          
          const override = overridesByLogicalName.get(normalized);
          
          // Check for exclusion (e.g., emd_brand excluded for salesorder)
          if (override?.exclude) {
            continue;
          }
          
          const attributeMetadata = await this.metadataService.getAttributeMetadata('product', priorityColumn);
          
          if (attributeMetadata) {
            
            // Mark productid as hidden - we need it for identification but don't render it
            const isProductId = normalized === 'productid';
            
            addMergedColumn(priorityColumn, {
              labelKey: override?.labelKey,
              displayName: attributeMetadata.displayName,
              readOnly: override?.readOnly ?? true, // Priority columns default to readonly
              required: override?.required,
              width: override?.width ?? 200,
              type: override?.type ?? this.mapAttributeTypeToFieldType(attributeMetadata.attributeType),
              fromView: false,
              isValidForRead: attributeMetadata.isValidForRead,
              isValidForCreate: attributeMetadata.isValidForCreate,
              isValidForUpdate: attributeMetadata.isValidForUpdate,
              editable: override?.editable ?? false, // Priority columns default to non-editable
              hidden: override?.hidden ?? isProductId // Hide productid by default
            });
          }
        }
        
        // STEP 2: Process remaining product columns (not in priority list)
        for (const productColumn of productColumns) {
          const normalized = normalizeKey(productColumn);
          if (prioritySet.has(normalized)) continue; // Skip priority columns (already added)
          if (addedLogicalNames.has(normalized)) continue;
          
          
          const override = overridesByLogicalName.get(normalized);
          
          // Check for exclusion (e.g., emd_brand excluded for salesorder)
          if (override?.exclude) {
            continue;
          }
          const attributeMetadata = await this.metadataService.getAttributeMetadata('product', productColumn);
          
          if (attributeMetadata) {
            
            // Mark productid as hidden - we need it for identification but don't render it
            const isProductId = normalized === 'productid';
            
            addMergedColumn(productColumn, {
              labelKey: override?.labelKey,
              displayName: attributeMetadata.displayName,
              readOnly: override?.readOnly ?? true,
              required: override?.required,
              width: override?.width ?? 150,
              type: override?.type ?? this.mapAttributeTypeToFieldType(attributeMetadata.attributeType),
              fromView: false,
              isValidForRead: attributeMetadata.isValidForRead,
              isValidForCreate: attributeMetadata.isValidForCreate,
              isValidForUpdate: attributeMetadata.isValidForUpdate,
              editable: override?.editable ?? (override?.readOnly !== undefined ? !override.readOnly : false),
              hidden: override?.hidden ?? isProductId // Hide productid by default
            });
          }
        }
      }
      
      // STEP 3: Process detail entity view columns
      // These come dynamically from the saved query, overrides apply for behavior only
      const remainingViewColumns = [...(viewMetadata?.columns ?? [])];
      
      // Filter out product columns from view columns if this is a product detail view
      const detailViewColumns = isProductDetailView
        ? remainingViewColumns.filter(col => {
            const sourceEntity = col.sourceEntity?.toLowerCase();
            const logicalName = col.logicalName?.split('.').pop() ?? col.logicalName;
            const normalized = normalizeKey(logicalName);
            
            // Exclude if from product entity OR if it's a product column we already added
            return sourceEntity !== 'product' && !addedLogicalNames.has(normalized);
          })
        : remainingViewColumns;

      // PERFORMANCE OPTIMIZATION: Pre-fetch all OptionSet metadata in parallel
      // Identify all editable OptionSet columns that need metadata
      const optionSetColumnsToFetch: { entityName: string; attributeName: string }[] = [];
      
      for (const viewColumn of detailViewColumns) {
        const override = getOverride(viewColumn);
        if (override?.exclude) continue;
        
        const aliasBase = viewColumn.logicalName.split('.').pop();
        const targetLogicalName = override?.mapTo ?? override?.logicalName ?? aliasBase ?? viewColumn.logicalName;
        const readOnly = override?.readOnly;
        const editable = override?.editable ?? (readOnly !== undefined ? !readOnly : viewColumn.isValidForUpdate);
        const type = override?.type ?? this.mapAttributeTypeToFieldType(viewColumn.attributeType);
        const sourceEntity = viewColumn.sourceEntity;
        
        // If this is an editable OptionSet column with a source entity, we need to fetch its metadata
        if (type === 'OptionSet' && editable && sourceEntity) {
          // Only add if not already cached
          const cached = CacheService.getOptionSetMetadata(sourceEntity, targetLogicalName);
          if (!cached) {
            optionSetColumnsToFetch.push({ entityName: sourceEntity, attributeName: targetLogicalName });
          }
        }
      }
      
      // Batch fetch all uncached OptionSet metadata in parallel
      if (optionSetColumnsToFetch.length > 0) {
        await Promise.all(
          optionSetColumnsToFetch.map(col => 
            this.metadataService.getOptionSetMetadata(col.entityName, col.attributeName)
          )
        );
      }

      // Now process view columns - OptionSet metadata is already cached
      for (const viewColumn of detailViewColumns) {
        await processViewColumn(viewColumn);
      }

      return [...priorityResults, ...regularResults];
    } catch (error) {
      LoggerService.error('Error creating view-based column config:', error);

      addedLogicalNames.clear();
      priorityResults.length = 0;
      regularResults.length = 0;

      staticColumns
        .filter(column => !column.exclude)
        .forEach(column => addStaticColumn(column));

      return [...priorityResults, ...regularResults];
    }
  }

  /**
   * Parse FetchXML to build field-to-entity mappings
   * 
   * Extracts entity and link-entity information from FetchXML to create
   * mappings from field names (including aliases) to their source entities.
   * 
   * @param fetchXml - FetchXML query string
   * @returns Field map and alias-to-entity map
   */
  private buildFetchXmlFieldMaps(fetchXml?: string | null): {
    fieldMap: Record<string, ColumnTarget>;
    aliasEntityMap: Record<string, string>;
  } {
    const fieldMap: Record<string, ColumnTarget> = {};
    const aliasEntityMap: Record<string, string> = {};

    if (!fetchXml) {
      return { fieldMap, aliasEntityMap };
    }

    try {
      const fetchDoc = domParser.parseFromString(fetchXml, 'text/xml');
      const entityNode = fetchDoc.querySelector('entity');

      if (!entityNode) {
        return { fieldMap, aliasEntityMap };
      }

      const entityName = entityNode.getAttribute('name');

      if (!entityName) {
        return { fieldMap, aliasEntityMap };
      }

      const alias = entityNode.getAttribute('alias') ?? entityName;
      const initialPath = alias.toLowerCase();

      this.collectFieldSources(
        entityNode,
        fieldMap,
        aliasEntityMap,
        {
          entityName,
          alias,
          path: initialPath
        }
      );
    } catch (_error) {
      // Silently ignore field source parse errors — field map remains partially populated
    }

    return { fieldMap, aliasEntityMap };
  }

  /**
   * Recursively collect field sources from FetchXML entity and link-entity elements
   * 
   * Traverses FetchXML DOM to map all attribute names and aliases to their
   * source entities, handling nested link-entities recursively.
   * 
   * @param node - Current XML element (entity or link-entity)
   * @param fieldMap - Field-to-entity mapping (mutated)
   * @param aliasEntityMap - Alias-to-entity mapping (mutated)
   * @param context - Current entity context (name, alias, path)
   */
  private collectFieldSources(
    node: Element,
    fieldMap: Record<string, ColumnTarget>,
    aliasEntityMap: Record<string, string>,
    context: { entityName: string; alias: string; path: string }
  ): void {
    const entityName = context.entityName;
    const entityNameLower = entityName.toLowerCase();
    const aliasLower = context.alias.toLowerCase();
    const pathLower = context.path.toLowerCase();

    aliasEntityMap[entityNameLower] = entityName;
    aliasEntityMap[aliasLower] = entityName;
    aliasEntityMap[pathLower] = entityName;

    const attributeNodes = Array.from(node.children).filter(child => child.nodeName.toLowerCase() === 'attribute');

    attributeNodes.forEach(attrNode => {
      const attributeName = attrNode.getAttribute('name');
      if (!attributeName) {
        return;
      }

      const attributeAlias = attrNode.getAttribute('alias');
      const attributeLower = attributeName.toLowerCase();

      const target: ColumnTarget = {
        entity: entityName,
        attribute: attributeName
      };

      const baseKey = attributeAlias ? attributeAlias.toLowerCase() : attributeLower;
      if (!fieldMap[baseKey]) {
        fieldMap[baseKey] = target;
      }

      const aliasAttributeKey = `${aliasLower}.${attributeLower}`;
      fieldMap[aliasAttributeKey] = target;

      const entityAttributeKey = `${entityNameLower}.${attributeLower}`;
      if (!fieldMap[entityAttributeKey]) {
        fieldMap[entityAttributeKey] = target;
      }

      if (attributeAlias) {
        const attrAliasLower = attributeAlias.toLowerCase();

        if (!fieldMap[attrAliasLower]) {
          fieldMap[attrAliasLower] = target;
        }

        const aliasAliasKey = `${aliasLower}.${attrAliasLower}`;
        fieldMap[aliasAliasKey] = target;

        const entityAliasKey = `${entityNameLower}.${attrAliasLower}`;
        if (!fieldMap[entityAliasKey]) {
          fieldMap[entityAliasKey] = target;
        }
      }
    });

    const linkEntities = Array.from(node.children).filter((child): child is Element => child.nodeName.toLowerCase() === 'link-entity');

    linkEntities.forEach(linkEntity => {
      const childEntityName = linkEntity.getAttribute('name');
      if (!childEntityName) {
        return;
      }

      const childAlias = linkEntity.getAttribute('alias') ?? childEntityName;
      const childAliasLower = childAlias.toLowerCase();
      const childPath = pathLower ? `${pathLower}.${childAliasLower}` : childAliasLower;

      aliasEntityMap[childAliasLower] = childEntityName;
      aliasEntityMap[childPath] = childEntityName;

      this.collectFieldSources(
        linkEntity,
        fieldMap,
        aliasEntityMap,
        {
          entityName: childEntityName,
          alias: childAlias,
          path: childPath
        }
      );
    });
  }

  /**
   * Resolve column logical name to entity/attribute pair using field maps
   * 
   * Handles various naming patterns including dotted notation, name suffix,
   * and aliased fields to determine the source entity and attribute.
   * 
   * @param logicalName - Column logical name (may include alias prefix)
   * @param baseEntityName - Base entity name for fallback
   * @param fieldMap - Field-to-entity mapping from FetchXML
   * @param aliasEntityMap - Alias-to-entity mapping from FetchXML
   * @returns Resolved entity/attribute target
   */
  private resolveColumnTarget(
    logicalName: string,
    baseEntityName: string,
    fieldMap: Record<string, ColumnTarget>,
    aliasEntityMap: Record<string, string>
  ): ColumnTarget {
    const normalized = logicalName.toLowerCase();

    const directTarget = fieldMap[normalized];
    if (directTarget) {
      return directTarget;
    }

    if (normalized.endsWith('name')) {
      const withoutName = normalized.slice(0, -4);
      const nameTarget = fieldMap[withoutName];
      if (nameTarget) {
        return nameTarget;
      }
    }

    if (normalized.includes('.')) {
      const parts = normalized.split('.');
      const attributePart = parts.pop() ?? normalized;
      const aliasPath = parts.join('.');
      const combinedKey = `${aliasPath}.${attributePart}`;

      const combinedTarget = fieldMap[combinedKey];
      if (combinedTarget) {
        return combinedTarget;
      }

      const aliasOnly = parts[parts.length - 1] ?? '';
      const aliasEntity = aliasEntityMap[aliasPath] ?? aliasEntityMap[aliasOnly];

      if (aliasEntity) {
        return {
          entity: aliasEntity,
          attribute: attributePart
        };
      }
    } else {
      const aliasEntity = aliasEntityMap[normalized];
      if (aliasEntity) {
        return {
          entity: aliasEntity,
          attribute: logicalName
        };
      }
    }

    const fallbackEntity = this.metadataService.getEntityForRelatedField(logicalName, baseEntityName);
    const fallbackAttribute = logicalName.includes('.')
      ? logicalName.split('.').pop() ?? logicalName
      : logicalName;

    return {
      entity: fallbackEntity,
      attribute: fallbackAttribute
    };
  }

  /**
   * Process a single column field and add it to columns array
   * 
   * Resolves the column to its source entity, fetches attribute metadata,
   * and creates a ViewColumnMetadata entry with full type information.
   * 
   * @param logicalName - Column logical name
   * @param width - Column width
   * @param entityMetadata - Entity metadata cache
   * @param columns - Target columns array (mutated)
   * @param entityName - Base entity name
   * @param fieldMap - Field-to-entity mapping from FetchXML
   * @param aliasEntityMap - Alias-to-entity mapping from FetchXML
   */
  private async processColumnField(
    logicalName: string, 
    width: number, 
    entityMetadata: EntityMetadata | null, 
    columns: ViewColumnMetadata[], 
    entityName: string,
    fieldMap: Record<string, ColumnTarget>,
    aliasEntityMap: Record<string, string>
  ): Promise<void> {
    const resolvedTarget = this.resolveColumnTarget(logicalName, entityName, fieldMap, aliasEntityMap);
    const actualFieldName = resolvedTarget.attribute;
    const targetEntityName = resolvedTarget.entity;

    let attributeMetadata: AttributeMetadata | null = null;

    if (entityMetadata?.logicalName.toLowerCase() === targetEntityName.toLowerCase()) {
      attributeMetadata = entityMetadata.attributes.find(
        attribute => attribute.logicalName.toLowerCase() === actualFieldName.toLowerCase()
      ) ?? null;
    }

    // If not found in the primary entity, try the target entity
    attributeMetadata ??= await this.metadataService.getAttributeMetadata(targetEntityName, actualFieldName);
    
    // For cross-entity scenarios, also try the product entity for product-related fields
    if (!attributeMetadata && targetEntityName !== 'product' && actualFieldName.startsWith('emd_')) {
      attributeMetadata = await this.metadataService.getAttributeMetadata('product', actualFieldName);
    }
    
    if (attributeMetadata) {
      columns.push({
        logicalName: actualFieldName, // Use the actual field name, not the linked version
        originalLogicalName: logicalName,
        displayName: attributeMetadata.displayName,
        attributeType: attributeMetadata.attributeType,
        width,
        isPrimaryKey: attributeMetadata.isPrimaryKey,
        isValidForRead: attributeMetadata.isValidForRead,
        isValidForCreate: attributeMetadata.isValidForCreate,
        isValidForUpdate: attributeMetadata.isValidForUpdate,
        sourceEntity: targetEntityName,
        sourceAttribute: actualFieldName
      });
    } else {
      // For fields we can't find metadata for, create a basic column definition with formatted name
      columns.push({
        logicalName: actualFieldName,
        originalLogicalName: logicalName,
        displayName: formatLogicalName(actualFieldName),
        attributeType: 'String',
        width,
        isPrimaryKey: false,
        isValidForRead: true,
        isValidForCreate: true,
        isValidForUpdate: true,
        sourceEntity: targetEntityName,
        sourceAttribute: actualFieldName
      });
    }
  }

  /**
   * Map Dataverse attribute type strings to internal FieldType enum
   * 
   * Converts Dataverse metadata attribute types to the internal
   * FieldType representation used throughout the application.
   * 
   * @param attributeType - Dataverse attribute type string
   * @returns Internal FieldType enum value
   */
  private mapAttributeTypeToFieldType(attributeType: string): FieldType {
    switch (attributeType.toLowerCase()) {
      case 'money':
      case 'decimal':
      case 'double':
        return 'Money';
      case 'integer':
        return 'Decimal';
      case 'datetime':
        return 'DateTime';
      case 'lookup':
        return 'Lookup';
      case 'picklist':
      case 'state':
      case 'status':
        return 'OptionSet';
      case 'memo':
        return 'Memo';
      default:
        return 'Text';
    }
  }

  /**
   * Extract product-compatible columns from a product detail view for hybrid queries
   * 
   * Analyzes view metadata to identify columns that originate from the product
   * entity, which can be used in hybrid queries that query products but display
   * detail entity columns.
   * 
   * @param viewMetadata - Detail entity view metadata
   * @param configuredColumns - Columns configured in config.json (priority columns)
   * @returns Array of product column logical names
   */
  /**
   * PUBLIC API: Extract product columns from detail view metadata for hybrid queries
   */
  public extractProductColumnsFromDetailView(viewMetadata: ViewMetadata | null | undefined, configuredColumns: string[] = []): string[] {
    const normalizedMap = new Map<string, string>();

    const addColumn = (columnName?: string): void => {
      if (!columnName) {
        return;
      }

      const trimmed = columnName.trim();
      if (!trimmed) {
        return;
      }

      const aliasNormalized = trimmed.toLowerCase();
      const resolved = aliasNormalized.startsWith('product.')
        ? trimmed.slice(trimmed.indexOf('.') + 1).trim()
        : trimmed;

      if (!resolved) {
        return;
      }

      const normalized = resolved.toLowerCase();
      if (!normalizedMap.has(normalized)) {
        normalizedMap.set(normalized, resolved);
      }
    };

    // Always include productid as essential identifier
    addColumn('productid');
    
    // Include priority columns from config (name, crcad_productcode_ex, etc.)
    // These are configured in config.json under product.priorityColumns
    configuredColumns.forEach(addColumn);

    // Derive additional columns from view metadata when available
    viewMetadata?.columns.forEach(column => {
      const sourceEntity = column.sourceEntity?.toLowerCase();

      if (sourceEntity === 'product') {
        addColumn(column.sourceAttribute ?? column.logicalName);
        return;
      }

      const originalLogicalName = column.originalLogicalName ?? column.logicalName;
      if (originalLogicalName.includes('.')) {
        const [alias, attribute] = originalLogicalName.split('.');
        if (alias.toLowerCase() === 'product') {
          addColumn(attribute);
        }
      }
    });

    return Array.from(normalizedMap.values());
  }
}
