/**
 * MetadataService
 * 
 * Responsibility: Entity, attribute, and OptionSet metadata retrieval
 * 
 * Handles all Dataverse metadata operations including:
 * - Entity metadata retrieval and caching
 * - Attribute metadata discovery
 * - OptionSet (picklist) metadata and option resolution
 * - Display name localization
 * - Entity set name resolution
 */

import { EntityMetadata, AttributeMetadata, OptionSetMetadata, OptionSetOption } from '../types';
import { CacheService } from './CacheService';
import { LoggerService } from './LoggerService';

/**
 * Internal interface for raw localized label from Dataverse API
 */
interface RawLocalizedLabel {
  Label: string;
  LanguageCode?: number;
}

/**
 * Internal interface for raw display name from Dataverse API
 */
interface RawDisplayName {
  UserLocalizedLabel?: RawLocalizedLabel;
  LocalizedLabels?: RawLocalizedLabel[];
}

/**
 * Internal interface for raw attribute metadata from Dataverse API
 */
interface RawAttributeMetadata {
  LogicalName?: string;
  DisplayName?: RawDisplayName;
  AttributeType?: string;
  AttributeTypeName?: {
    Value?: string;
  };
  IsPrimaryId?: boolean;
  IsValidForRead?: boolean;
  IsValidForCreate?: boolean;
  IsValidForUpdate?: boolean;
  RequiredLevel?: {
    Value?: string;
  };
}

/**
 * Internal interface for attribute collection from entity metadata
 */
interface AttributeCollectionLike {
  get?(logicalName: string): RawAttributeMetadata | undefined;
  forEach?(callback: (attribute: RawAttributeMetadata, logicalName: string) => void): void;
  [key: string]: unknown;
}

/**
 * Internal interface for raw entity metadata from Dataverse API
 */
interface RawEntityMetadata {
  LogicalName?: string;
  DisplayName?: RawDisplayName;
  EntitySetName?: string;
  PrimaryIdAttribute?: string;
  Attributes?: AttributeCollectionLike;
}

/**
 * Interface for PCF context with page property for server URL
 */
interface PCFContextWithPage {
  page?: {
    getClientUrl?: () => string;
  };
}

/**
 * Interface for raw OptionSet option from API response
 */
interface RawOptionSetOption {
  Value: number;
  Label?: {
    UserLocalizedLabel?: RawLocalizedLabel;
    LocalizedLabels?: RawLocalizedLabel[];
  };
  Description?: {
    UserLocalizedLabel?: RawLocalizedLabel;
  };
}

/**
 * Interface for raw OptionSet data from API response
 */
interface RawOptionSetData {
  Options?: RawOptionSetOption[];
}

/**
 * Interface for OptionSet metadata API response
 */
interface RawOptionSetMetadataResponse {
  OptionSet?: RawOptionSetData;
  GlobalOptionSet?: RawOptionSetData;
  DefaultFormValue?: number; // Default value for the OptionSet field
}

/**
 * MetadataService - Handles all Dataverse metadata operations
 */
export class MetadataService {
  private context: ComponentFramework.Context<unknown>;

  constructor(context: ComponentFramework.Context<unknown>) {
    this.context = context;
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Get entity metadata for attribute information using PCF Context Utils
   * @param entityName - Entity logical name
   * @returns EntityMetadata or null if not found
   */
  public async getEntityMetadata(entityName: string): Promise<EntityMetadata | null> {
    const cacheKey = entityName.toLowerCase();
    
    // Check cache first
    const cached = CacheService.getEntityMetadata(cacheKey);
    if (cached) {
      return cached;
    }

    if (!this.context.utils?.getEntityMetadata) {
      LoggerService.error(`getEntityMetadata('${entityName}'): PCF Context Utils not available`);
      return null;
    }

    try {
      const metadata = await this.context.utils.getEntityMetadata(entityName) as RawEntityMetadata;
      const transformed = this.transformEntityMetadata(entityName, metadata);
      CacheService.setEntityMetadata(cacheKey, transformed);
      return transformed;
    } catch (error) {
      LoggerService.error(`getEntityMetadata('${entityName}'): Failed to retrieve metadata`, error);
      return null;
    }
  }

  /**
   * Get individual attribute metadata using entity metadata cache
   * Public API for components that need attribute metadata (e.g., building column configs)
   * @param entityName - Entity logical name
   * @param attributeName - Attribute logical name
   * @returns AttributeMetadata or null if not found
   */
  public async getAttributeMetadata(entityName: string, attributeName: string): Promise<AttributeMetadata | null> {
    try {
      const cached = this.getCachedAttributeMetadata(entityName, attributeName);
      if (cached) {
        return cached;
      }

      const entityMetadata = await this.getEntityMetadata(entityName);
      if (!entityMetadata) {
        return null;
      }

      const normalizedAttribute = attributeName.toLowerCase();
      const matchingAttribute = entityMetadata.attributes.find(
        attribute => attribute.logicalName.toLowerCase() === normalizedAttribute
      );

      if (matchingAttribute) {
        this.storeAttributeMetadata(entityMetadata.logicalName, matchingAttribute.logicalName, matchingAttribute);
        return matchingAttribute;
      }
      
      // Try to retrieve attribute metadata directly from Web API for custom fields
      try {
        const directMetadata = await this.getAttributeMetadataFromWebAPI(entityName, attributeName);
        if (directMetadata) {
          this.storeAttributeMetadata(entityName, attributeName, directMetadata);
          return directMetadata;
        }
      } catch (_directError) {
        // Fall through to return null
      }
      
      return null;
    } catch (error) {
      LoggerService.error(`Failed to get attribute metadata for ${entityName}.${attributeName}`, error);
      return null;
    }
  }

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
    // Check cache first
    const cached = CacheService.getOptionSetMetadata(entityName, attributeName);
    if (cached) {
      return cached;
    }
    
    const logKey = `${entityName}.${attributeName}`;

    try {
      // Get attribute metadata which includes OptionSet details
      const attributeMetadata = await this.getAttributeMetadata(entityName, attributeName);
      
      if (!attributeMetadata) {
        return null;
      }

      // Check if it's actually an OptionSet type
      const attrType = attributeMetadata.attributeType.toLowerCase();
      if (!['picklist', 'state', 'status'].includes(attrType)) {
        return null;
      }

      // Fetch the OptionSet definition via WebAPI - include DefaultFormValue
      const contextWithPage = this.context as unknown as PCFContextWithPage;
      const serverUrl = contextWithPage.page?.getClientUrl?.() ?? '';
      const metadataQuery = `/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName,DefaultFormValue&$expand=OptionSet($select=Options),GlobalOptionSet($select=Options)`;
      
      const response = await fetch(serverUrl + metadataQuery, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0'
        }
      });

      if (!response.ok) {
        return null;
      }

      const rawData = await response.json() as RawOptionSetMetadataResponse;
      
      // Parse options from either local OptionSet or GlobalOptionSet
      const optionSet = rawData.OptionSet ?? rawData.GlobalOptionSet;
      if (!optionSet?.Options) {
        return null;
      }

      const options: OptionSetOption[] = optionSet.Options.map((opt: RawOptionSetOption) => ({
        value: opt.Value,
        label: opt.Label?.UserLocalizedLabel?.Label ?? opt.Label?.LocalizedLabels?.[0]?.Label ?? `Option ${opt.Value}`,
        description: opt.Description?.UserLocalizedLabel?.Label
      }));
      
      // Store in cache - include displayName from attribute metadata and default value
      // DefaultFormValue of -1 means "no default" in Dataverse
      const defaultValue = rawData.DefaultFormValue !== undefined && rawData.DefaultFormValue !== -1 
        ? rawData.DefaultFormValue 
        : undefined;
      
      const metadata: OptionSetMetadata = {
        entityName,
        attributeName,
        displayName: attributeMetadata.displayName,
        options,
        isGlobal: !!rawData.GlobalOptionSet,
        defaultValue
      };
      
      CacheService.setOptionSetMetadata(entityName, attributeName, metadata);
      
      return metadata;
    } catch (error) {
      LoggerService.error(`Failed to fetch OptionSet metadata for ${logKey}:`, error);
      return null;
    }
  }

  /**
   * Get entity set name for an entity from metadata
   * Note: For detail entities, use detailEntitySet from config instead of calling this method
   * @param entityName - Entity logical name
   * @returns Entity set name or null if not found
   */
  public async getEntitySetName(entityName: string): Promise<string | null> {
    // Get from entity metadata (no hardcoded fallbacks)
    const metadata = await this.getEntityMetadata(entityName);
    return metadata?.entitySetName ?? null;
  }

  /**
   * Format an OptionSet raw numeric value to its label
   * @param rawValue - Raw numeric value from Dataverse
   * @param metadata - OptionSet metadata
   * @returns Formatted label string
   */
  public formatOptionSetValue(rawValue: number | string | null | undefined, metadata: OptionSetMetadata | null): string {
    if (rawValue === null || rawValue === undefined) {
      return '';
    }

    if (!metadata || metadata.options.length === 0) {
      // Fallback to displaying the raw value
      return String(rawValue);
    }

    const numericValue = typeof rawValue === 'string' ? parseInt(rawValue, 10) : rawValue;
    const option = metadata.options.find(opt => opt.value === numericValue);
    
    return option ? option.label : String(rawValue);
  }

  /**
   * Determine the correct entity name for a related field
   * @param logicalName - Field logical name (may include link-entity alias like "productid.name")
   * @param baseEntityName - Base entity name as fallback
   * @returns Entity name for the field
   */
  public getEntityForRelatedField(logicalName: string, baseEntityName: string): string {
    if (!logicalName.includes('.')) {
      return baseEntityName; // Not a related field
    }

    const parts = logicalName.split('.');
    const linkAlias = parts[0];
    
    // Map common aliases to their entity names
    const aliasToEntityMap: Record<string, string> = {
      // Only include aliases verified in current view metadata usage
      'productid': 'product',
      'product': 'product',
      'transactioncurrencyid': 'transactioncurrency'
    };

    // Check if the alias is a known entity relationship
    const targetEntity = aliasToEntityMap[linkAlias];
    if (targetEntity) {
      return targetEntity;
    }

    // If we can't determine the entity, try to guess based on common patterns
    if (linkAlias.endsWith('id')) {
      const entityName = linkAlias.slice(0, -2); // Remove 'id' suffix
      return entityName;
    }

    // Fallback to the base entity
    return baseEntityName;
  }

  // =============================================================================
  // PRIVATE HELPERS
  // =============================================================================

  /**
   * Transform raw entity metadata from Dataverse API to our typed format
   */
  private transformEntityMetadata(entityName: string, rawEntity: RawEntityMetadata): EntityMetadata {
    const logicalName = rawEntity.LogicalName ?? entityName;
    const displayName = this.resolveDisplayName(rawEntity.DisplayName, logicalName);
    const entitySetName = rawEntity.EntitySetName ?? `${logicalName}s`;
    const primaryIdAttribute = rawEntity.PrimaryIdAttribute ?? `${logicalName}id`;
    const attributes: AttributeMetadata[] = [];

    this.forEachAttribute(rawEntity.Attributes, (attribute, attributeKey) => {
      const logicalAttributeName = attribute.LogicalName ?? attributeKey;
      if (!logicalAttributeName) {
        return;
      }

      const converted = this.convertRawAttributeMetadata(logicalName, logicalAttributeName, attribute);
      attributes.push(converted);
      this.storeAttributeMetadata(logicalName, logicalAttributeName, converted);
    });

    return {
      logicalName,
      displayName,
      entitySetName,
      primaryIdAttribute,
      attributes
    };
  }

  /**
   * Resolve display name from raw Dataverse format with language fallback
   */
  private resolveDisplayName(displayName?: RawDisplayName, fallback = ''): string {
    if (!displayName) {
      return fallback;
    }

    const userLabel = displayName.UserLocalizedLabel?.Label?.trim();
    if (userLabel) {
      return userLabel;
    }

    const labels = displayName.LocalizedLabels ?? [];
    const englishLabel = labels.find(label => label.LanguageCode === 1033)?.Label?.trim();
    if (englishLabel) {
      return englishLabel;
    }

    const turkishLabel = labels.find(label => label.LanguageCode === 1055)?.Label?.trim();
    if (turkishLabel) {
      return turkishLabel;
    }

    const firstLabel = labels.find(label => label.Label?.trim())?.Label?.trim();
    if (firstLabel) {
      return firstLabel;
    }

    return fallback;
  }

  /**
   * Iterate through attribute collection with support for multiple formats
   */
  private forEachAttribute(
    collection: AttributeCollectionLike | undefined,
    callback: (attribute: RawAttributeMetadata, attributeKey: string) => void
  ): void {
    if (!collection) {
      return;
    }

    if (Array.isArray(collection)) {
      collection.forEach(attribute => {
        const logicalName = attribute.LogicalName ?? '';
        if (logicalName) {
          callback(attribute, logicalName);
        }
      });
      return;
    }

    if (typeof collection.forEach === 'function') {
      collection.forEach((attribute: RawAttributeMetadata, logicalName: string) => {
        callback(attribute, logicalName);
      });
      return;
    }

    Object.keys(collection).forEach(key => {
      const candidate = collection[key];
      if (candidate && typeof candidate === 'object') {
        callback(candidate as RawAttributeMetadata, key);
      }
    });
  }

  /**
   * Convert raw attribute metadata from Dataverse API to our typed format
   */
  private convertRawAttributeMetadata(
    entityLogicalName: string,
    attributeLogicalName: string,
    attribute: RawAttributeMetadata
  ): AttributeMetadata {
    const displayName = this.resolveDisplayName(attribute.DisplayName, attributeLogicalName);
    const attributeType = attribute.AttributeType ?? attribute.AttributeTypeName?.Value ?? 'String';

    return {
      logicalName: attributeLogicalName,
      displayName,
      attributeType,
      isPrimaryKey: attribute.IsPrimaryId ?? false,
      isValidForRead: attribute.IsValidForRead ?? true,
      isValidForCreate: attribute.IsValidForCreate ?? true,
      isValidForUpdate: attribute.IsValidForUpdate ?? true,
      isRequired: attribute.RequiredLevel?.Value === 'ApplicationRequired' || attribute.RequiredLevel?.Value === 'SystemRequired'
    };
  }

  /**
   * Store attribute metadata in cache
   */
  private storeAttributeMetadata(entityLogicalName: string, attributeLogicalName: string, metadata: AttributeMetadata): void {
    CacheService.setAttributeMetadata(entityLogicalName.toLowerCase(), attributeLogicalName.toLowerCase(), metadata);
  }

  /**
   * Get cached attribute metadata
   */
  private getCachedAttributeMetadata(entityLogicalName: string, attributeLogicalName: string): AttributeMetadata | null {
    return CacheService.getAttributeMetadata(entityLogicalName.toLowerCase(), attributeLogicalName.toLowerCase());
  }

  /**
   * Extract a specific attribute from raw attribute collection
   */
  private extractRawAttribute(
    attributes: AttributeCollectionLike | undefined,
    attributeLogicalName: string
  ): RawAttributeMetadata | undefined {
    if (!attributes) {
      return undefined;
    }

    const targetKey = attributeLogicalName.toLowerCase();
    let match: RawAttributeMetadata | undefined;

    this.forEachAttribute(attributes, (attribute, key) => {
      const logical = attribute.LogicalName ?? key;
      if (logical?.toLowerCase() === targetKey) {
        match = attribute;
      }
    });

    return match;
  }

  /**
   * Get attribute metadata directly from Web API for custom fields not available via PCF context
   */
  private async getAttributeMetadataFromWebAPI(entityName: string, attributeName: string): Promise<AttributeMetadata | null> {
    try {
      // Use the EntityDefinitions endpoint which is the correct OData endpoint for metadata
      const contextWithPage = this.context as unknown as PCFContextWithPage;
      const serverUrl = contextWithPage.page?.getClientUrl?.() ?? '';
      const metadataQuery = `/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')/Attributes(LogicalName='${attributeName}')?$select=LogicalName,DisplayName,Description,AttributeType,AttributeTypeName,IsPrimaryId,IsValidForRead,IsValidForCreate,IsValidForUpdate,RequiredLevel`;
      
      const response = await fetch(serverUrl + metadataQuery, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json; charset=utf-8',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0'
        }
      });

      if (!response.ok) {
        return null;
      }

      const rawAttribute = await response.json() as RawAttributeMetadata;
      
      if (!rawAttribute?.LogicalName) {
        return null;
      }

      const displayName = this.resolveDisplayName(rawAttribute.DisplayName, attributeName);
      
      
      return {
        logicalName: attributeName,
        displayName,
        attributeType: rawAttribute.AttributeType ?? rawAttribute.AttributeTypeName?.Value ?? 'String',
        isPrimaryKey: rawAttribute.IsPrimaryId ?? false,
        isValidForRead: rawAttribute.IsValidForRead !== false,
        isValidForCreate: rawAttribute.IsValidForCreate !== false,
        isValidForUpdate: rawAttribute.IsValidForUpdate !== false,
        isRequired: rawAttribute.RequiredLevel?.Value === 'ApplicationRequired' || rawAttribute.RequiredLevel?.Value === 'SystemRequired'
      };
    } catch (error) {
      LoggerService.error(`Failed to retrieve attribute metadata from Web API for ${entityName}.${attributeName}:`, error);
      return null;
    }
  }
}
