/**
 * Grid Rendering Utilities
 * 
 * Centralizes common grid rendering logic to eliminate duplication across
 * ProductGrid, WriteInGrid, and ProductRequestsTab components.
 */

import * as React from 'react';
import { Label, MessageBar, MessageBarType } from '@fluentui/react';
import { MergedColumnConfig } from '../types';
import type { LocalizationService } from '../services/LocalizationService';
import { resolveColumnLabel } from './gridUtils';

/**
 * Filter out hidden columns from column configuration
 * @param columns - Array of column configurations
 * @returns Array of visible columns only
 */
export function filterVisibleColumns<T extends { hidden?: boolean }>(columns: T[]): T[] {
  return columns.filter(column => !column.hidden);
}

export interface GridHeaderCellProps {
  column: MergedColumnConfig;
  localizationService?: LocalizationService;
  columnIndex?: number;
}

/**
 * Memoized grid header cell component
 * Renders a single column header with label resolution and required indicator
 */
export const GridHeaderCell = React.memo<GridHeaderCellProps>(({ 
  column,
  localizationService,
  columnIndex
}) => {
  const label = localizationService ? resolveColumnLabel(column, localizationService) : column.displayName ?? column.logicalName;
  
  return (
    <th
      key={column.logicalName}
      data-column-index={columnIndex}
      data-column-logicalname={column.logicalName}
      role="columnheader"
    >
      <Label styles={{ root: { fontWeight: 600, margin: 0, padding: 0 } }}>
        {label}
        {column.required && <span className="pag-required-indicator">*</span>}
      </Label>
    </th>
  );
});

GridHeaderCell.displayName = 'GridHeaderCell';

/**
 * Shared loading spinner used across grid components
 */
export const LoadingSpinner = React.memo<{ labelText: string; fullscreen?: boolean }>(({ labelText, fullscreen }) => (
  <div className={fullscreen ? 'pag-loading-fullscreen' : 'pag-loading'}>
    <div className="pag-loading-spinner-large" />
    <div className="pag-loading-label">{labelText}</div>
  </div>
));
LoadingSpinner.displayName = 'LoadingSpinner';

/**
 * Shared empty state message used across grid components
 */
export const EmptyStateMessage = React.memo<{ message: string; compact?: boolean }>(({ message, compact }) => (
  <MessageBar
    messageBarType={MessageBarType.info}
    isMultiline={false}
    styles={{ root: compact ? { margin: '10px 0' } : { margin: '40px auto', maxWidth: '400px' } }}
  >
    {message}
  </MessageBar>
));
EmptyStateMessage.displayName = 'EmptyStateMessage';
