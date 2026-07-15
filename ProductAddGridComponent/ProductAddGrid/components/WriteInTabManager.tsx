import * as React from 'react';
import { BaseTabManager } from './BaseTabManager';
import {
  WriteInRow,
  MergedColumnConfig,
  FieldValue,
  StagedProduct,
  ViewMetadata,
  WriteInViewConfig
} from '../types';
import { DataService, ConfigService, LocalizationService, LoggerService } from '../services';
import { WriteInGrid } from './WriteInGrid';
import { generateWriteInTempId } from '../utils/idGenerator';
import { initializeRowWithDefaults } from '../utils/gridUtils';

/**
 * Props for WriteInTabManager
 */
export interface IWriteInTabManagerProps {
  parentEntityName: string;
  dataService: DataService;
  configService: ConfigService;
  localizationService: LocalizationService;

  // Currency
  currencyCode?: string;
  currencySymbol?: string;

  // From context
  writeInRows: WriteInRow[];
  writeInEditedValues: Record<string, Record<string, FieldValue>>;
  stagedWriteInsById: Record<string, StagedProduct>;
  onStageWriteIn: (
    row: WriteInRow,
    editedValues: Record<string, FieldValue>,
    stagedId?: string
  ) => void;
  onUpdateRows: (
    rows: WriteInRow[],
    editedValues: Record<string, Record<string, FieldValue>>
  ) => void;
  onRemoveStaged: (stagedId: string) => void;
  onShowToast: (type: 'success' | 'error' | 'warning' | 'info', message: string) => void;
}

/**
 * State for WriteInTabManager
 */
interface IWriteInTabManagerState {
  writeInViewMetadata?: ViewMetadata;
  writeInColumns: MergedColumnConfig[];
  writeInViewConfig?: WriteInViewConfig;
  isLoading: boolean;
}

/**
 * WriteInTabManager - Manages the write-in products tab
 * Handles write-in view metadata loading, grid rendering, and row management
 */
export class WriteInTabManager extends BaseTabManager<
  IWriteInTabManagerProps,
  IWriteInTabManagerState
> {

  constructor(props: IWriteInTabManagerProps) {
    super(props);

    const writeInViewConfig = this.props.configService.getWriteInViewConfig(
      this.props.parentEntityName
    );

    this.state = {
      writeInViewMetadata: undefined,
      writeInColumns: [],
      writeInViewConfig: writeInViewConfig ?? undefined,
      isLoading: true
    };
  }

  protected async onMount(): Promise<void> {
    await this.loadWriteInViewMetadata();
  }

  componentDidUpdate(
    _prevProps: IWriteInTabManagerProps,
    prevState: IWriteInTabManagerState
  ): void {
    // Auto-add first row after columns are loaded (if no rows exist)
    if (
      prevState.writeInColumns.length === 0 &&
      this.state.writeInColumns.length > 0 &&
      this.props.writeInRows.length === 0
    ) {
      this.addInitialRow();
    }
  }

  /**
   * Add initial write-in row with default values
   */
  private addInitialRow = (): void => {
    const newRow: WriteInRow = {
      _tempId: generateWriteInTempId(),
      _isWriteIn: true
    };

    // Initialize OptionSet fields with their default values from column metadata
    const initialEditedValues = initializeRowWithDefaults(this.state.writeInColumns);

    if (!this.isMounted) return;

    // Create new rows and editedValues
    const rows = [newRow];
    const editedValues = {
      [newRow._tempId]: initialEditedValues
    };

    this.props.onUpdateRows(rows, editedValues);
  };

  /**
   * Load write-in view metadata from Dataverse
   */
  private loadWriteInViewMetadata = async (): Promise<void> => {
    const writeInViewConfig = this.props.configService.getWriteInViewConfig(
      this.props.parentEntityName
    );

    if (!writeInViewConfig) {
      this.setState({ isLoading: false });
      return;
    }

    const { savedQueryId, columns: columnOverrides } = writeInViewConfig;
    const detailEntityName = this.props.configService.getDetailEntityName(
      this.props.parentEntityName
    );

    if (!detailEntityName) {
      LoggerService.error('No detail entity found for parent entity', {
        parentEntityName: this.props.parentEntityName
      });
      this.setState({ isLoading: false });
      return;
    }

    // Check for valid savedQueryId
    const hasValidSavedQueryId =
      savedQueryId && savedQueryId !== '00000000-0000-0000-0000-000000000000';


    try {
      if (hasValidSavedQueryId) {
        // Fetch view metadata from Dataverse
        const viewMetadata = await this.props.dataService.getViewMetadata(
          savedQueryId,
          detailEntityName
        );

        if (viewMetadata) {

          // Create column config from view metadata with overrides
          const priorityColumns = this.props.configService.getPriorityColumns();
          const columns = await this.props.dataService.createViewBasedColumnConfig(
            viewMetadata,
            columnOverrides ?? [],
            [], // No product columns for write-in
            false, // Not a product detail view
            true, // Is write-in view - columns editable by default
            priorityColumns
          );


          if (!this.isMounted) return;

          this.setState(
            {
              writeInViewMetadata: viewMetadata,
              writeInColumns: columns,
              writeInViewConfig,
              isLoading: false
            },
            () => {
              // Auto-add first row after columns are loaded
              if (this.props.writeInRows.length === 0) {
                this.addInitialRow();
              }
            }
          );
          return;
        }

      }

      // Fallback: use columns from config directly
      const fallbackColumns: MergedColumnConfig[] = (columnOverrides ?? []).map(
        col => ({
          logicalName: col.logicalName,
          labelKey: col.labelKey,
          displayName: col.labelKey ? undefined : col.logicalName,
          readOnly: col.readOnly ?? false,
          required: col.required ?? false,
          width: col.width ?? 150,
          type: col.type ?? 'Text',
          fromView: false,
          isValidForRead: true,
          isValidForCreate: true,
          isValidForUpdate: true,
          editable: col.editable ?? true,
          hidden: col.hidden ?? false,
          maxLength: col.maxLength
        })
      );

      if (!this.isMounted) return;

      this.setState(
        {
          writeInViewMetadata: undefined,
          writeInColumns: fallbackColumns,
          writeInViewConfig,
          isLoading: false
        },
        () => {
          // Auto-add first row after columns are loaded
          if (this.props.writeInRows.length === 0) {
            this.addInitialRow();
          }
        }
      );
    } catch (error) {
      LoggerService.error('Error loading write-in view metadata:', error);
      if (!this.isMounted) return;
      this.setState({ isLoading: false });
    }
  };

  /**
   * Handle rows and edited values change from WriteInGrid
   */
  private handleRowsChange = (
    rows: WriteInRow[],
    editedValues: Record<string, Record<string, FieldValue>>
  ): void => {
    this.props.onUpdateRows(rows, editedValues);
  };

  render(): React.ReactElement {
    const { writeInColumns, isLoading } = this.state;
    const {
      writeInRows,
      writeInEditedValues,
      stagedWriteInsById,
      currencyCode,
      currencySymbol,
      localizationService,
      dataService,
      configService,
      onStageWriteIn,
      onRemoveStaged,
      onShowToast
    } = this.props;

    return (
      <div className="pag-content pag-content-writein">
        <WriteInGrid
          columns={writeInColumns}
          onStageProduct={onStageWriteIn}
          onRemoveStaged={onRemoveStaged}
          isLoading={isLoading}
          localizationService={localizationService}
          dataService={dataService}
          configService={configService}
          currencyCode={currencyCode}
          currencySymbol={currencySymbol}
          stagedWriteInsById={stagedWriteInsById}
          rows={writeInRows}
          editedValues={writeInEditedValues}
          onRowsChange={this.handleRowsChange}
          onShowToast={onShowToast}
        />
      </div>
    );
  }
}
