import * as React from 'react';
import { 
  PrimaryButton, 
  DefaultButton, 
  Stack, 
  TextField, 
  Dropdown, 
  IDropdownOption, 
  Label, 
  MessageBar, 
  MessageBarType,
  IconButton
} from '@fluentui/react';
import { VirtualTableRow, FieldValue, ConditionalFieldConfig, OptionSetMetadata } from '../types';
import { LocalizationService, ConfigService, DataService } from '../services';
import { LoadingSpinner } from '../utils/gridRenderUtils';

export interface IConditionalFieldsPanelProps {
  /** Whether the panel is open */
  isOpen: boolean;
  /** Product that triggered the panel */
  product: VirtualTableRow;
  /** Product code field name for display */
  productCodeField: string;
  /** Existing values for conditional fields (from previous edit or staging) */
  existingValues: Record<string, FieldValue>;
  /** Conditional field configurations */
  conditionalFields: ConditionalFieldConfig[];
  /** Localization service for string resolution */
  localizationService: LocalizationService;
  /** Config service for configuration access */
  configService: ConfigService;
  /** Data service for metadata fetching */
  dataService: DataService;
  /** Detail entity name for metadata lookups */
  detailEntity: string;
  /** Callback when user saves and stages the product */
  onSave: (values: Record<string, FieldValue>) => void;
  /** Callback when panel is dismissed without saving */
  onDismiss: () => void;
}

interface IConditionalFieldsPanelState {
  /** Current values for conditional fields */
  values: Record<string, FieldValue>;
  /** Fields with validation errors */
  validationErrors: Set<string>;
  /** Loaded field metadata (display names, options) */
  fieldMetadata: Map<string, OptionSetMetadata>;
  /** Whether metadata is being loaded */
  isLoadingMetadata: boolean;
}

/**
 * ConditionalFieldsPanel Component
 * 
 * Displays a slide-in panel with conditional fields that must be filled
 * before a product can be staged. Uses metadata fetching for proper
 * localized labels and OptionSet values.
 */
export class ConditionalFieldsPanel extends React.PureComponent<IConditionalFieldsPanelProps, IConditionalFieldsPanelState> {
  private _isMounted = false;
  
  constructor(props: IConditionalFieldsPanelProps) {
    super(props);
    
    // Initialize with existing values
    const values: Record<string, FieldValue> = {};
    props.conditionalFields.forEach(field => {
      values[field.logicalName] = props.existingValues[field.logicalName] ?? undefined;
    });
    
    this.state = {
      values,
      validationErrors: new Set(),
      fieldMetadata: new Map(),
      isLoadingMetadata: true
    };
  }

  componentDidMount(): void {
    this._isMounted = true;
    void this.loadFieldMetadata();
  }

  componentWillUnmount(): void {
    this._isMounted = false;
  }

  componentDidUpdate(prevProps: IConditionalFieldsPanelProps): void {
    // If panel opens with new product, reset values
    if (this.props.isOpen && !prevProps.isOpen) {
      const values: Record<string, FieldValue> = {};
      this.props.conditionalFields.forEach(field => {
        values[field.logicalName] = this.props.existingValues[field.logicalName] ?? undefined;
      });
      this.setState({ values, validationErrors: new Set() });
    }
  }

  /**
   * Load field metadata for conditional fields
   * Fetches display names and OptionSet options from Dataverse
   */
  private async loadFieldMetadata(): Promise<void> {
    const { conditionalFields, dataService, detailEntity } = this.props;
    
    this.setState({ isLoadingMetadata: true });
    
    const metadataMap = new Map<string, OptionSetMetadata>();
    
    // Load metadata for each conditional field in parallel
    const metadataPromises = conditionalFields.map(async (field) => {
      try {
        if (field.type === 'OptionSet') {
          // Fetch OptionSet metadata for dropdown options
          const metadata = await dataService.getOptionSetMetadata(detailEntity, field.logicalName);
          if (metadata) {
            return { logicalName: field.logicalName, metadata };
          }
        }
        return null;
      } catch (_error) {
        return null;
      }
    });

    const results = await Promise.all(metadataPromises);
    
    results.forEach(result => {
      if (result) {
        metadataMap.set(result.logicalName, result.metadata);
      }
    });
    
    
    if (!this._isMounted) return;
    this.setState({ 
      fieldMetadata: metadataMap,
      isLoadingMetadata: false 
    });
  }

  /**
   * Handle field value change
   */
  private handleFieldChange = (fieldName: string, value: FieldValue): void => {
    this.setState(prevState => ({
      values: { ...prevState.values, [fieldName]: value },
      // Clear validation error for this field when value changes
      validationErrors: new Set([...prevState.validationErrors].filter(f => f !== fieldName))
    }));
  };

  /**
   * Validate all required fields
   * @returns true if all required fields have valid values
   */
  private validateFields = (): boolean => {
    const { conditionalFields } = this.props;
    const { values } = this.state;
    const errors = new Set<string>();
    
    conditionalFields.forEach(field => {
      if (field.required) {
        const value = values[field.logicalName];
        
        if (value === undefined || value === null || value === '') {
          errors.add(field.logicalName);
        } else if (field.type === 'Integer') {
          const numValue = Number(value);
          if (isNaN(numValue) || numValue <= 0) {
            errors.add(field.logicalName);
          }
        } else if (field.type === 'Text' && typeof value === 'string' && value.trim() === '') {
          errors.add(field.logicalName);
        }
      }
    });
    
    this.setState({ validationErrors: errors });
    return errors.size === 0;
  };

  /**
   * Handle save button click
   * Validates fields and calls onSave if valid
   */
  private handleSave = (): void => {
    if (this.validateFields()) {
      this.props.onSave(this.state.values);
    }
  };

  /**
   * Resolve display label for a field
   * Priority: Metadata display name > Localized labelKey > Formatted logical name
   */
  private resolveFieldLabel(field: ConditionalFieldConfig): string {
    const { localizationService } = this.props;
    const { fieldMetadata } = this.state;
    
    // Try metadata display name first
    const metadata = fieldMetadata.get(field.logicalName);
    if (metadata?.displayName) {
      return metadata.displayName;
    }
    
    // Fall back to localization key
    const localizedLabel = localizationService.getString(field.labelKey);
    if (localizedLabel !== field.labelKey) {
      return localizedLabel;
    }
    
    // Last resort: format the logical name
    return field.logicalName
      .replace(/_/g, ' ')
      .replace(/\b\w/g, chr => chr.toUpperCase());
  }

  /**
   * Render a single conditional field based on its type
   */
  private renderField = (field: ConditionalFieldConfig): React.ReactNode => {
    const { localizationService } = this.props;
    const { values, validationErrors, fieldMetadata, isLoadingMetadata } = this.state;
    const value = values[field.logicalName];
    const hasError = validationErrors.has(field.logicalName);
    const label = this.resolveFieldLabel(field);
    const errorMessage = hasError ? localizationService.getString('msg.validation.required') : undefined;

    switch (field.type) {
      case 'OptionSet': {
        // Use metadata options if available, otherwise use config options
        const metadata = fieldMetadata.get(field.logicalName);
        const options: IDropdownOption[] = metadata?.options 
          ? metadata.options.map(opt => ({
              key: opt.value,
              text: opt.label
            }))
          : (field.options ?? []).map(opt => ({
              key: opt.value,
              text: opt.labelKey ? localizationService.getString(opt.labelKey) : (opt.label ?? String(opt.value))
            }));
        
        return (
          <Dropdown
            key={field.logicalName}
            label={label}
            required={field.required}
            disabled={isLoadingMetadata}
            options={options}
            selectedKey={typeof value === 'number' ? value : undefined}
            placeholder={localizationService.getString('placeholder.selectOption')}
            onChange={(_, option) => this.handleFieldChange(field.logicalName, option ? Number(option.key) : undefined)}
            errorMessage={errorMessage}
            styles={{ root: { marginBottom: 16 } }}
          />
        );
      }

      case 'Integer':
        return (
          <TextField
            key={field.logicalName}
            label={label}
            required={field.required}
            disabled={isLoadingMetadata}
            type="number"
            min={1}
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(_, newValue) => this.handleFieldChange(
              field.logicalName, 
              newValue ? parseInt(newValue, 10) : undefined
            )}
            errorMessage={errorMessage}
            styles={{ root: { marginBottom: 16 } }}
          />
        );

      case 'Text':
      default:
        return (
          <TextField
            key={field.logicalName}
            label={label}
            required={field.required}
            disabled={isLoadingMetadata}
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(_, newValue) => this.handleFieldChange(field.logicalName, newValue)}
            errorMessage={errorMessage}
            styles={{ root: { marginBottom: 16 } }}
          />
        );
    }
  };

  render(): React.ReactNode {
    const { 
      isOpen, 
      product, 
      productCodeField, 
      conditionalFields, 
      localizationService, 
      onDismiss 
    } = this.props;
    const { validationErrors, isLoadingMetadata } = this.state;
    
    const productCode = product[productCodeField] as string | undefined;
    const productName = product.name;

    if (!isOpen) {
      return null;
    }

    return (
      <>
        {/* Backdrop overlay */}
        <div className="pag-conditional-backdrop" onClick={onDismiss} />
        
        {/* Slide-in panel */}
        <div className="pag-conditional-panel">
          {/* Header */}
          <div className="pag-conditional-header">
            <div className="pag-conditional-title">
              {localizationService.getString('panel.conditionalFields.title')}
            </div>
            <IconButton
              iconProps={{ iconName: 'Cancel' }}
              ariaLabel={localizationService.getString('actions.cancel')}
              onClick={onDismiss}
              styles={{
                root: {
                  color: '#605e5c'
                }
              }}
            />
          </div>

          {/* Content area with scroll */}
          <div className="pag-conditional-content">
            <Stack tokens={{ childrenGap: 16 }}>
              {isLoadingMetadata && (
                <LoadingSpinner labelText={localizationService.getString('status.loadingMetadata')} />
              )}
          
          <MessageBar messageBarType={MessageBarType.info}>
            {localizationService.getString('panel.conditionalFields.description')}
          </MessageBar>

          {/* Product info display */}
          <Stack tokens={{ childrenGap: 4 }}>
            <Label>{localizationService.getString('col.product')}</Label>
            <div className="pag-conditional-product-info">
              <div className="pag-conditional-product-name">{productName}</div>
              {productCode && (
                <div className="pag-conditional-product-code">
                  {productCode}
                </div>
              )}
            </div>
          </Stack>

          {/* Conditional fields */}
          <Stack>
            {conditionalFields.map(field => this.renderField(field))}
          </Stack>

              {/* Validation error summary */}
              {validationErrors.size > 0 && (
                <MessageBar messageBarType={MessageBarType.error}>
                  {localizationService.getString('toast.validationError')}
                </MessageBar>
              )}
            </Stack>
          </div>

          {/* Footer */}
          <div className="pag-conditional-footer">
            <Stack horizontal tokens={{ childrenGap: 8 }}>
              <PrimaryButton 
                text={localizationService.getString('actions.saveAndStage')}
                onClick={this.handleSave}
                disabled={isLoadingMetadata}
              />
              <DefaultButton 
                text={localizationService.getString('actions.cancel')}
                onClick={onDismiss}
              />
            </Stack>
          </div>
        </div>
      </>
    );
  }
}
