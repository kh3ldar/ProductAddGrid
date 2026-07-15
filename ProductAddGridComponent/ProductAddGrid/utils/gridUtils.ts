/**
 * Shared utilities for grid components
 * Consolidates common logic between ProductGrid and WriteInGrid
 */

import * as React from 'react';
import { TextField, Dropdown, IDropdownOption } from '@fluentui/react';
import { MergedColumnConfig, OptionSetOption, FieldValue, DisplayFormat } from '../types';
import type { LocalizationService } from '../services/LocalizationService';
import type { DataService } from '../services/DataService';

/**
 * Grid layout constants
 */
export const GRID_CONSTANTS = {
  /** Action column width for catalog/product grid */
  ACTION_COLUMN_WIDTH_CATALOG: 100,
  /** Action column width for write-in grid (wider for Stage + Remove buttons) */
  ACTION_COLUMN_WIDTH_WRITEIN: 140
} as const;

/**
 * Shared button styles for grid actions
 * Used across ProductGrid, WriteInGrid, and ProductRequestsTab
 * Centralized to maintain consistency and reduce duplication
 */
export const BUTTON_STYLES = {
  /** Button styles for catalog product grid */
  catalog: {
    stage: { root: { minWidth: '80px' } },
    remove: { root: { minWidth: '80px', color: '#a4262c' } }
  },
  /** Button styles for write-in product grid */
  writeIn: {
    stage: { root: { minWidth: '70px', marginRight: '4px' } },
    remove: { root: { minWidth: '70px', marginRight: '4px', color: '#a4262c' } }
  },
  /** Icon button styles */
  icon: {
    delete: { root: { color: '#605e5c' } }
  },
  /** Icon-only action button styles (Edit + Remove in two-button layout) */
  iconAction: {
    edit: { root: { width: 32, height: 32, color: '#0078d4' }, icon: { fontSize: 14 } },
    remove: { root: { width: 32, height: 32, color: '#a4262c' }, icon: { fontSize: 14 } }
  }
} as const;

/**
 * Result of button action determination
 * Can contain single button or multiple buttons (e.g., Remove + Edit Details)
 */
export interface ButtonActionResult {
  /** The action type: add (stage new or open panel), editDetails (open conditional panel), or remove (unstage) */
  action: 'add' | 'editDetails' | 'remove';
  /** Localization key for the button label */
  labelKey: string;
  /** Fluent UI icon name */
  icon: string;
}

/**
 * Determine the appropriate button action(s) based on staging state and conditional fields
 * 
 * @param isStaged - Whether the item is currently staged
 * @param hasConditionalFields - Whether the product requires conditional fields
 * @returns ButtonActionResult with action, labelKey, and icon
 */
export function determineButtonAction(
  isStaged: boolean, 
  hasConditionalFields: boolean
): ButtonActionResult {
  if (isStaged && hasConditionalFields) {
    // Staged with conditional fields - show Edit Details
    // Note: Remove button will be rendered separately
    return { action: 'editDetails', labelKey: 'actions.editDetails', icon: 'Edit' };
  } else if (isStaged && !hasConditionalFields) {
    // Staged without conditional fields - show Remove only
    return { action: 'remove', labelKey: 'actions.remove', icon: 'Cancel' };
  } else {
    // Not staged (with or without conditional fields) - show Add
    // If hasConditionalFields, clicking Add will automatically open panel
    return { 
      action: 'add', 
      labelKey: 'actions.add', 
      icon: 'Add' 
    };
  }
}

/**
 * Cache for memoized formatLogicalName results
 */
const formatLogicalNameCache = new Map<string, string>();

/**
 * Format a logical name for display
 * Converts camelCase and underscore-separated names to title case with spaces
 * Results are memoized for performance.
 * 
 * @param logicalName - The logical name to format (e.g., "productName", "crcad_product_code")
 * @returns The formatted display name (e.g., "Product Name", "Crcad Product Code")
 */
export function formatLogicalName(logicalName: string): string {
  const cached = formatLogicalNameCache.get(logicalName);
  if (cached !== undefined) return cached;
  
  const formatted = logicalName
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase to spaced
    .replace(/_/g, ' ') // underscores to spaces
    .replace(/\b\w/g, chr => chr.toUpperCase()); // capitalize words
  
  formatLogicalNameCache.set(logicalName, formatted);
  return formatted;
}

/**
 * Resolve the display label for a column header
 * Priority: labelKey (localized) > displayName > formatted logicalName
 * 
 * @param column - The merged column configuration
 * @param localizationService - Service for string localization
 * @returns The resolved display label string
 */
export function resolveColumnLabel(
  column: MergedColumnConfig, 
  localizationService: LocalizationService
): string {
  // First try localization key
  if (column.labelKey) {
    const localizedString = localizationService.getString(column.labelKey);
    // If getString returns something different from the key, use it
    if (localizedString !== column.labelKey) {
      return localizedString;
    }
  }

  // Fall back to display name from metadata
  if (column.displayName?.trim()) {
    return column.displayName;
  }

  // Last resort: format the logical name using shared utility
  return formatLogicalName(column.logicalName);
}

// ============================================================================
// Row Initialization Utilities
// ============================================================================

/**
 * Initialize row edited values with OptionSet default values from column metadata
 * This consolidates the duplicated pattern found across ProductAddGrid, WriteInGrid, etc.
 * 
 * @param columns - Array of merged column configurations
 * @returns Record of field names to default values for OptionSet fields with defaults
 */
export function initializeRowWithDefaults(columns: MergedColumnConfig[]): Record<string, FieldValue> {
  const initialEditedValues: Record<string, FieldValue> = {};
  for (const column of columns) {
    if (column.type === 'OptionSet' && column.defaultValue !== undefined && column.editable) {
      initialEditedValues[column.logicalName] = column.defaultValue;
    }
  }
  return initialEditedValues;
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate that all required editable fields have values
 * Consolidates the duplicated validation pattern from ProductAddGrid and ProductRequestsTab
 * 
 * @param columns - Column definitions with required flags
 * @param editedValues - Current field values
 * @param localizationService - Service for resolving column labels
 * @returns Array of missing required field labels (empty = valid)
 */
export function validateRequiredFields(
  columns: MergedColumnConfig[],
  editedValues: Record<string, FieldValue> | undefined,
  localizationService: LocalizationService
): string[] {
  if (!editedValues) return [];
  
  const missingFields: string[] = [];
  
  for (const column of columns) {
    if (column.required && column.editable) {
      const value = editedValues[column.logicalName];
      const isNumericField = column.type === 'Decimal' || column.type === 'Money' || 
                             column.logicalName === 'quantity' || column.logicalName === 'priceperunit';
      
      // Check for empty/invalid values
      let isEmpty = false;
      if (value === undefined || value === null || value === '') {
        isEmpty = true;
      } else if (isNumericField) {
        const numVal = Number(value);
        isEmpty = isNaN(numVal) || numVal <= 0;
      } else if (typeof value === 'string' && value.trim() === '') {
        isEmpty = true;
      }
      
      if (isEmpty) {
        // Use column display name or label for user-friendly message
        const fieldLabel = resolveColumnLabel(column, localizationService) || column.logicalName;
        missingFields.push(fieldLabel);
      }
    }
  }
  
  return missingFields;
}

// ============================================================================
// Cell Rendering Utilities
// ============================================================================

/**
 * Common text field styles for editable cells
 */
const CELL_TEXT_FIELD_STYLES = {
  root: { width: '100%' },
  field: { padding: '4px 8px', fontSize: '13px' }
} as const;

const CELL_NUMBER_FIELD_STYLES = {
  root: { width: '100%' },
  field: { textAlign: 'right' as const, padding: '4px 8px', fontSize: '13px' }
} as const;

const CELL_MONEY_FIELD_STYLES = {
  root: { width: '100%' },
  suffix: { padding: '0 8px 0 4px', fontSize: '13px', color: '#605e5c' },
  field: { textAlign: 'right' as const, padding: '4px 0 4px 8px', fontSize: '13px' }
} as const;

const CELL_DROPDOWN_STYLES = {
  root: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dropdown: { minWidth: 100, width: '100%' },
  title: { padding: '4px 8px', fontSize: '13px', border: 'none', textAlign: 'center' as const },
  caretDownWrapper: { right: 4 },
  callout: { maxWidth: 300 },
  dropdownItemsWrapper: { maxHeight: 300 },
  dropdownItem: { textAlign: 'center' as const },
  dropdownItemSelected: { textAlign: 'center' as const }
} as const;

/**
 * Props for editable cell rendering
 */
export interface EditableCellProps {
  column: MergedColumnConfig;
  value: FieldValue;
  onChange: (fieldName: string, value: FieldValue) => void;
  onCellClick?: (e: React.MouseEvent) => void;
  currencySymbol?: string;
  /** Maximum value for numeric fields (e.g., quantity limited by available stock) */
  maxValue?: number;
  /** Maximum character length for Text/Memo fields */
  maxLength?: number;
  /** Callback when text exceeds maxLength (for toast notifications) */
  onMaxLengthExceeded?: (fieldName: string) => void;
}

/**
 * Props for display (read-only) cell rendering
 */
export interface DisplayCellProps {
  column: MergedColumnConfig;
  value: FieldValue;
  dataService: DataService;
  currencyCode?: string;
  displayFormat?: DisplayFormat;
  /** When true, renders numeric 0 as blank. Use for editable columns rendered as read-only in disabled rows. */
  suppressZero?: boolean;
}

/**
 * Calculate the input value for editable fields
 * Handles numeric fields specially to avoid showing "0" when empty
 */
function getInputValue(value: FieldValue, isNumericField: boolean): string {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  // For numeric fields, don't show "0" as that looks like a value was entered
  if (isNumericField && (value === 0 || value === '0')) {
    return '';
  }
  return String(value);
}

/**
 * Resolve the selected key for an OptionSet dropdown
 * Handles both numeric values and string labels
 */
function resolveOptionSetSelectedKey(
  value: FieldValue,
  options: OptionSetOption[]
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  
  if (typeof value === 'number') {
    return value;
  }
  
  const numericValue = parseInt(String(value), 10);
  if (!isNaN(numericValue)) {
    return numericValue;
  }
  
  // It's a label string, find the matching option
  const matchingOption = options.find(opt => opt.label === value);
  return matchingOption?.value;
}

/**
 * Render a Decimal/Quantity editable field
 * Supports maxValue constraint (e.g., for limiting quantity to available stock)
 */
export function renderDecimalField(
  props: EditableCellProps
): React.ReactElement {
  const { column, value, onChange, onCellClick, maxValue } = props;
  const inputValue = getInputValue(value, true);
  
  return React.createElement(TextField, {
    value: inputValue,
    onChange: (_e: React.FormEvent, newValue?: string) => {
      const numVal = parseFloat(newValue ?? '');
      if (newValue === '' || newValue === undefined) {
        onChange(column.logicalName, newValue ?? '');
        return;
      }
      // Validate: must be non-negative number
      if (isNaN(numVal) || numVal < 0) {
        return;
      }
      // Enforce max value constraint if provided (e.g., available stock limit)
      if (maxValue !== undefined && numVal > maxValue) {
        onChange(column.logicalName, String(maxValue));
        return;
      }
      onChange(column.logicalName, newValue ?? '');
    },
    onClick: onCellClick,
    type: 'number',
    min: 0,
    max: maxValue,
    autoComplete: 'off',
    borderless: true,
    styles: CELL_NUMBER_FIELD_STYLES
  });
}

/**
 * Render a Money editable field with currency symbol
 */
export function renderMoneyField(
  props: EditableCellProps
): React.ReactElement {
  const { column, value, onChange, onCellClick, currencySymbol } = props;
  const inputValue = getInputValue(value, true);
  
  return React.createElement(TextField, {
    value: inputValue,
    onChange: (_e: React.FormEvent, newValue?: string) => {
      if (newValue === '' || newValue === undefined) {
        onChange(column.logicalName, '');
        return;
      }
      // Allow digits, decimal point or comma
      if (/^\d*[.,]?\d*$/.test(newValue)) {
        // Normalize comma to period for storage
        const normalizedValue = newValue.replace(',', '.');
        onChange(column.logicalName, normalizedValue);
      }
    },
    onClick: onCellClick,
    suffix: currencySymbol ?? '$',
    autoComplete: 'off',
    borderless: true,
    styles: CELL_MONEY_FIELD_STYLES
  });
}

/**
 * Render a Text/Memo editable field
 */
export function renderTextField(
  props: EditableCellProps
): React.ReactElement {
  const { column, value, onChange, onCellClick, maxLength, onMaxLengthExceeded } = props;
  const inputValue = getInputValue(value, false);
  const isMemo = column.type === 'Memo';
  
  return React.createElement(TextField, {
    value: inputValue,
    onChange: (_e: React.FormEvent, newValue?: string) => {
      if (maxLength !== undefined && newValue !== undefined && newValue.length > maxLength) {
        onChange(column.logicalName, '');
        onMaxLengthExceeded?.(column.logicalName);
        return;
      }
      onChange(column.logicalName, newValue ?? '');
    },
    onClick: onCellClick,
    multiline: isMemo,
    rows: isMemo ? 2 : undefined,
    autoComplete: 'off',
    borderless: true,
    styles: CELL_TEXT_FIELD_STYLES
  });
}

/**
 * Render an OptionSet dropdown field
 */
export function renderOptionSetField(
  props: EditableCellProps,
  options: OptionSetOption[]
): React.ReactElement {
  const { column, value, onChange, onCellClick } = props;
  
  const dropdownOptions: IDropdownOption[] = options.map(opt => ({
    key: opt.value,
    text: opt.label
  }));
  
  const selectedKey = resolveOptionSetSelectedKey(value, options);
  
  return React.createElement(Dropdown, {
    selectedKey,
    options: dropdownOptions,
    onChange: (_e: React.FormEvent, option?: IDropdownOption) => {
      if (option) {
        onChange(column.logicalName, option.key as number);
      }
    },
    onClick: onCellClick,
    styles: CELL_DROPDOWN_STYLES
  });
}

/**
 * Render an editable cell based on column type
 * Returns the appropriate input control (TextField, Dropdown, etc.)
 */
export function renderEditableCell(props: EditableCellProps): React.ReactNode {
  const { column } = props;
  
  // Decimal/Quantity fields
  if (column.type === 'Decimal' || column.logicalName === 'quantity') {
    return renderDecimalField(props);
  }
  
  // Money fields
  if (column.type === 'Money' || column.logicalName === 'priceperunit') {
    return renderMoneyField(props);
  }
  
  // Text/Memo fields
  if (column.type === 'Text' || column.type === 'Memo') {
    return renderTextField(props);
  }
  
  // OptionSet fields
  if (column.type === 'OptionSet' && column.options && column.options.length > 0) {
    return renderOptionSetField(props, column.options);
  }
  
  // Default: text field
  return renderTextField(props);
}

/**
 * Render a read-only display cell with proper formatting
 */
export function renderDisplayCell(props: DisplayCellProps): string {
  const { column, value, dataService, currencyCode, displayFormat, suppressZero } = props;
  
  if (value === undefined || value === null || value === '') {
    return '';
  }
  
  // Money formatting - but check for displayFormat override first
  if (column.type === 'Money') {
    const numValue = Number(value);
    if (isNaN(numValue)) return '';
    if (suppressZero && numValue === 0) return '';
    // If displayFormat is provided, use formatDecimal with custom decimal places
    // This allows stock columns (which are mapped as 'Money') to show as integers
    if (displayFormat?.decimalPlaces !== undefined) {
      return dataService.formatDecimal(numValue, displayFormat.decimalPlaces);
    }
    return dataService.formatCurrency(numValue, currencyCode);
  }
  
  // Decimal formatting - use displayFormat.decimalPlaces if provided
  if (column.type === 'Decimal') {
    const numValue = Number(value);
    if (isNaN(numValue)) return '';
    if (suppressZero && numValue === 0) return '';
    const decimalPlaces = displayFormat?.decimalPlaces;
    return dataService.formatDecimal(numValue, decimalPlaces);
  }
  
  // OptionSet - value should already be formatted text
  if (column.type === 'OptionSet') {
    return String(value);
  }
  
  return String(value);
}

/**
 * Column width configuration result
 */
export interface ColumnWidthConfig {
  /** CSS class selector for the column */
  selector: string;
  /** Width percentage or fixed value */
  width: string;
}

/**
 * Column weight configuration by type (imported from types)
 */
export interface ColumnWeightOverrides {
  name?: number;
  Money?: number;
  Decimal?: number;
  OptionSet?: number;
  default?: number;
}

/**
 * Calculate dynamic column widths based on visible columns and their types.
 * Distributes remaining space after reserving action column width.
 * 
 * @param columns - Array of visible column configurations
 * @param actionColumnWidth - Fixed width for action column in pixels
 * @param tableSelector - CSS selector for the table (e.g., '.pag-grid')
 * @param weightOverrides - Optional entity-specific weight overrides
 * @returns CSS style string for column widths
 */
export function calculateColumnWidths(
  columns: MergedColumnConfig[],
  actionColumnWidth: number,
  tableSelector: string,
  weightOverrides?: ColumnWeightOverrides
): string {
  if (columns.length === 0) {
    return '';
  }

  // Default weights by type (can be overridden per entity)
  const typeWeights = {
    name: weightOverrides?.name ?? 3,
    Money: weightOverrides?.Money ?? 1.5,
    Decimal: weightOverrides?.Decimal ?? 1,
    OptionSet: weightOverrides?.OptionSet ?? 1.5,
    default: weightOverrides?.default ?? 2
  };

  // Calculate weight for each column based on type
  // Name/text columns get more space, numeric columns less
  const getColumnWeight = (column: MergedColumnConfig): number => {
    const logicalName = column.logicalName.toLowerCase();
    const type = column.type;
    
    // Name fields get more space
    if (logicalName.includes('name') || logicalName.includes('description')) {
      return typeWeights.name;
    }
    
    // Money/price fields - medium width for currency formatting
    if (type === 'Money') {
      return typeWeights.Money;
    }
    
    // Numeric fields are typically narrower
    if (type === 'Decimal') {
      return typeWeights.Decimal;
    }
    
    // OptionSet - depends on options but typically medium
    if (type === 'OptionSet') {
      return typeWeights.OptionSet;
    }
    
    // Default weight for other text fields
    return typeWeights.default;
  };

  // Calculate total weight
  const columnWeights = columns.map(getColumnWeight);
  const totalWeight = columnWeights.reduce((sum, w) => sum + w, 0);

  // Generate CSS rules for each column
  const rules: string[] = [];
  
  columns.forEach((column, index) => {
    const weight = columnWeights[index];
    // Calculate percentage of available space (action column handled separately)
    const percentage = Math.round((weight / totalWeight) * 100);
    const columnIndex = index + 1; // CSS nth-child is 1-based
    
    rules.push(
      `${tableSelector} th:nth-child(${columnIndex}), ${tableSelector} td:nth-child(${columnIndex}) { width: ${percentage}%; }`
    );
  });

  // Add action column rule (last column, fixed width)
  const actionColumnIndex = columns.length + 1;
  rules.push(
    `${tableSelector} th:nth-child(${actionColumnIndex}), ${tableSelector} td:nth-child(${actionColumnIndex}) { width: ${actionColumnWidth}px; min-width: ${actionColumnWidth}px; max-width: ${actionColumnWidth}px; }`
  );

  return rules.join('\n');
}
