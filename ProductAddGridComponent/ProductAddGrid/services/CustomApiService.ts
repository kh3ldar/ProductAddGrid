/**
 * CustomApiService
 * 
 * Handles Custom API execution for the ProductAddGrid control.
 * 
 * Responsibilities:
 * - Executing product request custom API actions
 * - Checking for existing product request records (acquisition/pricing)
 * - Fetching records with OData filters
 * - Managing cross-entity request detection (quote/opportunity)
 * - Comparing staged items against existing product details
 * 
 * Architecture:
 * - Injected dependencies: Context
 * - Uses config-driven approach for entity mappings
 * - Supports both catalog and write-in product requests
 * - Handles direct parent match and cross-entity customer match
 */

import { 
  ProductRequestRow, 
  ExistingRequestCheckResult, 
  ExistingRequestInfo, 
  ProductRequestApiPayload 
} from '../types';
import { ConfigService } from './ConfigService';
import { LoggerService } from './LoggerService';

export class CustomApiService {
  private context: ComponentFramework.Context<unknown>;
  private webApi: ComponentFramework.WebApi;

  constructor(context: ComponentFramework.Context<unknown>) {
    this.context = context;
    this.webApi = context.webAPI;
  }

  // =============================================================================
  // PUBLIC API - Product Request Operations
  // =============================================================================

  /**
   * Check for existing acquisition/pricing record before calling Custom API
   * Implements the full check logic from examplePriceRequest.js
   * 
   * @param parentId - Parent record ID (quote or opportunity)
   * @param requestType - 0 for Price, 1 for Acquisition
   * @param parentEntityType - 'quote' or 'opportunity'
   * @param customerId - Customer ID for cross-entity check
   * @param items - Items to compare against existing
   * @param configService - ConfigService for accessing config
   * @returns ExistingRequestCheckResult with existing info and items to process
   */
  async checkExistingProductRequest(
    parentId: string,
    requestType: number,
    parentEntityType: string,
    customerId: string,
    items: ProductRequestRow[],
    configService: ConfigService
  ): Promise<ExistingRequestCheckResult> {
    const defaults = configService.getProductRequestDefaults();
    if (!defaults) {
      // No config - treat as no existing request
      return {
        hasExisting: false,
        itemsToProcess: items,
        allExist: false
      };
    }

    const { existingRequestEntity, productDetailEntity } = defaults.customApi;
    const sourceConfig = configService.getSourceTypeConfig(parentEntityType);
    if (!sourceConfig) {
      return { hasExisting: false, itemsToProcess: items, allExist: false };
    }


    // Step 1: Query for direct parent match
    const directFilter = `${sourceConfig.filterField} eq '${parentId}' and emd_type eq ${requestType} and statecode eq 0`;
    let existingRecords = await this.fetchRecordsWithFilter(
      existingRequestEntity,
      directFilter,
      'emd_acquisitionandpricingid'
    );

    // Step 2: If no direct match, check cross-entity (same customer)
    if (existingRecords.length === 0 && customerId) {
      const crossFilter = `_emd_account_value eq '${customerId}' and emd_type eq ${requestType} and statecode eq 0`;
      const allRecords = await this.fetchRecordsWithFilter(
        existingRequestEntity,
        crossFilter,
        'emd_acquisitionandpricingid,_emd_quote_value,_emd_opportunity_value'
      );
      
      // Filter for opposite entity type
      if (parentEntityType === 'quote') {
        existingRecords = allRecords.filter(r => r._emd_opportunity_value && !r._emd_quote_value);
      } else {
        existingRecords = allRecords.filter(r => r._emd_quote_value && !r._emd_opportunity_value);
      }
    }

    // No existing request found
    if (existingRecords.length === 0) {
      return { hasExisting: false, itemsToProcess: items, allExist: false };
    }

    const existingRecord = existingRecords[0];
    const existingRecordId = String(existingRecord.emd_acquisitionandpricingid);


    // Step 3: Get existing product details
    const detailsFilter = `_emd_acquisitionandpricing_value eq '${existingRecordId}'`;
    const details = await this.fetchRecordsWithFilter(
      productDetailEntity,
      detailsFilter,
      '_emd_product_value,emd_quantity,emd_existingproduct'
    );

    // Build maps of existing products
    const existingProducts = new Map<string, number>();
    const existingWriteInProducts = new Map<string, number>();
    
    details.forEach(detail => {
      if (detail._emd_product_value) {
        existingProducts.set(String(detail._emd_product_value), Number(detail.emd_quantity));
      } else if (detail.emd_existingproduct) {
        existingWriteInProducts.set(String(detail.emd_existingproduct), Number(detail.emd_quantity));
      }
    });


    // Step 4: Compare staged items with existing - find new or changed items
    const itemsToProcess: ProductRequestRow[] = [];
    
    for (const item of items) {
      const currentQty = Math.floor(Number(item.quantity) || 0);
      let existingQty: number | undefined;
      
      if (item._productId) {
        // Catalog product - check by product ID
        existingQty = existingProducts.get(item._productId);
      } else {
        // Write-in product - check by product name
        // Extract string value from FieldValue object or use empty string
        const productName = this.extractStringValue(item.productdescription);
        existingQty = existingWriteInProducts.get(productName);
      }
      
      // Include if new or quantity changed
      if (existingQty === undefined || currentQty !== Math.floor(existingQty)) {
        itemsToProcess.push(item);
      }
    }


    const existingRequest: ExistingRequestInfo = {
      recordId: existingRecordId,
      products: existingProducts,
      writeInProducts: existingWriteInProducts
    };

    return {
      hasExisting: true,
      existingRequest,
      itemsToProcess,
      allExist: itemsToProcess.length === 0
    };
  }

  /**
   * Call the Product Request Custom API
   * Uses fetch API to call unbound custom action
   * 
   * @param payload - ProductRequestApiPayload with all required parameters
   * @param actionName - Name of the custom action to call
   * @returns Promise with success status and optional message
   */
  async callProductRequestCustomApi(
    payload: ProductRequestApiPayload,
    actionName: string
  ): Promise<{ success: boolean; message?: string }> {

    try {
      // Access Xrm.WebApi.online.execute through context
      // PCF context doesn't directly expose this, but it's available via the page object
      const contextWithXrm = this.context as unknown as { 
        page?: { 
          getClientUrl?: () => string;
        };
      };
      
      // Get client URL to construct API endpoint
      const clientUrl = contextWithXrm.page?.getClientUrl?.() ?? '';
      if (!clientUrl) {
        throw new Error('Unable to get client URL for Custom API call');
      }

      // Use fetch to call the custom action
      const apiUrl = `${clientUrl}/api/data/v9.2/${actionName}`;
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          type: payload.type,
          selectedItems: payload.selectedItems,
          isExisting: payload.isExisting,
          parentId: payload.parentId,
          recordNumber: payload.recordNumber,
          customerId: payload.customerId,
          productDetails: payload.productDetails,
          existingRecordId: payload.existingRecordId,
          recordType: payload.recordType
        })
      });

      if (response.ok) {
        const text = await response.text();
        if (text) {
          try {
            const result = JSON.parse(text) as { success: boolean; message?: string };
            return result;
          } catch {
            return { success: true };
          }
        }
        return { success: true };
      } else {
        const errorText = await response.text();
        LoggerService.error('Custom API call failed:', response.status, errorText);
        return { success: false, message: `API call failed: ${response.status}` };
      }
    } catch (error) {
      LoggerService.error('Error calling Custom API:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Call the emd_SyncReservationLines unbound custom API. Used after the ProductAddGrid PCF has
   * created N reservation lines to push them to Logo in ONE batched UpdateReservation.
   *
   * @param reservationId - Parent reservation (crcad_reservationrecord) GUID
   * @param lineIds - GUIDs of the just-created crcad_reservationproductdetail lines
   * @param mode - 'sync' to batch-push to Logo (compensates server-side on failure), or
   *               'compensate' to only delete the handed-in lines (PCF create loop aborted)
   * @returns success flag and optional message (the plugin's apiResponse / error text)
   */
  async syncReservationLines(
    reservationId: string,
    lineIds: string[],
    mode: 'sync' | 'compensate' = 'sync'
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const contextWithXrm = this.context as unknown as {
        page?: {
          getClientUrl?: () => string;
        };
      };

      const clientUrl = contextWithXrm.page?.getClientUrl?.() ?? '';
      if (!clientUrl) {
        throw new Error('Unable to get client URL for Custom API call');
      }

      const apiUrl = `${clientUrl}/api/data/v9.2/emd_SyncReservationLines`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          'Accept': 'application/json'
        },
        // Custom-API parameters are scalar — the line-ID list travels as one comma-joined string.
        body: JSON.stringify({
          reservationId,
          lineIds: lineIds.join(','),
          mode
        })
      });

      if (response.ok) {
        const text = await response.text();
        if (text) {
          try {
            const result = JSON.parse(text) as { success?: boolean; apiResponse?: string };
            return { success: result.success ?? true, message: result.apiResponse };
          } catch {
            return { success: true };
          }
        }
        return { success: true };
      }

      // Non-2xx: the dispatcher threw (e.g. Logo batch rejected → server-side compensation ran).
      // Surface the platform error message so the user sees the real (Turkish) reason.
      const errorText = await response.text();
      LoggerService.error('emd_SyncReservationLines failed:', response.status, errorText);
      let message = `API call failed: ${response.status}`;
      try {
        const parsed = JSON.parse(errorText) as { error?: { message?: string } };
        if (parsed.error?.message) {
          message = parsed.error.message;
        }
      } catch {
        // keep the status-based fallback message
      }
      return { success: false, message };
    } catch (error) {
      LoggerService.error('Error calling emd_SyncReservationLines:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  // =============================================================================
  // PRIVATE HELPERS
  // =============================================================================

  /**
   * Extract string value from FieldValue or string
   * Handles both direct strings and Dataverse FieldValue objects
   */
  private extractStringValue(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (value && typeof value === 'object' && 'value' in value) {
      const fieldValue = value as { value?: unknown };
      if (typeof fieldValue.value === 'string') {
        return fieldValue.value;
      }
    }
    return '';
  }

  /**
   * Fetch multiple records from Dataverse with filter and select
   * Generic helper for product request operations
   */
  private async fetchRecordsWithFilter(
    entityName: string,
    filter: string,
    select: string
  ): Promise<ComponentFramework.WebApi.Entity[]> {
    try {
      const result = await this.webApi.retrieveMultipleRecords(
        entityName,
        `?$filter=${filter}&$select=${select}`
      );
      return result.entities || [];
    } catch (error) {
      LoggerService.error(`Error fetching ${entityName}:`, error);
      return [];
    }
  }
}
