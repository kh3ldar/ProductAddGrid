import * as React from 'react';
import { DefaultButton, IconButton } from '@fluentui/react';
import { VirtualTableRow, MergedColumnConfig, StagedProduct, FieldValue } from '../types';
import { LocalizationService, DataService, ConfigService } from '../services';
import { GRID_CONSTANTS, BUTTON_STYLES, determineButtonAction, renderEditableCell, renderDisplayCell, EditableCellProps, DisplayCellProps, calculateColumnWidths, validateRequiredFields } from '../utils/gridUtils';
import { filterVisibleColumns, GridHeaderCell, LoadingSpinner, EmptyStateMessage } from '../utils/gridRenderUtils';

const ACTION_COLUMN_WIDTH = GRID_CONSTANTS.ACTION_COLUMN_WIDTH_CATALOG;

export interface IProductGridProps {
  products: VirtualTableRow[]; // Changed from Product[] to VirtualTableRow[]
  onStageProduct: (product: VirtualTableRow, editedValues?: Record<string, FieldValue>, existingStagedId?: string, skipConditionalCheck?: boolean) => void; // Updated callback type
  onRemoveStaged: (stagedId: string) => void; // Remove from staging
  isLoading: boolean;
  localizationService: LocalizationService;
  dataService: DataService;
  configService: ConfigService;
  columns: MergedColumnConfig[];
  stagedProductsById: Record<string, StagedProduct>;
  currencyCode?: string;
  currencySymbol?: string;
  productCodeField: string; // Product code field name from config (required)
  parentEntityName?: string; // Parent entity name for special handling (e.g., reservation)
  // Controlled mode props (optional - for preserving state across tab switches)
  editedValues?: Record<string, Record<string, FieldValue>>;
  onEditedValuesChange?: (editedValues: Record<string, Record<string, FieldValue>>) => void;
}

export const ProductGrid = React.memo<IProductGridProps>(function ProductGrid({
  products,
  onStageProduct,
  onRemoveStaged,
  isLoading,
  localizationService,
  dataService,
  configService,
  columns,
  stagedProductsById,
  currencyCode,
  currencySymbol,
  productCodeField, // Product code field name from config - required
  parentEntityName,
  editedValues: controlledEditedValues,
  onEditedValuesChange
}) {
  // State to track edited values for each product (local state for uncontrolled mode)
  const [localEditedValues, setLocalEditedValues] = React.useState<Record<string, Record<string, FieldValue>>>({});
  
  // Use controlled or uncontrolled mode based on props
  const isControlled = controlledEditedValues !== undefined && onEditedValuesChange !== undefined;
  const editedValues = isControlled ? controlledEditedValues : localEditedValues;
  const setEditedValues = isControlled 
    ? (updater: Record<string, Record<string, FieldValue>> | ((prev: Record<string, Record<string, FieldValue>>) => Record<string, Record<string, FieldValue>>)) => {
        const newValue = typeof updater === 'function' ? updater(controlledEditedValues) : updater;
        onEditedValuesChange(newValue);
      }
    : setLocalEditedValues;

  // Memoize visible columns to avoid repeated filtering
  const visibleColumns = React.useMemo(
    () => filterVisibleColumns(columns),
    [columns]
  );

  // Helper to check if row is disabled based on config (disableRowWhenStockZero)
  // IMPORTANT: Staged products are NEVER disabled - user must always be able to remove/edit them
  const isRowDisabled = React.useCallback((product: VirtualTableRow): boolean => {
    // Staged products are always interactive (can be removed/edited)
    if (stagedProductsById[product.productid]) {
      return false;
    }
    
    // Config-driven: check if entity should disable rows when stock is zero
    if (parentEntityName && configService.shouldDisableRowWhenStockZero(parentEntityName)) {
      const stockColumns = configService.getStockColumns(parentEntityName);
      if (stockColumns.length > 0) {
        const stockColumn = stockColumns[0]; // Use first stock column for validation
        const availableStock = product[stockColumn];
        return availableStock !== undefined && availableStock !== null && Number(availableStock) <= 0;
      }
    }
    return false;
  }, [parentEntityName, stagedProductsById, configService]);

  const handleStageClick = (product: VirtualTableRow, stagedId?: string, isDisabled = false) => () => {
    if (isDisabled) {
      return;
    }
    const productEditedValues = editedValues[product.productid] || {};
    onStageProduct(product, productEditedValues, stagedId);
    // NOTE: Don't clear editedValues here - keep them so the UI continues to show
    // the values the user entered. They will be naturally cleared when the product
    // list refreshes or when the dialog closes.
  };

  const handleFieldChange = (productId: string, fieldName: string, value: FieldValue) => {
    // Update local edited values state
    const updatedEditedValues = {
      ...editedValues,
      [productId]: {
        ...editedValues[productId],
        [fieldName]: value
      }
    };
    setEditedValues(updatedEditedValues);

    const product = products.find(p => p.productid === productId);
    if (!product) {
      return;
    }

    // Config-driven: auto-stage rows once all required fields are filled (per-entity flag)
    const autoStageEnabled = Boolean(parentEntityName) && configService.isAutoStageEnabled(parentEntityName!);
    const staged = stagedProductsById[productId];

    if (staged) {
      // Auto-stage mode: if a required field was just cleared, silently un-stage the row
      // ("fill to add, clear to remove"). No toast — this is a passive, per-keystroke action.
      if (autoStageEnabled) {
        // Validate against the EFFECTIVE values, not just the live edits: required values may
        // live in staged.editedFields (e.g. after a reload, where catalogEditedValues is empty
        // but the staged row was restored). Mirrors the merge in handleStageProduct so editing
        // an unrelated column never makes a filled required field look "missing" and un-stage.
        const effectiveValues = { ...staged.editedFields, ...updatedEditedValues[productId] };
        const missingFields = validateRequiredFields(columns, effectiveValues, localizationService);
        if (missingFields.length > 0) {
          onRemoveStaged(staged.id);
          return;
        }
      }
      // Existing behavior: auto-save inline edits on an already-staged row.
      // skipConditionalCheck=true prevents the conditional panel from re-popping; existing
      // conditional values are preserved via the merge in handleStageProduct.
      onStageProduct(product, updatedEditedValues[productId], staged.id, true);
      return;
    }

    // Not staged yet — auto-stage when every required grid field has a value.
    if (autoStageEnabled) {
      const missingFields = validateRequiredFields(columns, updatedEditedValues[productId], localizationService);
      if (missingFields.length === 0) {
        // skipConditionalCheck=false: handleStageProduct stages directly when there are no
        // conditional fields, or auto-opens the Conditional Fields panel when the product needs it.
        onStageProduct(product, updatedEditedValues[productId], undefined, false);
      }
      // Incomplete -> do nothing, silently (no toast spam while typing).
    }
  };

  const renderCellValue = (product: VirtualTableRow, column: MergedColumnConfig): React.ReactNode => {
    // Special case: name column shows product code as secondary text below
    if (column.logicalName === 'name') {
      const productCode = product[productCodeField] as string | undefined;
      return (
        <div className="pag-cell-name-with-code">
          <span className="pag-cell-name">{product.name}</span>
          {productCode && <span className="pag-cell-product-code">{productCode}</span>}
        </div>
      );
    }

    const primaryKey = column.logicalName as keyof VirtualTableRow;
    let value = product[primaryKey];

    if ((value === undefined || value === null) && column.sourceLogicalName) {
      const sourceKey = column.sourceLogicalName as keyof VirtualTableRow;
      value = product[sourceKey];
    }

    // Check for values in order of priority:
    // 1. Current edited values (user is actively editing)
    // 2. Staged product's edited fields (already staged with edits) - use editedFields, not product
    // 3. Original product value from the row
    const editedValue: FieldValue = editedValues[product.productid]?.[column.logicalName];
    const staged = stagedProductsById[product.productid];
    const stagedValue: FieldValue = staged?.editedFields?.[column.logicalName];
    
    // Priority: editedValue > stagedValue > original value
    let currentValue: FieldValue;
    if (editedValue !== undefined) {
      currentValue = editedValue;
    } else if (staged && stagedValue !== undefined) {
      currentValue = stagedValue;
    } else {
      currentValue = value as FieldValue;
    }

    // If the column is editable, render using shared utility
    if (column.editable && !column.readOnly) {
      // Check if row is disabled (reservation with no stock)
      const rowDisabled = isRowDisabled(product);
      
      // If row is disabled, render as read-only
      // suppressZero: editable fields that haven't been filled in should show blank, not "0" / "TRY 0.00"
      if (rowDisabled) {
        const displayProps: DisplayCellProps = {
          column,
          value: currentValue,
          dataService,
          currencyCode,
          displayFormat: configService.getDisplayFormat(column.logicalName),
          suppressZero: true
        };
        return renderDisplayCell(displayProps);
      }

      // OptionSet without options - render as read-only text
      if (column.type === 'OptionSet' && (!column.options || column.options.length === 0)) {
        const displayValue = currentValue !== null && currentValue !== undefined ? String(currentValue) : '';
        return displayValue;
      }

      // Config-driven: calculate max value for quantity fields (limitQuantityToStock)
      let maxValue: number | undefined;
      const isQuantityColumn = column.logicalName === 'quantity' || 
        column.logicalName.endsWith('_quantity') ||
        column.type === 'Decimal';
      
      if (isQuantityColumn && parentEntityName && configService.shouldLimitQuantityToStock(parentEntityName)) {
        const stockColumns = configService.getStockColumns(parentEntityName);
        if (stockColumns.length > 0) {
          const stockColumn = stockColumns[0]; // Use first stock column for validation
          const availableStock = product[stockColumn];
          if (availableStock !== undefined && availableStock !== null) {
            maxValue = Number(availableStock);
          }
        }
      }

      const editableProps: EditableCellProps = {
        column,
        value: currentValue,
        onChange: (fieldName: string, newValue: FieldValue) => handleFieldChange(product.productid, fieldName, newValue),
        onCellClick: (e: React.MouseEvent) => e.stopPropagation(),
        currencySymbol,
        maxValue
      };
      return renderEditableCell(editableProps);
    }

    // For non-editable fields, use shared display utility
    const displayProps: DisplayCellProps = {
      column,
      value: currentValue,
      dataService,
      currencyCode,
      displayFormat: configService.getDisplayFormat(column.logicalName)
    };
    
    // OptionSet diagnostic logging
    if (column.type === 'OptionSet') {
      const displayValue = currentValue !== null && currentValue !== undefined ? String(currentValue) : '';
      return displayValue;
    }
    
    return renderDisplayCell(displayProps);
  };

  // Dynamically calculate column widths based on visible columns and their types
  const columnStyleRules = React.useMemo(() => {
    const weightOverrides = parentEntityName ? configService.getColumnWeights(parentEntityName) : undefined;
    return calculateColumnWidths(visibleColumns, ACTION_COLUMN_WIDTH, '.pag-grid:not(.pag-writein-grid)', weightOverrides);
  }, [visibleColumns, parentEntityName, configService]);

  if (isLoading) {
    return <LoadingSpinner labelText={localizationService.getString('general.loading')} />;
  }

  if (products.length === 0) {
    return <EmptyStateMessage message={localizationService.getString('general.noResults')} />;
  }

  return (
    <>
      {columnStyleRules && <style>{columnStyleRules}</style>}
      <table className="pag-grid" role="table">
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
          {products.map(product => {
            const staged = stagedProductsById[product.productid];
            const isStaged = Boolean(staged);
            const rowDisabled = isRowDisabled(product);
            
            // Check if product requires conditional fields
            const hasConditionalFields = parentEntityName 
              ? configService.productRequiresConditionalFields(product, parentEntityName)
              : false;
            
            // Determine button action using shared utility
            const { action: buttonAction, labelKey: buttonLabelKey, icon: buttonIcon } = determineButtonAction(isStaged, hasConditionalFields);
            
            // Determine click handler based on action
            let buttonOnClick: () => void;
            if (buttonAction === 'remove') {
              buttonOnClick = () => onRemoveStaged(staged.id);
            } else if (buttonAction === 'editDetails') {
              // Opens conditional fields panel for editing (handled by onStageProduct)
              buttonOnClick = handleStageClick(product, staged?.id, rowDisabled);
            } else {
              // buttonAction === 'add'
              // For not-staged products: if hasConditionalFields, panel opens automatically
              // Otherwise stages directly (handled by onStageProduct logic)
              buttonOnClick = handleStageClick(product, undefined, rowDisabled);
            }
            
            // For staged products with conditional fields, render TWO buttons
            const showTwoButtons = isStaged && hasConditionalFields;

            return (
              <tr
                key={product.productid}
                className={`pag-grid-row${isStaged ? ' staged' : ''}${rowDisabled ? ' disabled' : ''}`}
                role="row"
              >
                {visibleColumns.map((column, columnIndex) => (
                  <td
                    key={column.logicalName}
                    className="pag-grid-cell"
                    data-column-index={columnIndex}
                    data-column-logicalname={column.logicalName}
                    role="gridcell"
                  >
                    {renderCellValue(product, column)}
                  </td>
                ))}
                <td className="pag-grid-cell" data-column-role="actions" role="gridcell">
                  {showTwoButtons ? (
                    // Two icon-only buttons: Edit Details + Remove
                    <div className="pag-action-buttons-container">
                      <IconButton
                        iconProps={{ iconName: buttonIcon }}
                        title={localizationService.getString(buttonLabelKey)}
                        ariaLabel={`${localizationService.getString(buttonLabelKey)} ${product.name}`}
                        onClick={buttonOnClick}
                        styles={BUTTON_STYLES.iconAction.edit}
                        disabled={rowDisabled}
                      />
                      <IconButton
                        iconProps={{ iconName: 'Cancel' }}
                        title={localizationService.getString('actions.remove')}
                        ariaLabel={`${localizationService.getString('actions.remove')} ${product.name}`}
                        onClick={() => onRemoveStaged(staged.id)}
                        styles={BUTTON_STYLES.iconAction.remove}
                        disabled={rowDisabled}
                      />
                    </div>
                  ) : (
                    // Single button
                    <DefaultButton
                      text={localizationService.getString(buttonLabelKey)}
                      onClick={buttonOnClick}
                      iconProps={{ iconName: buttonIcon }}
                      ariaLabel={`${localizationService.getString(buttonLabelKey)} ${product.name}`}
                      styles={buttonAction === 'remove' ? BUTTON_STYLES.catalog.remove : BUTTON_STYLES.catalog.stage}
                      disabled={rowDisabled}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
});

ProductGrid.displayName = 'ProductGrid';