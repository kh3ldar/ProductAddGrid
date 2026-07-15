/**
 * ProductQueryService
 * 
 * Handles all product search and query operations, including:
 * - Virtual table row creation with staging fields
 * - Product search with FetchXML (hybrid approach for detail views)
 * - Stock availability queries
 * - Product field enhancement for detail views
 * 
 * This service implements the hybrid view pattern for product detail views:
 * - Queries product entity for listing
 * - Uses column definitions from detail entity view
 * - Enhances products with placeholder fields from view metadata
 */

import { 
  Product, 
  ProductSearchResult, 
  PagingInfo, 
  ViewMetadata, 
  VirtualTableRow, 
  ProductFilterCondition,
  ODataResponse,
  SearchMatchType
} from '../types';
import { LoggerService } from './LoggerService';
import { MetadataService } from './MetadataService';
import { ColumnService } from './ColumnService';
import { ConfigService } from './ConfigService';
import { 
  addSearchFilterToFetchXML,
  setPageSizeInFetchXML,
  addProductFilterToFetchXML,
  createProductFetchXMLWithColumns
} from './FetchXmlUtils';

export class ProductQueryService {
  private webApi: ComponentFramework.WebApi;
  private metadataService: MetadataService;
  private columnService: ColumnService;
  private configService: ConfigService;

  constructor(
    context: ComponentFramework.Context<unknown>,
    metadataService: MetadataService,
    columnService: ColumnService,
    configService: ConfigService
  ) {
    this.webApi = context.webAPI;
    this.metadataService = metadataService;
    this.columnService = columnService;
    this.configService = configService;
  }

  // ============================================================================
  // PUBLIC API - Product Query Operations
  // ============================================================================

  /**
   * Create virtual table rows from products by merging with view metadata staging fields
   * Virtual rows include both product data and empty staging fields from view metadata
   * @param products - Products to convert to virtual rows
   * @param viewMetadata - View metadata with column definitions
   * @param productColumns - Array of product field names that should not be overwritten (from config)
   */
  createVirtualTableRows(products: Product[], viewMetadata: ViewMetadata, productColumns: string[] = ['productid', 'name']): VirtualTableRow[] {
    const productColumnSet = new Set(productColumns.map(c => c.toLowerCase()));
    
    return products.map(product => {
      const virtualRow: VirtualTableRow = {
        // Copy all product fields
        ...product,
        _isVirtual: true,
        _modifiedFields: []
      };

      // Add empty staging fields from view metadata
      if (viewMetadata?.columns) {
        viewMetadata.columns.forEach(column => {
          const fieldName = column.logicalName.toLowerCase();
          
          // Skip fields that already have values from the product (don't overwrite)
          // This preserves product fields like emd_centralwarehousestock
          if (virtualRow[fieldName] !== undefined && virtualRow[fieldName] !== null) {
            return;
          }
          
          // Only add staging fields (not core product fields from config)
          if (!productColumnSet.has(fieldName)) {
            // Initialize with appropriate default value based on type
            switch (column.attributeType.toLowerCase()) {
              case 'decimal':
              case 'money':
              case 'integer':
                virtualRow[fieldName] = 0;
                break;
              case 'string':
              case 'memo':
                virtualRow[fieldName] = '';
                break;
              default:
                virtualRow[fieldName] = undefined;
            }
          }
        });
      }

    return virtualRow;
    });
  }

  /**
   * Search for virtual table rows (products enhanced with staging fields from view metadata)
   */
  async searchVirtualTableRows(
    searchQuery = '',
    pageSize = 50,
    pageNumber = 1,
    viewMetadata?: ViewMetadata | null,
    isProductDetailView = false,
    configuredProductColumns: string[] = [],
    filterConditions: ProductFilterCondition[] = [],
    searchFields: string[] = ['name', 'productnumber'],
    matchType: SearchMatchType = 'startsWith'
  ): Promise<{ virtualRows: VirtualTableRow[]; paging: PagingInfo }> {
    // First get regular products
    const productResult = await this.searchProductsWithFetchXML(
      searchQuery,
      pageSize,
      pageNumber,
      viewMetadata,
      isProductDetailView,
      configuredProductColumns,
      filterConditions,
      searchFields,
      matchType
    );

    // Convert products to virtual table rows, passing product columns to preserve
    const virtualRows = viewMetadata 
      ? this.createVirtualTableRows(productResult.products, viewMetadata, configuredProductColumns)
      : productResult.products.map(p => ({ ...p, _isVirtual: true as const, _modifiedFields: [] }));

    return {
      virtualRows,
      paging: productResult.paging
    };
  }

  /**
   * Search for products using FetchXML from view metadata to properly support aliases and view configuration
   * This method implements a hybrid approach for product detail views:
   * - Always queries the 'product' entity for listing
   * - For product detail views, gets column definitions from detail view but queries products
   * - Combines basic product fields with additional fields from detail view metadata
   * 
   * Note: Dataverse Web API has a 16KB URL length limit. For very complex FetchXML queries,
   * consider using POST with batch or FetchXML in request body if URL length is exceeded.
   */
  async searchProductsWithFetchXML(
    searchQuery = '',
    pageSize = 50,
    pageNumber = 1,
    viewMetadata?: ViewMetadata | null,
    isProductDetailView = false,
    configuredProductColumns: string[] = [],
    filterConditions: ProductFilterCondition[] = [],
    searchFields: string[] = ['name', 'productnumber'],
    matchType: SearchMatchType = 'startsWith'
  ): Promise<ProductSearchResult> {
    try {
      let fetchXml = '';
      const targetEntity = 'product'; // Always query products for listing
      
      if (!viewMetadata?.fetchXml) {
        throw new Error('View metadata with FetchXML is required for product search');
      }
      
      if (isProductDetailView && viewMetadata) {
        // For product detail views, query products with basic fields and enhance results with detail columns
        // Use basic product fields for the query - only what's needed for product reference
        const productColumns = this.columnService.extractProductColumnsFromDetailView(viewMetadata, configuredProductColumns);
        
        // Get default product sort configuration (e.g., by usage rank descending, then name ascending)
        // Only apply for initial load/filters, NOT for search results
        const sortConfig = searchQuery.trim() ? [] : this.configService.getDefaultProductSort();
        
        fetchXml = createProductFetchXMLWithColumns(searchQuery, pageSize, pageNumber, productColumns, filterConditions, searchFields, sortConfig, 'product', matchType);

      } else {
        // Direct product view, use as-is
        fetchXml = viewMetadata.fetchXml;
        
        // Add search filters if needed
        if (searchQuery.trim()) {
          fetchXml = addSearchFilterToFetchXML(fetchXml, searchQuery, searchFields, matchType);
        }
        
        // Add product filter conditions
        if (filterConditions.length > 0) {
          fetchXml = addProductFilterToFetchXML(fetchXml, filterConditions);
        }
        
        // Set page size
        fetchXml = setPageSizeInFetchXML(fetchXml, pageSize);
      }

      // Execute FetchXML query against products
      // Note: Using encodeURIComponent to properly encode FetchXML for URL transmission
      // Dataverse Web API enforces URL length limit of ~16KB - complex queries may need alternative approach
      const encodedFetchXml = encodeURIComponent(fetchXml);
      const queryString = `?fetchXml=${encodedFetchXml}`;
      
      // Optional: Log warning if query string is approaching URL length limits (>15000 chars)
      if (queryString.length > 15000) {
        LoggerService.warn(`Product query string is approaching the Dataverse URL length limit: ${queryString.length} chars`);
      }
      
      const response = await this.webApi.retrieveMultipleRecords(targetEntity, queryString);
      
      // Process results
      const products: Product[] = response.entities.map(entity => {
        // Try multiple name fields as fallback
        let productName = String(entity.name ?? '').trim();
        if (!productName) {
          productName = String(entity.productnumber ?? '').trim();
        }
        if (!productName) {
          productName = 'Unnamed Product';
        }

        const product: Product = {
          productid: String(entity.productid ?? ''),
          name: productName
          // Note: Product code field is dynamically populated from query results
          // The field name is config-driven (product.codeField in config.json)
        };

        // Add any additional fields from the query
        // For OptionSet/Lookup fields, prefer formatted values over raw numeric values
        // For numeric fields (Decimal, Integer, Money), always keep the raw value
        Object.keys(entity).forEach(key => {
          // Skip OData annotations (they start with @)
          if (key.startsWith('@')) {
            return;
          }
          
          if (!(key in product) && entity[key] !== null && entity[key] !== undefined) {
            const rawValue = entity[key] as string | number | boolean | Date;
            
            // If the raw value is a number, always use it directly
            // This prevents locale-formatted strings like "2,556" from breaking Number() parsing
            if (typeof rawValue === 'number') {
              product[key] = rawValue;
              return;
            }
            
            // For non-numeric values, check for formatted value annotation (for OptionSets, Lookups, etc.)
            const formattedValueKey = `${key}@OData.Community.Display.V1.FormattedValue`;
            const formattedValue = entity[formattedValueKey] as string | number | boolean | Date | undefined;
            
            // Use formatted value if available (this gives us text labels for choice fields)
            // Otherwise use the raw value
            if (formattedValue !== undefined && formattedValue !== null) {
              product[key] = formattedValue;
            } else {
              product[key] = rawValue;
            }
          }
        });

        // If this is a product detail view, enhance the product with placeholder fields from the view metadata
        if (isProductDetailView && viewMetadata) {
          this.enhanceProductWithDetailViewFields(product, viewMetadata);
        }

        return product;
      });

      // Paging detection: We fetch pageSize+1 records to detect if more exist
      // If we get more than pageSize records, there's a next page
      const hasMoreRecords = response.entities.length > pageSize;
      
      // Check for @odata.nextLink as additional signal for server-side paging
      const nextLinkUrl = (response as unknown as ODataResponse)['@odata.nextLink'];
      const hasServerSidePaging = !!nextLinkUrl;
      
      // Trim products to pageSize (we fetched pageSize+1 for detection)
      if (products.length > pageSize) {
        products.length = pageSize;
      }
      
      const pagingInfo: PagingInfo = {
        currentPage: pageNumber,
        pageSize,
        totalRecords: products.length, // Records on current page (not total in DB)
        totalPages: hasMoreRecords || hasServerSidePaging ? pageNumber + 1 : pageNumber, // Estimate based on current page
        hasNextPage: hasMoreRecords || hasServerSidePaging,
        hasPreviousPage: pageNumber > 1
      };

      return {
        products,
        paging: pagingInfo
      };

    } catch (error) {
      LoggerService.error('Error searching products with FetchXML:', error);
      throw new Error(`Failed to search products: ${String(error)}`);
    }
  }

  /**
   * Get current available stock for multiple products
   * Returns a map of product IDs to stock quantities
   */
  async getProductsAvailableStock(productIds: string[]): Promise<Map<string, number>> {
    const stockMap = new Map<string, number>();
    
    if (productIds.length === 0) {
      return stockMap;
    }

    try {
      // Build filter for multiple product IDs
      const idFilters = productIds.map(id => `productid eq ${id}`).join(' or ');
      const availableStockField = this.configService.getAvailableStockField();
      const queryString = `?$select=productid,${availableStockField}&$filter=(${idFilters})`;
      
      const response = await this.webApi.retrieveMultipleRecords('product', queryString);
      
      response.entities.forEach(entity => {
        const productId = String(entity.productid ?? '');
        const availableStock = Number(entity[availableStockField] ?? 0);
        stockMap.set(productId, availableStock);
      });
      
      return stockMap;
    } catch (error) {
      LoggerService.error('Error fetching product stock:', error);
      return stockMap;
    }
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  /**
   * Enhance a product record with placeholder fields from detail view metadata
   */
  private enhanceProductWithDetailViewFields(product: Product, viewMetadata: ViewMetadata): void {
    // Add placeholder fields for detail entity columns that don't exist on product
    viewMetadata.columns.forEach(column => {
      const fieldName = column.logicalName;
      
      // Skip if the field already exists on the product
      if (fieldName in product) {
        return;
      }
      
      // Add placeholder value based on the column type
      switch (column.attributeType?.toLowerCase()) {
        case 'money':
        case 'decimal':
        case 'double':
        case 'integer':
          product[fieldName] = 0;
          break;
        case 'boolean':
          product[fieldName] = false;
          break;
        case 'datetime':
          product[fieldName] = undefined;
          break;
        default:
          product[fieldName] = '';
          break;
      }
    });
  }
}
