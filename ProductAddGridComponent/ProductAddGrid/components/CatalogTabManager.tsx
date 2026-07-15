import * as React from 'react';
import { BaseTabManager } from './BaseTabManager';
import {
  VirtualTableRow,
  StagedProduct,
  PagingInfo,
  MergedColumnConfig,
  FieldValue,
  ProductFilterOption,
  ProductFilterCondition,
  ViewMetadata,
  ViewConfig,
  SearchMatchType
} from '../types';
import { DataService, ConfigService, LocalizationService, LoggerService } from '../services';
import { ProductGrid } from './ProductGrid';
import { SearchBar } from './SearchBar';
import { Paging } from './Paging';
import { Stack, Icon } from '@fluentui/react';
import { FluentTokens } from '../theme/FluentTokens';

/**
 * Props for CatalogTabManager
 */
export interface ICatalogTabManagerProps {
  parentEntityName: string;
  parentRecordId: string;
  dataService: DataService;
  configService: ConfigService;
  localizationService: LocalizationService;

  // View configuration
  viewMetadata?: ViewMetadata;
  viewConfig: ViewConfig;
  mergedColumns: MergedColumnConfig[];
  isProductDetailView: boolean;

  // Currency
  currencyCode?: string;
  currencySymbol?: string;

  // From context
  stagedProductsById: Record<string, StagedProduct>;
  stagedProducts: StagedProduct[];
  onStageProduct: (
    product: VirtualTableRow,
    editedValues?: Record<string, FieldValue>,
    stagedId?: string,
    skipConditionalCheck?: boolean
  ) => void;
  onRemoveStaged: (stagedId: string) => void;

  // Toast notifications
  onShowToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void;

  // Initial load callback (for unified loading state)
  onInitialLoadComplete?: () => void;
}

/**
 * State for CatalogTabManager
 */
interface ICatalogTabManagerState {
  virtualRows: VirtualTableRow[];
  searchQuery: string;
  isLoading: boolean;
  paging: PagingInfo;
  selectedFilterKey?: string;
  selectedSubFilterKey?: string;
  filterOptions: ProductFilterOption[];
  showStagedOnly: boolean;
  catalogEditedValues: Record<string, Record<string, FieldValue>>;
  isInitialLoad: boolean; // Track if this is the first load
  searchMatchMode: SearchMatchType; // Active match mode; flips to 'contains' when begins-with yields nothing
}

/**
 * CatalogTabManager - Manages the catalog products tab
 * Handles product search, filtering, pagination, and staging
 */
export class CatalogTabManager extends BaseTabManager<
  ICatalogTabManagerProps,
  ICatalogTabManagerState
> {
  private searchDebounceTimer?: NodeJS.Timeout;
  // Monotonic load counter — each loadProducts call claims the next value, and
  // any response whose claim is no longer the latest is discarded (prevents a
  // slow/stale search from overwriting a newer one).
  private loadSeq = 0;

  constructor(props: ICatalogTabManagerProps) {
    super(props);

    const defaultFilterKey = this.props.configService.getDefaultProductFilterKey(
      this.props.parentEntityName
    );
    const filterOptions = this.props.configService.getProductFilterOptions(
      this.props.parentEntityName
    );

    const searchConfig =
      props.viewConfig.search ??
      props.configService.getSearchConfig() ?? {
        fields: ['name'],
        pageSize: 25
      };

    this.state = {
      virtualRows: [],
      searchQuery: '',
      isLoading: true,
      paging: {
        currentPage: 1,
        pageSize: searchConfig.pageSize,
        totalRecords: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      },
      selectedFilterKey: defaultFilterKey,
      selectedSubFilterKey: undefined,
      filterOptions,
      showStagedOnly: false,
      catalogEditedValues: {},
      isInitialLoad: true,
      searchMatchMode: 'startsWith'
    };
  }

  protected async onMount(): Promise<void> {
    await this.loadProducts();
  }

  protected onUnmount(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  componentDidUpdate(
    _prevProps: ICatalogTabManagerProps,
    prevState: ICatalogTabManagerState
  ): void {
    // Auto-reset staged view when last item removed
    if (
      prevState.showStagedOnly &&
      this.props.stagedProducts.length === 0 &&
      this.state.showStagedOnly
    ) {
      this.setState({ showStagedOnly: false });
    }
  }

  /**
   * Load products from Dataverse
   */
  private loadProducts = async (
    page = 1,
    searchQuery = this.state.searchQuery,
    matchTypeOverride?: SearchMatchType
  ): Promise<void> => {
    if (!this.isMounted) return;
    const requestSeq = ++this.loadSeq;
    this.setState({ isLoading: true });

    try {
      const { viewConfig, isProductDetailView, viewMetadata } = this.props;
      const searchConfig =
        viewConfig.search ??
        this.props.configService.getSearchConfig() ?? {
          fields: ['name'],
          pageSize: 25
        };
      const pageSize = searchConfig.pageSize;
      const productColumns = this.props.configService.getProductColumnsForEntity(
        this.props.parentEntityName
      );
      const searchFields = this.props.configService.getSearchFields();

      // Get current filter conditions (user-selected + hidden filter)
      const filterConditions = this.getCurrentFilterConditions();
      const hiddenFilter = this.props.configService.getHiddenFilter(
        this.props.parentEntityName
      );
      const hiddenConditions = hiddenFilter?.conditions ?? [];
      const allConditions = [...hiddenConditions, ...filterConditions];

      // Use virtual table search. Begins-with by default; fall back to contains
      // only when a fresh begins-with search for a non-empty term finds nothing.
      let matchMode: SearchMatchType = matchTypeOverride ?? 'startsWith';
      let result = await this.props.dataService.searchVirtualTableRows(
        searchQuery,
        pageSize,
        page,
        viewMetadata,
        isProductDetailView,
        productColumns,
        allConditions,
        searchFields,
        matchMode
      );

      // A newer load started while we awaited — drop this result and skip the
      // fallback query so the stale search can't overwrite the current one.
      if (!this.isMounted || requestSeq !== this.loadSeq) return;

      const shouldFallback =
        !matchTypeOverride &&
        matchMode === 'startsWith' &&
        searchQuery.trim().length > 0 &&
        result.virtualRows.length === 0;

      if (shouldFallback) {
        matchMode = 'contains';
        result = await this.props.dataService.searchVirtualTableRows(
          searchQuery,
          pageSize,
          page,
          viewMetadata,
          isProductDetailView,
          productColumns,
          allConditions,
          searchFields,
          matchMode
        );
      }

      if (!this.isMounted || requestSeq !== this.loadSeq) return;

      const isInitialLoad = this.state.isInitialLoad;

      this.setState({
        virtualRows: result.virtualRows,
        paging: result.paging,
        isLoading: false,
        isInitialLoad: false,
        searchMatchMode: matchMode
      });

      // Notify parent that initial load is complete (for unified loading state)
      if (isInitialLoad && this.props.onInitialLoadComplete) {
        this.props.onInitialLoadComplete();
      }
    } catch (error) {
      LoggerService.error('Error loading virtual table rows:', error);
      // Suppress stale errors so a superseded search can't toast over / interrupt
      // the current one.
      if (!this.isMounted || requestSeq !== this.loadSeq) return;
      
      const isInitialLoad = this.state.isInitialLoad;
      
      this.setState({ isLoading: false, isInitialLoad: false });
      this.props.onShowToast(
        'error',
        this.props.localizationService.getString('toast.savedError')
      );
      
      // Still notify parent even on error (don't block UI)
      if (isInitialLoad && this.props.onInitialLoadComplete) {
        this.props.onInitialLoadComplete();
      }
    }
  };

  /**
   * Get filter conditions based on currently selected filter
   */
  private getCurrentFilterConditions(): ProductFilterCondition[] {
    const { selectedFilterKey, selectedSubFilterKey } = this.state;
    if (!selectedFilterKey) {
      return [];
    }

    const filter = this.props.configService.getProductFilterByKey(
      this.props.parentEntityName,
      selectedFilterKey
    );
    const conditions = filter?.conditions ?? [];

    if (selectedSubFilterKey) {
      const subFilter = this.props.configService.getSubFilterByKey(
        this.props.parentEntityName,
        selectedFilterKey,
        selectedSubFilterKey
      );
      return [...conditions, ...(subFilter?.conditions ?? [])];
    }

    return conditions;
  }

  /**
   * Handle search input change (debounced with 3-character minimum)
   */
  private handleSearch = (query: string): void => {
    // Clear staging filter when user starts searching
    if (this.state.showStagedOnly) {
      this.setState({ searchQuery: query, showStagedOnly: false });
    } else {
      this.setState({ searchQuery: query });
    }

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    // Only trigger search if query is empty (to show all) or has 3+ characters
    if (query.length === 0 || query.length >= 3) {
      this.searchDebounceTimer = setTimeout(() => {
        void this.loadProducts(1, query);
      }, 400); // 400ms debounce for better UX
    }
  };

  /**
   * Handle filter change
   */
  private handleFilterChange = (filterKey: string): void => {
    this.setState({ selectedFilterKey: filterKey, selectedSubFilterKey: undefined }, () => {
      void this.loadProducts(1, this.state.searchQuery);
    });
  };

  private handleSubFilterChange = (subFilterKey: string | undefined): void => {
    this.setState({ selectedSubFilterKey: subFilterKey }, () => {
      void this.loadProducts(1, this.state.searchQuery);
    });
  };

  /**
   * Handle page change
   */
  private handlePageChange = (page: number): void => {
    // Reuse the mode established for the current query so paging stays consistent
    // (no re-evaluation of the begins-with → contains fallback mid-pagination).
    void this.loadProducts(page, this.state.searchQuery, this.state.searchMatchMode);
  };

  /**
   * Toggle staged-only view
   */
  private handleToggleStagedView = (): void => {
    this.setState(prevState => ({
      showStagedOnly: !prevState.showStagedOnly
    }));
  };

  /**
   * Handle catalog edited values change
   */
  private handleCatalogEditedValuesChange = (
    values: Record<string, Record<string, FieldValue>>
  ): void => {
    this.setState({ catalogEditedValues: values });
  };

  /**
   * Handle product staging
   * Stock validation happens at save time (validateStockBeforeSave), so no refresh needed during staging
   */
  private handleStageProduct = (
    product: VirtualTableRow,
    editedValues?: Record<string, FieldValue>,
    stagedId?: string,
    skipConditionalCheck?: boolean
  ): void => {
    this.props.onStageProduct(product, editedValues, stagedId, skipConditionalCheck);
  };

  render(): React.ReactElement {
    const {
      virtualRows,
      searchQuery,
      isLoading,
      paging,
      selectedFilterKey,
      selectedSubFilterKey,
      filterOptions,
      showStagedOnly,
      catalogEditedValues
    } = this.state;

    const {
      stagedProducts,
      stagedProductsById,
      mergedColumns,
      currencyCode,
      currencySymbol,
      localizationService,
      dataService,
      configService,
      parentEntityName
    } = this.props;

    // Count only catalog products (exclude write-in products)
    const stagedCount = stagedProducts.filter(sp => !sp.isWriteIn).length;

    // Catalog products that are currently staged, with full row data to render.
    const pinnedStaged = stagedProducts
      .filter(sp => !sp.isWriteIn && sp.product !== undefined)
      .map(sp => sp.product)
      .filter((p): p is VirtualTableRow => p !== undefined);

    // Pin staged products to the top so items staged on another page (or
    // restored from a previous session) stay visible instead of being stranded
    // on their original page. De-dupe so a staged product that also appears on
    // the current page is not shown twice.
    const pinnedIds = new Set(pinnedStaged.map(p => p.productid));
    const displayProducts = showStagedOnly
      ? pinnedStaged
      : [...pinnedStaged, ...virtualRows.filter(row => !pinnedIds.has(row.productid))];

    return (
      <>
        {/* Header with search and filter */}
        <div className="pag-header">
          <div className="pag-header-bar">
            <SearchBar
              value={searchQuery}
              onChange={this.handleSearch}
              placeholder={localizationService.getString('search.placeholder')}
              disabled={isLoading}
              filterOptions={filterOptions}
              selectedFilterKey={selectedFilterKey}
              onFilterChange={this.handleFilterChange}
              subFilterOptions={selectedFilterKey
                ? configService.getSubFilterOptions(parentEntityName, selectedFilterKey)
                : []}
              selectedSubFilterKey={selectedSubFilterKey}
              onSubFilterChange={this.handleSubFilterChange}
              localizationService={localizationService}
            />

            {stagedCount > 0 && (
              <Stack
                horizontal
                tokens={{ childrenGap: FluentTokens.spacing.s1 }}
                verticalAlign="center"
                className={`pag-header-staging ${
                  showStagedOnly ? 'pag-header-staging-active' : ''
                }`}
                onClick={this.handleToggleStagedView}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.handleToggleStagedView();
                  }
                }}
                aria-pressed={showStagedOnly}
                aria-label={
                  showStagedOnly
                    ? localizationService.getString('staging.showAllProducts')
                    : localizationService.getString('staging.showStagedOnly')
                }
              >
                <Icon
                  iconName={showStagedOnly ? 'FilterSolid' : 'Filter'}
                  className="pag-staging-icon"
                />
                <span className="pag-header-staging-label">
                  {localizationService.getString('general.staging', stagedCount)}
                </span>
              </Stack>
            )}
          </div>
        </div>

        {/* Grid content */}
        <div className="pag-content">
          <div className="pag-grid-container">
            <ProductGrid
              products={displayProducts}
              onStageProduct={this.handleStageProduct}
              onRemoveStaged={this.props.onRemoveStaged}
              isLoading={isLoading && !showStagedOnly}
              localizationService={localizationService}
              dataService={dataService}
              configService={configService}
              columns={mergedColumns}
              stagedProductsById={stagedProductsById}
              currencyCode={currencyCode}
              currencySymbol={currencySymbol}
              productCodeField={configService.getProductCodeField()}
              parentEntityName={parentEntityName}
              editedValues={catalogEditedValues}
              onEditedValuesChange={this.handleCatalogEditedValuesChange}
            />
          </div>

          {!showStagedOnly && (
            <Paging
              paging={paging}
              onPageChange={this.handlePageChange}
              localizationService={localizationService}
            />
          )}
        </div>
      </>
    );
  }
}
