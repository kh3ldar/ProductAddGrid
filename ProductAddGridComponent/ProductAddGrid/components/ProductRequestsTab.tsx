import * as React from 'react';
import { DefaultButton, PrimaryButton, IconButton, Dropdown, IDropdownOption, Icon, Stack } from '@fluentui/react';
import { ProductRequestRow, MergedColumnConfig, FieldValue, VirtualTableRow, OptionSetOption, ProductFilterOption } from '../types';
import { LocalizationService, DataService, ConfigService } from '../services';
import { GRID_CONSTANTS, BUTTON_STYLES, renderEditableCell, renderDisplayCell, EditableCellProps, DisplayCellProps, calculateColumnWidths, validateRequiredFields, resolveColumnLabel } from '../utils/gridUtils';
import { filterVisibleColumns, GridHeaderCell, LoadingSpinner, EmptyStateMessage } from '../utils/gridRenderUtils';
import { SearchBar } from './SearchBar';
import { FluentTokens } from '../theme/FluentTokens';

const ACTION_COLUMN_WIDTH = GRID_CONSTANTS.ACTION_COLUMN_WIDTH_WRITEIN;

export interface IProductRequestsTabProps {
  // Write-In Grid
  writeInRows: ProductRequestRow[];
  writeInEditedValues: Record<string, Record<string, FieldValue>>;
  onWriteInRowChange: (rowId: string, field: string, value: FieldValue) => void;
  onAddWriteInRow: () => void;
  onRemoveWriteInRow: (rowId: string) => void;
  
  // Catalog Grid - single grid for search results with inline editing
  catalogRows: ProductRequestRow[]; // Staged catalog products
  searchResults: VirtualTableRow[];
  catalogEditedValues?: Record<string, Record<string, FieldValue>>; // Auto-set values from parent (e.g., Product Type based on group code)
  onAddFromSearch: (product: VirtualTableRow, editedValues: Record<string, FieldValue>) => void;
  onRemoveFromStaging: (productId: string) => void;
  stagedProductIds: Set<string>;
  isSearching: boolean;
  
  // Search props for catalog section
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filterOptions?: ProductFilterOption[];
  selectedFilterKey?: string;
  onFilterChange?: (filterKey: string) => void;
  
  // Column sets - both grids use hybrid view columns + Request Type
  catalogColumns: MergedColumnConfig[]; // Catalog grid columns + Request Type (hybrid view)
  writeInColumns: MergedColumnConfig[]; // Write-in grid columns + Request Type
  requestTypeOptions: OptionSetOption[];
  localizationService: LocalizationService;
  dataService: DataService;
  configService: ConfigService;
  currencyCode?: string;
  currencySymbol?: string;
  isLoading: boolean;
  
  // Toast notifications
  showToast: (type: 'success' | 'error' | 'warning', message: string) => void;
}

interface IProductRequestsTabState {
  // Track edited values for catalog search results (keyed by productid)
  catalogSearchEditedValues: Record<string, Record<string, FieldValue>>;
  // Track catalog section expansion state
  catalogExpanded: boolean;
  // Track write-in section expansion state
  writeInExpanded: boolean;
  // Track staged-only filter state
  showStagedOnly: boolean;
}

/**
 * ProductRequestsTab Component
 * 
 * Two-grid layout for Product Requests:
 * - Catalog Grid (TOP) - search results with inline editing (hybrid view columns + Request Type)
 * - Write-In Grid (BOTTOM) - for manual product entry
 * 
 * Search is handled by the parent component via the shared header (same as Catalog tab).
 * Both grids use hybrid view columns with Request Type as a virtual column.
 */
export class ProductRequestsTab extends React.PureComponent<IProductRequestsTabProps, IProductRequestsTabState> {
  constructor(props: IProductRequestsTabProps) {
    super(props);
    this.state = {
      catalogSearchEditedValues: props.catalogEditedValues ?? {},
      catalogExpanded: false,
      writeInExpanded: false,
      showStagedOnly: false
    };
  }

  componentDidUpdate(prevProps: IProductRequestsTabProps): void {
    // Merge parent's auto-set values with local state when they change
    if (this.props.catalogEditedValues !== prevProps.catalogEditedValues) {
      this.setState(prevState => {
        const merged = { ...this.props.catalogEditedValues };
        // Preserve user's manual edits - they take precedence
        Object.keys(prevState.catalogSearchEditedValues).forEach(productId => {
          merged[productId] = {
            ...merged[productId],
            ...prevState.catalogSearchEditedValues[productId]
          };
        });
        return { catalogSearchEditedValues: merged };
      });
    }

    // Auto-reset staged view when last catalog item removed
    const currentStagedCount = this.props.catalogRows.filter(row => !row._isWriteIn).length;
    const prevStagedCount = prevProps.catalogRows.filter(row => !row._isWriteIn).length;
    if (
      this.state.showStagedOnly &&
      currentStagedCount === 0 &&
      prevStagedCount > 0
    ) {
      this.setState({ showStagedOnly: false });
    }
  }

  // ============================================================================
  // WRITE-IN GRID HANDLERS
  // ============================================================================

  private handleToggleCatalog = (): void => {
    this.setState(prevState => ({ catalogExpanded: !prevState.catalogExpanded }));
  };

  private handleToggleWriteIn = (): void => {
    this.setState(prevState => ({ writeInExpanded: !prevState.writeInExpanded }));
  };

  private handleToggleStagedView = (): void => {
    this.setState(prevState => ({ showStagedOnly: !prevState.showStagedOnly }));
  };

  private handleAddWriteInRow = (): void => {
    this.props.onAddWriteInRow();
  };

  private handleRemoveWriteInRow = (rowId: string): void => {
    this.props.onRemoveWriteInRow(rowId);
  };

  private handleWriteInFieldChange = (rowId: string, fieldName: string, value: FieldValue): void => {
    this.props.onWriteInRowChange(rowId, fieldName, value);
  };

  // ============================================================================
  // CATALOG GRID HANDLERS
  // ============================================================================

  private handleCatalogSearchFieldChange = (productId: string, fieldName: string, value: FieldValue): void => {
    this.setState(prevState => ({
      catalogSearchEditedValues: {
        ...prevState.catalogSearchEditedValues,
        [productId]: {
          ...prevState.catalogSearchEditedValues[productId],
          [fieldName]: value
        }
      }
    }));
  };

  private handleAddFromSearch = (product: VirtualTableRow): void => {
    const editedValues = this.state.catalogSearchEditedValues[product.productid] || {};
    
    // Validate required fields before staging using shared utility
    const missingFields = validateRequiredFields(this.props.catalogColumns, editedValues, this.props.localizationService);
    if (missingFields.length > 0) {
      this.props.showToast('error', `${this.props.localizationService.getString('toast.validationError')}: ${missingFields.join(', ')}`);
      return;
    }
    
    this.props.onAddFromSearch(product, editedValues);
    // Keep edited values so UI stays consistent after adding
  };

  private handleRemoveFromStaging = (productId: string): void => {
    this.props.onRemoveFromStaging(productId);
  };

  // ============================================================================
  // RENDER HELPERS
  // ============================================================================

  /**
   * Render Request Type dropdown - works for any row type using the provided id
   * Follows Dataverse choice behavior - no placeholder option, just the real options
   */
  private renderRequestTypeDropdownById = (
    id: string,
    editedValues: Record<string, Record<string, FieldValue>>,
    onChange: (id: string, field: string, value: FieldValue) => void
  ): React.ReactNode => {
    const { requestTypeOptions, localizationService } = this.props;
    const rawValue = editedValues[id]?.requesttype;
    // Ensure we get a number or undefined for the dropdown
    const currentValue = typeof rawValue === 'number' ? rawValue : undefined;
    
    // No placeholder option - Dataverse choice fields don't have "-- Select --"
    const options: IDropdownOption[] = requestTypeOptions.map(opt => ({
      key: opt.value,
      text: opt.label
    }));
    
    return (
      <Dropdown
        options={options}
        selectedKey={currentValue}
        placeholder={localizationService.getString('placeholder.selectOption')}
        onChange={(_, option) => {
          if (option) {
            onChange(id, 'requesttype', Number(option.key) as FieldValue);
          }
        }}
        styles={{ 
          root: { width: '100%', display: 'flex', alignItems: 'center' },
          dropdown: { minWidth: 150, width: '100%' } 
        }}
      />
    );
  };

  /**
   * Render cell for catalog search results (editable inline)
   */
  private renderCatalogSearchCell = (
    product: VirtualTableRow,
    column: MergedColumnConfig
  ): React.ReactNode => {
    const { currencySymbol, currencyCode, dataService, configService } = this.props;
    const { catalogSearchEditedValues } = this.state;
    const editedValue = catalogSearchEditedValues[product.productid]?.[column.logicalName];
    
    // Special handling for Request Type column - always editable dropdown
    if (column.logicalName === 'requesttype') {
      return this.renderRequestTypeDropdownById(
        product.productid,
        catalogSearchEditedValues,
        this.handleCatalogSearchFieldChange
      );
    }
    
    // Special case: name column shows product code as secondary text below (same as main catalog)
    if (column.logicalName === 'name') {
      const productCodeField = configService.getProductCodeField();
      const productCode = product[productCodeField] as string | undefined;
      return (
        <div className="pag-cell-name-with-code">
          <span className="pag-cell-name">{product.name}</span>
          {productCode && <span className="pag-cell-product-code">{productCode}</span>}
        </div>
      );
    }
    
    // Get value: prefer edited value, then product value
    const value = editedValue !== undefined ? editedValue : product[column.logicalName];

    // Product name fields are read-only (come from product entity)
    const isProductNameField = column.logicalName === 'name' || 
      column.logicalName === 'productdescription' ||
      column.logicalName.endsWith('productname');
    
    // If column is read-only or is a product name field, render as display
    if (column.readOnly || !column.editable || isProductNameField) {
      const displayProps: DisplayCellProps = {
        column,
        value: value as FieldValue,
        dataService,
        currencyCode,
        displayFormat: configService.getDisplayFormat(column.logicalName)
      };
      return renderDisplayCell(displayProps);
    }

    // Editable fields - use shared utility
    const editableProps: EditableCellProps = {
      column,
      value: value as FieldValue,
      onChange: (fieldName: string, newValue: FieldValue) => 
        this.handleCatalogSearchFieldChange(product.productid, fieldName, newValue),
      onCellClick: (e: React.MouseEvent) => e.stopPropagation(),
      currencySymbol
    };
    return renderEditableCell(editableProps);
  };

  /**
   * Render cell for write-in grid (editable)
   */
  private renderWriteInCell = (
    row: ProductRequestRow,
    column: MergedColumnConfig
  ): React.ReactNode => {
    const { currencySymbol, currencyCode, dataService, configService, writeInEditedValues } = this.props;
    const editedValue = writeInEditedValues[row._tempId]?.[column.logicalName];
    
    // Special handling for Request Type column
    if (column.logicalName === 'requesttype') {
      return this.renderRequestTypeDropdownById(
        row._tempId,
        writeInEditedValues,
        this.handleWriteInFieldChange
      );
    }
    
    // Get value: prefer edited value, then row value
    const value = editedValue !== undefined ? editedValue : row[column.logicalName];
    
    // If column is read-only or not editable, render as display cell
    if (column.readOnly || !column.editable) {
      const displayProps: DisplayCellProps = {
        column,
        value: value as FieldValue,
        dataService,
        currencyCode,
        displayFormat: configService.getDisplayFormat(column.logicalName)
      };
      return renderDisplayCell(displayProps);
    }

    // Editable fields - use shared utility
    const editableProps: EditableCellProps = {
      column,
      value: value as FieldValue,
      onChange: (fieldName: string, newValue: FieldValue) => 
        this.handleWriteInFieldChange(row._tempId, fieldName, newValue),
      onCellClick: (e: React.MouseEvent) => e.stopPropagation(),
      currencySymbol,
      maxLength: column.maxLength,
      onMaxLengthExceeded: column.maxLength ? (_fieldName: string) => {
        const fieldLabel = resolveColumnLabel(column, this.props.localizationService);
        const message = this.props.localizationService.getString('toast.maxLengthExceeded')
          .replace('{0}', fieldLabel)
          .replace('{1}', String(column.maxLength));
        this.props.showToast('warning', message);
      } : undefined
    };
    return renderEditableCell(editableProps);
  };

  private renderWriteInGrid(): React.ReactElement {
    const { writeInRows, writeInColumns, localizationService } = this.props;
    
    // Filter visible columns
    const visibleColumns = filterVisibleColumns(writeInColumns);

    return (
      <div className="pag-product-request-section pag-product-request-writein">
        <div className="pag-product-request-content pag-grid-container">
          {writeInRows.length === 0 ? (
            <EmptyStateMessage compact message={localizationService.getString('writeIn.emptyGrid')} />
          ) : (
            <>
              <style>{calculateColumnWidths(visibleColumns, ACTION_COLUMN_WIDTH, '.pag-request-writein-grid')}</style>
              <table className="pag-grid pag-request-writein-grid" role="table">
              <thead className="pag-grid-header">
                <tr role="row">
                  {visibleColumns.map((column, columnIndex) => (
                    <GridHeaderCell
                      key={column.logicalName}
                      column={column}
                      localizationService={localizationService}
                      columnIndex={columnIndex}
                    />
                  ))}
                  <th data-column-role="actions" role="columnheader">
                    {localizationService.getString('actions.remove')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {writeInRows.map(row => (
                  <tr key={row._tempId} className="pag-grid-row pag-request-row" role="row">
                    {visibleColumns.map((column, columnIndex) => (
                      <td key={column.logicalName} className="pag-grid-cell" data-column-index={columnIndex} role="gridcell">
                        {this.renderWriteInCell(row, column)}
                      </td>
                    ))}
                    <td className="pag-grid-cell pag-request-actions" data-column-role="actions" role="gridcell">
                      <IconButton
                        iconProps={{ iconName: 'Delete' }}
                        title={localizationService.getString('actions.removeRow')}
                        ariaLabel={localizationService.getString('actions.removeRow')}
                        onClick={() => this.handleRemoveWriteInRow(row._tempId)}
                        styles={BUTTON_STYLES.icon.delete}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        </div>
        
        {/* Footer with Add Row button - always visible at bottom right */}
        <div className="pag-product-request-footer">
          <PrimaryButton
            text={localizationService.getString('actions.addRow')}
            iconProps={{ iconName: 'Add' }}
            onClick={this.handleAddWriteInRow}
            styles={{ root: { minWidth: '100px' } }}
          />
        </div>
      </div>
    );
  }

  private renderCatalogGrid(): React.ReactElement {
    const { catalogRows, searchResults, isSearching, localizationService, catalogColumns } = this.props;
    const { showStagedOnly } = this.state;
    
    // Filter visible columns - uses hybrid view columns + Request Type
    const visibleColumns = filterVisibleColumns(catalogColumns);

    // Extract staged product data (VirtualTableRow) from catalogRows
    const stagedProductData = catalogRows
      .filter(row => !row._isWriteIn && row._productData !== undefined)
      .map(row => row._productData)
      .filter((p): p is VirtualTableRow => p !== undefined);

    // Build display list based on filter state
    const displayProducts = showStagedOnly
      ? stagedProductData
      : (() => {
          // Merge staged products with search results, deduplicating by productid
          const stagedIds = new Set(stagedProductData.map(p => p.productid));
          const nonStagedSearchResults = searchResults.filter(p => !stagedIds.has(p.productid));
          return [...stagedProductData, ...nonStagedSearchResults];
        })();

    // Determine empty state message
    const showEmptyMessage = !isSearching && displayProducts.length === 0;
    const emptyMessage = showStagedOnly
      ? localizationService.getString('productRequest.noCatalogProducts')
      : localizationService.getString('msg.noProductsFound');

    return (
      <div className="pag-product-request-section pag-product-request-catalog">
        <div className="pag-product-request-content pag-grid-container">
          {isSearching ? (
            <LoadingSpinner labelText={localizationService.getString('general.loading')} />
          ) : showEmptyMessage ? (
            <EmptyStateMessage compact message={emptyMessage} />
          ) : (
            <>
              <style>{calculateColumnWidths(visibleColumns, ACTION_COLUMN_WIDTH, '.pag-request-catalog-grid')}</style>
              <table className="pag-grid pag-request-catalog-grid" role="table">
                <thead className="pag-grid-header">
                  <tr role="row">
                    {visibleColumns.map((column, columnIndex) => (
                      <GridHeaderCell
                        key={column.logicalName}
                        column={column}
                        localizationService={localizationService}
                        columnIndex={columnIndex}
                      />
                    ))}
                    <th data-column-role="actions" role="columnheader">
                      {localizationService.getString('actions.add')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayProducts.map(product => {
                    const isStaged = this.props.stagedProductIds.has(product.productid);
                    return (
                    <tr
                      key={product.productid}
                      className={`pag-grid-row${isStaged ? ' staged' : ''}`}
                      role="row"
                    >
                      {visibleColumns.map((column, columnIndex) => (
                        <td
                          key={column.logicalName}
                          className="pag-grid-cell"
                          data-column-index={columnIndex}
                          role="gridcell"
                        >
                          {this.renderCatalogSearchCell(product, column)}
                        </td>
                      ))}
                      <td className="pag-grid-cell" data-column-role="actions" role="gridcell">
                        <DefaultButton
                          text={localizationService.getString(isStaged ? 'actions.remove' : 'actions.add')}
                          onClick={() => isStaged 
                            ? this.handleRemoveFromStaging(product.productid) 
                            : this.handleAddFromSearch(product)}
                          iconProps={{ iconName: isStaged ? 'Cancel' : 'Add' }}
                          styles={isStaged ? BUTTON_STYLES.writeIn.remove : BUTTON_STYLES.writeIn.stage}
                        />
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    );
  }

  render(): React.ReactElement {
    const { catalogRows, isLoading, localizationService, searchQuery, onSearchChange, filterOptions, selectedFilterKey, onFilterChange } = this.props;
    const { catalogExpanded, writeInExpanded, showStagedOnly } = this.state;

    // Count staged catalog products (exclude write-in)
    const stagedCatalogCount = catalogRows.filter(row => !row._isWriteIn).length;

    if (isLoading) {
      return <LoadingSpinner labelText={localizationService.getString('general.loading')} />;
    }

    return (
      <div className="pag-product-requests-tab">
        {/* Collapsible Catalog Section */}
        <div className="pag-catalog-toggle-section">
          <div 
            className="pag-catalog-toggle-header"
            onClick={this.handleToggleCatalog}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.handleToggleCatalog(); } }}
            aria-expanded={catalogExpanded ? 'true' : 'false'}
          >
            <Icon 
              iconName={catalogExpanded ? 'ChevronDown' : 'ChevronRight'} 
              className="pag-catalog-toggle-icon"
            />
            <span className="pag-catalog-toggle-label">
              {localizationService.getString('productRequest.searchCatalog')}
            </span>
          </div>
          {catalogExpanded && (
            <div className="pag-catalog-toggle-content">
              <div className="pag-catalog-search-bar">
                <SearchBar
                  value={searchQuery}
                  onChange={onSearchChange}
                  placeholder={localizationService.getString('search.placeholder')}
                  disabled={this.props.isSearching}
                  filterOptions={filterOptions}
                  selectedFilterKey={selectedFilterKey}
                  onFilterChange={onFilterChange}
                  localizationService={localizationService}
                />
                {stagedCatalogCount > 0 && (
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
                      {localizationService.getString('general.staging', stagedCatalogCount)}
                    </span>
                  </Stack>
                )}
              </div>
              {this.renderCatalogGrid()}
            </div>
          )}
        </div>
        <div className="pag-section-divider" />
        {/* Collapsible Write-In Section */}
        <div className="pag-writein-toggle-section">
          <div 
            className="pag-writein-toggle-header"
            onClick={this.handleToggleWriteIn}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.handleToggleWriteIn(); } }}
            aria-expanded={writeInExpanded ? 'true' : 'false'}
          >
            <Icon 
              iconName={writeInExpanded ? 'ChevronDown' : 'ChevronRight'} 
              className="pag-writein-toggle-icon"
            />
            <span className="pag-writein-toggle-label">
              {localizationService.getString('productRequest.manualEntry')}
            </span>
          </div>
          {writeInExpanded && (
            <div className="pag-writein-toggle-content">
              {this.renderWriteInGrid()}
            </div>
          )}
        </div>
      </div>
    );
  }
}

export default ProductRequestsTab;
