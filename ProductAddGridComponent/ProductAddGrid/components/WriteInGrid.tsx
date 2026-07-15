import * as React from 'react';
import { DefaultButton, PrimaryButton, IconButton } from '@fluentui/react';
import { WriteInRow, MergedColumnConfig, StagedProduct, FieldValue } from '../types';
import { LocalizationService, DataService, ConfigService } from '../services';
import { generateWriteInTempId } from '../utils/idGenerator';
import { GRID_CONSTANTS, BUTTON_STYLES, determineButtonAction, renderEditableCell, renderDisplayCell, EditableCellProps, DisplayCellProps, calculateColumnWidths, initializeRowWithDefaults, resolveColumnLabel } from '../utils/gridUtils';
import { filterVisibleColumns, GridHeaderCell, LoadingSpinner, EmptyStateMessage } from '../utils/gridRenderUtils';

const ACTION_COLUMN_WIDTH = GRID_CONSTANTS.ACTION_COLUMN_WIDTH_WRITEIN;

export interface IWriteInGridProps {
  columns: MergedColumnConfig[];
  onStageProduct: (row: WriteInRow, editedValues: Record<string, FieldValue>, existingStagedId?: string) => void;
  onRemoveStaged: (stagedId: string) => void;
  isLoading: boolean;
  localizationService: LocalizationService;
  dataService: DataService;
  configService: ConfigService;
  currencyCode?: string;
  currencySymbol?: string;
  // Staging state lookup - keyed by tempId (which is used as productId for write-ins)
  stagedWriteInsById: Record<string, StagedProduct>;
  // Controlled mode props (optional - for preserving state across tab switches)
  rows?: WriteInRow[];
  editedValues?: Record<string, Record<string, FieldValue>>;
  onRowsChange?: (rows: WriteInRow[], editedValues: Record<string, Record<string, FieldValue>>) => void;
  onShowToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void;
}

interface IWriteInGridState {
  // Local state used only in uncontrolled mode
  localRows: WriteInRow[];
  localEditedValues: Record<string, Record<string, FieldValue>>;
}

export class WriteInGrid extends React.PureComponent<IWriteInGridProps, IWriteInGridState> {
  constructor(props: IWriteInGridProps) {
    super(props);
    this.state = {
      localRows: [],
      localEditedValues: {}
    };
  }

  // Helper to determine if we're in controlled mode
  private isControlled(): boolean {
    return this.props.rows !== undefined && this.props.onRowsChange !== undefined;
  }

  // Get current rows (from props if controlled, from state if uncontrolled)
  private getRows(): WriteInRow[] {
    return this.isControlled() ? (this.props.rows ?? []) : this.state.localRows;
  }

  // Get current edited values
  private getEditedValues(): Record<string, Record<string, FieldValue>> {
    return this.isControlled() ? (this.props.editedValues ?? {}) : this.state.localEditedValues;
  }

  // Update rows and edited values (calls parent callback if controlled)
  private updateRowsAndValues(rows: WriteInRow[], editedValues: Record<string, Record<string, FieldValue>>): void {
    if (this.isControlled()) {
      this.props.onRowsChange?.(rows, editedValues);
    } else {
      this.setState({ localRows: rows, localEditedValues: editedValues });
    }
  }

  private handleAddRow = (): void => {
    const { columns } = this.props;
    const newRow: WriteInRow = {
      _tempId: generateWriteInTempId(),
      _isWriteIn: true
    };

    const currentRows = this.getRows();
    const currentEditedValues = this.getEditedValues();
    
    // Initialize OptionSet fields with their default values from column metadata
    const initialEditedValues = initializeRowWithDefaults(columns);
    
    this.updateRowsAndValues(
      [...currentRows, newRow],
      { ...currentEditedValues, [newRow._tempId]: initialEditedValues }
    );
  };

  private handleRemoveRow = (tempId: string): void => {
    const currentRows = this.getRows();
    const currentEditedValues = this.getEditedValues();
    const { [tempId]: _, ...remainingEditedValues } = currentEditedValues;
    
    this.updateRowsAndValues(
      currentRows.filter(row => row._tempId !== tempId),
      remainingEditedValues
    );
  };

  /**
   * Handle field value changes and auto-save for staged rows
   */
  private handleFieldChange = (tempId: string, fieldName: string, value: FieldValue): void => {
    const currentRows = this.getRows();
    const currentEditedValues = this.getEditedValues();
    
    const updatedEditedValues = {
      ...currentEditedValues,
      [tempId]: {
        ...currentEditedValues[tempId],
        [fieldName]: value
      }
    };
    
    this.updateRowsAndValues(currentRows, updatedEditedValues);
    
    // Auto-save: If row is already staged, immediately update it
    const { stagedWriteInsById } = this.props;
    const staged = stagedWriteInsById[tempId];
    if (staged) {
      const row = currentRows.find(r => r._tempId === tempId);
      if (row) {
        // Trigger re-stage with updated values
        this.props.onStageProduct(row, updatedEditedValues[tempId], staged.id);
      }
    }
  };

  private handleStageClick = (row: WriteInRow, existingStagedId?: string): void => {
    const editedValues = this.getEditedValues()[row._tempId] || {};
    this.props.onStageProduct(row, editedValues, existingStagedId);
    // Row stays visible after staging - user can update or remove it
  };

  private renderCellValue = (row: WriteInRow, column: MergedColumnConfig): React.ReactNode => {
    const { currencySymbol, currencyCode, dataService, configService } = this.props;
    const currentEditedValues = this.getEditedValues();
    const editedValue = currentEditedValues[row._tempId]?.[column.logicalName];
    
    // Get value: prefer edited value, then row value
    const value = editedValue !== undefined ? editedValue : row[column.logicalName];

    // For write-in products, only check readOnly and editable (no related entity concept)
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
      onChange: (fieldName: string, newValue: FieldValue) => this.handleFieldChange(row._tempId, fieldName, newValue),
      onCellClick: (e: React.MouseEvent) => e.stopPropagation(),
      currencySymbol,
      maxLength: column.maxLength,
      onMaxLengthExceeded: column.maxLength ? (_fieldName: string) => {
        const fieldLabel = resolveColumnLabel(column, this.props.localizationService);
        const message = this.props.localizationService.getString('toast.maxLengthExceeded')
          .replace('{0}', fieldLabel)
          .replace('{1}', String(column.maxLength));
        this.props.onShowToast('warning', message);
      } : undefined
    };
    return renderEditableCell(editableProps);
  };

  render(): React.ReactElement {
    const { columns, isLoading, localizationService } = this.props;
    const rows = this.getRows();

    // Filter visible columns
    const visibleColumns = filterVisibleColumns(columns);

    if (isLoading) {
      return <LoadingSpinner labelText={localizationService.getString('general.loading')} />;
    }

    return (
      <div className="pag-writein-container">
        {rows.length === 0 ? (
          <>
            <EmptyStateMessage message={localizationService.getString('writeIn.emptyGrid')} />
            <div className="pag-writein-footer">
              <PrimaryButton
                text={localizationService.getString('actions.addRow')}
                iconProps={{ iconName: 'Add' }}
                onClick={this.handleAddRow}
                className="pag-writein-add-row"
              />
            </div>
          </>
        ) : (
          <>
            <style>{calculateColumnWidths(visibleColumns, ACTION_COLUMN_WIDTH, '.pag-writein-grid')}</style>
            <table className="pag-grid pag-writein-grid" role="table">
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
                {rows.map(row => {
                  const { stagedWriteInsById, onRemoveStaged } = this.props;
                  const staged = stagedWriteInsById[row._tempId];
                  const isStaged = Boolean(staged);
                  
                  // Write-in products don't have conditional fields
                  // Simple logic: staged = Remove, not staged = Add
                  const { action: buttonAction, labelKey: buttonLabelKey, icon: buttonIcon } = determineButtonAction(isStaged, false);

                  // Determine click handler based on action
                  let buttonOnClick: () => void;
                  if (buttonAction === 'remove') {
                    buttonOnClick = () => onRemoveStaged(staged.id);
                  } else {
                    buttonOnClick = () => this.handleStageClick(row);
                  }

                  return (
                    <tr
                      key={row._tempId}
                      className={`pag-grid-row pag-writein-row${isStaged ? ' staged' : ''}`}
                      role="row"
                    >
                      {visibleColumns.map((column, columnIndex) => (
                        <td
                          key={column.logicalName}
                          className="pag-grid-cell"
                          data-column-index={columnIndex}
                          role="gridcell"
                        >
                          {this.renderCellValue(row, column)}
                        </td>
                      ))}
                      <td className="pag-grid-cell pag-writein-actions" data-column-role="actions" role="gridcell">
                        <DefaultButton
                          text={localizationService.getString(buttonLabelKey)}
                          onClick={buttonOnClick}
                          iconProps={{ iconName: buttonIcon }}
                          styles={buttonAction === 'remove' ? BUTTON_STYLES.writeIn.remove : BUTTON_STYLES.writeIn.stage}
                        />
                        <IconButton
                          iconProps={{ iconName: 'Delete' }}
                          title={localizationService.getString('actions.removeRow')}
                          ariaLabel={localizationService.getString('actions.removeRow')}
                          onClick={() => this.handleRemoveRow(row._tempId)}
                          styles={BUTTON_STYLES.icon.delete}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="pag-writein-footer">
                <PrimaryButton
                  text={localizationService.getString('actions.addRow')}
                  iconProps={{ iconName: 'Add' }}
                  onClick={this.handleAddRow}
                  className="pag-writein-add-row"
                />
              </div>
          </>
        )}
      </div>
    );
  }
}

export default WriteInGrid;
