import * as React from 'react';
import { ThemeProvider, PrimaryButton, DefaultButton, Stack, Pivot, PivotItem, Dialog, DialogType, DialogFooter } from '@fluentui/react';
import { ProductAddGridTheme } from '../theme/FluentTheme';
import { FluentTokens } from '../theme/FluentTokens';
import {
  Toast,
  EntityConfig,
  ParentRecord,
  ViewMetadata,
  ViewConfig,
  MergedColumnConfig,
  ActiveTab,
  ConditionalFieldsPanelState,
  FieldValue,
  VirtualTableRow,
  GlobalNotification
} from '../types';
import { DataService, LocalizationService, ConfigService, LoggerService } from '../services';
import { useStagingContext } from '../contexts/StagingContext';
import { CatalogTabManager } from './CatalogTabManager';
import { WriteInTabManager } from './WriteInTabManager';
import { ProductRequestsManager } from './ProductRequestsManager';
import { ConditionalFieldsPanel } from './ConditionalFieldsPanel';
import { ToastContainer } from './ToastContainer';
import { validateRequiredFields } from '../utils/gridUtils';
import { extractErrorMessage } from '../utils/errorUtils';
import { LoadingSpinner } from '../utils/gridRenderUtils';

/**
 * Props interface for ProductAddGridContainer
 */
export interface IProductAddGridContainerProps {
  context: ComponentFramework.Context<unknown>;
  parentEntityName: string;
  parentRecordId: string;
  displayMode?: string;
  allocatedWidth?: number;
  allocatedHeight?: number;
  parentVariantKey?: string;
  stockCheckEnabled?: boolean; // Runtime override: false disables all stock checks regardless of config
  configServiceInstance?: ConfigService; // Optional - passed from wrapper
  onDataChanged?: (data: unknown[]) => void;
  onDialogClose?: () => void;
}

/**
 * State interface for ProductAddGridContainer
 */
interface IProductAddGridContainerState {
  // Active tab
  activeTab: ActiveTab;

  // Loading states
  isLoading: boolean;
  isSaving: boolean;

  // Parent data
  parentRecord?: ParentRecord;
  entityConfig?: EntityConfig;
  currencyCode?: string;
  currencySymbol?: string;

  // View metadata
  viewMetadata?: ViewMetadata;
  viewConfig?: ViewConfig;
  mergedColumns: MergedColumnConfig[];
  isProductDetailView: boolean;

  // Toast notifications
  toasts: Toast[];

  // Conditional fields panel
  conditionalFieldsPanel: ConditionalFieldsPanelState | null;

  // Confirmation dialogs
  showClearConfirmDialog: boolean;

  // Initial catalog load tracking (for unified loading state)
  hasCatalogLoadedInitially: boolean;

  // Tab enable flags
  writeInEnabled: boolean;
  productRequestEnabled: boolean;

  // Staged count from ProductRequestsManager (its rows live outside StagingContext)
  productRequestsStagedCount: number;
}

/**
 * Reservation Logo-batching constants. The reservation is the only Logo-bound parent entity, so its
 * batched-add behavior keys off these three schema names. Single-sourced here rather than scattered
 * as inline literals across the save flow.
 */
const RESERVATION_PARENT_ENTITY = 'crcad_reservationrecord';
const FIELD_LOGO_CODE = 'emd_logocode';
const FIELD_SKIP_LOGO_PUSH = 'emd_skiplogopush';

/**
 * ProductAddGridContainer - Main orchestrator component
 * Handles initialization, tab management, saving, and coordination
 */
class ProductAddGridContainerComponent extends React.PureComponent<
  IProductAddGridContainerProps & { stagingContext: ReturnType<typeof useStagingContext> },
  IProductAddGridContainerState
> {
  private dataService: DataService;
  private localizationService: LocalizationService;
  private configService: ConfigService;
  private containerRef = React.createRef<HTMLDivElement>();
  private productRequestsManagerRef = React.createRef<ProductRequestsManager>();
  private isMounted = false;

  constructor(props: IProductAddGridContainerProps & { stagingContext: ReturnType<typeof useStagingContext> }) {
    super(props);

    this.localizationService = new LocalizationService(props.context);
    
    // Use configServiceInstance if provided (from wrapper), otherwise create new one
    if (props.configServiceInstance) {
      this.configService = props.configServiceInstance;
    } else {
      this.configService = new ConfigService();
      this.configService.setLocalizationService(this.localizationService);
      this.configService.initializeVariant(props.parentEntityName, props.parentVariantKey, { stockCheckEnabled: props.stockCheckEnabled });
    }

    // Initialize DataService with ConfigService for product sort config access
    this.dataService = new DataService(props.context, this.configService);

    const entityConfig = this.configService.getEntityConfig(props.parentEntityName);
    const viewConfig = this.configService.getViewConfigForEntity(props.parentEntityName);
    const isProductDetailView = this.configService.isProductDetailView(props.parentEntityName);
    const writeInEnabled = this.configService.isWriteInEnabled(props.parentEntityName);
    const productRequestEnabled = this.configService.isProductRequestEnabled(props.parentEntityName);

    this.state = {
      activeTab: 'catalog',
      isLoading: true,
      isSaving: false,
      parentRecord: undefined,
      entityConfig,
      currencyCode: undefined,
      currencySymbol: undefined,
      viewMetadata: undefined,
      viewConfig,
      mergedColumns: [],
      isProductDetailView,
      toasts: [],
      conditionalFieldsPanel: null,
      showClearConfirmDialog: false,
      hasCatalogLoadedInitially: false,
      writeInEnabled,
      productRequestEnabled,
      productRequestsStagedCount: 0
    };
  }

  componentDidMount(): void {
    this.isMounted = true;
    this.updateCssCustomProperties();

    // Initialize staging persistence (with variant support for entity variants)
    this.props.stagingContext.initializePersistence(
      this.props.parentEntityName,
      this.props.parentRecordId,
      this.props.parentVariantKey
    );

    // Initialize component
    void this.initializeComponent();
  }

  componentWillUnmount(): void {
    this.isMounted = false;
  }

  componentDidUpdate(prevProps: IProductAddGridContainerProps & { stagingContext: ReturnType<typeof useStagingContext> }): void {
    if (
      prevProps.allocatedWidth !== this.props.allocatedWidth ||
      prevProps.allocatedHeight !== this.props.allocatedHeight
    ) {
      this.updateCssCustomProperties();
    }
  }

  /**
   * Update CSS custom properties for dynamic sizing
   */
  private updateCssCustomProperties = (): void => {
    const { allocatedWidth, allocatedHeight } = this.props;
    const container = this.containerRef.current;

    if (!container) return;

    if (allocatedWidth && allocatedWidth > 0) {
      container.style.setProperty('--pcf-width', `${allocatedWidth}px`);
    } else {
      container.style.removeProperty('--pcf-width');
    }

    if (allocatedHeight && allocatedHeight > 0) {
      container.style.setProperty('--pcf-height', `${allocatedHeight}px`);
    } else {
      container.style.removeProperty('--pcf-height');
    }
  };

  /**
   * Initialize component - load parent record and view metadata
   */
  private initializeComponent = async (): Promise<void> => {
    if (!this.isMounted) return;
    this.setState({ isLoading: true });

    try {
      const hasCurrency = this.configService.hasCurrency(this.props.parentEntityName);

      // For Logo-bound reservations, also fetch emd_logocode so the save flow knows whether to
      // batch-push the added lines to Logo (bound) or skip it entirely (draft).
      const extraSelect = this.isReservationParent() ? [FIELD_LOGO_CODE] : undefined;

      // Load parent record
      const parentRecord = await this.dataService.getParentRecord(
        this.props.parentEntityName,
        this.props.parentRecordId,
        hasCurrency,
        extraSelect
      );

      let currencyCode: string | undefined;
      let currencySymbol: string | undefined;


      if (parentRecord.transactionCurrencyId) {
        try {
          const currencyInfo = await this.dataService.getCurrencyInfo(
            parentRecord.transactionCurrencyId
          );
          if (currencyInfo) {
            const typedCurrencyInfo = currencyInfo as ComponentFramework.WebApi.Entity & {
              isocurrencycode?: string;
              currencysymbol?: string;
            };

            if (typedCurrencyInfo.isocurrencycode) {
              currencyCode = typedCurrencyInfo.isocurrencycode.toUpperCase();
            }

            if (typedCurrencyInfo.currencysymbol) {
              currencySymbol = typedCurrencyInfo.currencysymbol;
            }
          }
        } catch (currencyError) {
          LoggerService.warn('Failed to load currency info:', currencyError);
        }
      }


      if (!this.isMounted) return;

      this.setState({
        parentRecord: {
          ...parentRecord,
          transactionCurrencyCode: currencyCode,
          transactionCurrencySymbol: currencySymbol
        },
        currencyCode,
        currencySymbol
      });

      // Load view metadata
      await this.loadViewMetadata();

      // Restore persisted staging state
      await this.restorePersistedStaging();

      if (!this.isMounted) return;
      this.setState({ isLoading: false });
    } catch (error) {
      LoggerService.error('Error initializing component:', error);
      this.showToast('error', this.localizationService.getString('toast.savedError'));
      if (!this.isMounted) return;
      this.setState({ isLoading: false });
    }
  };

  /**
   * Load view metadata
   */
  private loadViewMetadata = async (): Promise<void> => {
    try {
      const viewConfig =
        this.state.viewConfig ?? this.configService.getViewConfigForEntity(this.props.parentEntityName);
      const savedQueryId = viewConfig.savedQueryId;
      const shouldSync = savedQueryId !== '00000000-0000-0000-0000-000000000000';

      const applyHiddenColumns = (columns: MergedColumnConfig[]): MergedColumnConfig[] => {
        return columns.map(col => ({
          ...col,
          hidden: col.hidden || this.configService.isColumnHidden(col.logicalName)
        }));
      };

      const buildFallbackColumns = async (): Promise<MergedColumnConfig[]> => {
        const emptyMetadata: ViewMetadata = {
          savedQueryId,
          name: viewConfig.name,
          columns: []
        };
        const productColumns = this.configService.getProductColumnsForEntity(
          this.props.parentEntityName
        );
        const isProductDetailView = viewConfig.isProductDetailView ?? false;
        const priorityColumns = this.configService.getPriorityColumns();
        const mergedColumnConfig = this.configService.getMergedColumnsForEntity(
          this.props.parentEntityName
        );
        const columns = await this.dataService.createViewBasedColumnConfig(
          emptyMetadata,
          mergedColumnConfig,
          productColumns,
          isProductDetailView,
          false,
          priorityColumns
        );
        return applyHiddenColumns(columns);
      };

      if (shouldSync) {
        const viewEntityName = this.state.isProductDetailView
          ? this.configService.getDetailEntityName(this.props.parentEntityName) ?? 'product'
          : 'product';

        try {
          const viewMetadata = await this.dataService.getViewMetadata(
            savedQueryId,
            viewEntityName
          );

          if (viewMetadata) {
            const productColumns = this.configService.getProductColumnsForEntity(
              this.props.parentEntityName
            );
            const isProductDetailView = viewConfig.isProductDetailView ?? false;
            const priorityColumns = this.configService.getPriorityColumns();
            const mergedColumnConfig = this.configService.getMergedColumnsForEntity(
              this.props.parentEntityName
            );
            const columns = await this.dataService.createViewBasedColumnConfig(
              viewMetadata,
              mergedColumnConfig,
              productColumns,
              isProductDetailView,
              false,
              priorityColumns
            );
            const mergedColumns = applyHiddenColumns(columns);

            if (!this.isMounted) return;
            this.setState({
              viewMetadata,
              mergedColumns,
              viewConfig,
              isProductDetailView: viewConfig.isProductDetailView ?? false
            });
            return;
          }
        } catch (metadataError) {
          LoggerService.error('Error loading view metadata:', metadataError);
        }
      }

      const fallbackColumns = await buildFallbackColumns();
      if (!this.isMounted) return;
      this.setState({
        mergedColumns: fallbackColumns,
        viewMetadata: undefined,
        viewConfig,
        isProductDetailView: viewConfig.isProductDetailView ?? false
      });
    } catch (error) {
      LoggerService.error('Error loading view metadata:', error);
    }
  };

  /**
   * Restore persisted staging state
   */
  private restorePersistedStaging = async (): Promise<void> => {
    const getStockFn = this.configService.shouldValidateStockBeforeSave(
      this.props.parentEntityName
    )
      ? async (productIds: string[]) => {
          return this.dataService.getProductsAvailableStock(productIds);
        }
      : undefined;

    const result = await this.props.stagingContext.restoreFromStorage(getStockFn);

    if (result.restored) {
      if (result.hasAdjustments && result.hasRemovals) {
        this.showToast(
          'info',
          this.localizationService.getString(
            'staging.restoredWithBoth',
            result.adjustmentCount,
            result.removalCount
          ),
          'top-left'
        );
      } else if (result.hasAdjustments) {
        this.showToast(
          'info',
          this.localizationService.getString(
            'staging.restoredWithAdjustments',
            result.adjustmentCount
          ),
          'top-left'
        );
      } else if (result.hasRemovals) {
        this.showToast(
          'info',
          this.localizationService.getString(
            'staging.restoredWithRemovals',
            result.removalCount
          ),
          'top-left'
        );
      } else {
        this.showToast(
          'info',
          this.localizationService.getString('staging.restored', result.totalRestored),
          'top-left'
        );
      }
    } else if (result.hasRemovals && result.removalCount > 0) {
      this.showToast('warning', this.localizationService.getString('staging.allInvalid'), 'top-left');
    }
  };

  /**
   * Handle tab change
   */
  private handleTabChange = (item?: PivotItem): void => {
    const newTab = (item?.props.itemKey as ActiveTab) ?? 'catalog';
    this.setState({ activeTab: newTab });
  };

  /**
   * Handle staging a product with conditional fields check
   * @param skipConditionalCheck - If true, skip conditional fields check (e.g., for auto-save during inline edits)
   */
  private handleStageProduct = (
    virtualRow: VirtualTableRow,
    editedValues?: Record<string, FieldValue>,
    existingStagedId?: string,
    skipConditionalCheck = false
  ): void => {
    const productId = virtualRow.productid;
    const { stagedProductsById } = this.props.stagingContext;
    const existingStaged = stagedProductsById[productId];
    
    // If updating an existing staged product, merge new edits with existing editedFields
    // This ensures validation sees ALL field values, not just the newly edited ones
    let finalEditedValues = editedValues ?? {};
    if (existingStagedId && existingStaged?.editedFields) {
      finalEditedValues = { ...existingStaged.editedFields, ...editedValues };
    }
    
    // Validation (use merged values)
    const missingFields = validateRequiredFields(
      this.state.mergedColumns,
      finalEditedValues,
      this.localizationService
    );

    if (missingFields.length > 0) {
      const errorMessage = this.localizationService.getString(
        'msg.validation.requiredFields',
        missingFields.join(', ')
      );
      this.showToast('error', errorMessage);
      return;
    }

    // Check for conditional fields (skip if this is an auto-save during inline editing)
    if (
      !skipConditionalCheck &&
      this.configService.productRequiresConditionalFields(
        virtualRow,
        this.props.parentEntityName
      )
    ) {
      const conditionalConfig = this.configService.getConditionalFieldsConfig(
        this.props.parentEntityName
      );

      if (conditionalConfig) {
        // Idempotent: if the panel is already open for this product, don't re-open it.
        // Auto-stage fires per-keystroke while the row is still un-staged (panel pending),
        // so re-entering here would reset the user's in-progress conditional values.
        const openPanel = this.state.conditionalFieldsPanel;
        if (openPanel?.isOpen && openPanel.product?.productid === productId) {
          return;
        }

        // Use merged values for conditional panel initialization
        const initialConditionalValues = finalEditedValues;


        this.setState({
          conditionalFieldsPanel: {
            isOpen: true,
            product: virtualRow,
            editedValues: finalEditedValues,
            existingStagedId,
            conditionalValues: initialConditionalValues
          }
        });
        return;
      }
    }

    // Stage product directly (use merged values)
    this.props.stagingContext.stageProduct(
      virtualRow,
      finalEditedValues,
      existingStagedId
    );
    this.notifyDataChanged();
  };

  /**
   * Handle conditional fields save
   */
  private handleConditionalFieldsSave = (conditionalValues: Record<string, FieldValue>): void => {
    const panelState = this.state.conditionalFieldsPanel;
    if (!panelState?.product) {
      return;
    }


    const mergedEditedValues: Record<string, FieldValue> = {
      ...panelState.editedValues,
      ...conditionalValues
    };

    this.setState({ conditionalFieldsPanel: null }, () => {
      this.props.stagingContext.stageProduct(
        panelState.product!,
        mergedEditedValues,
        panelState.existingStagedId
      );
      this.notifyDataChanged();
    });
  };

  /**
   * Handle conditional fields dismiss
   */
  private handleConditionalFieldsDismiss = (): void => {
    this.setState({ conditionalFieldsPanel: null });
  };

  /**
   * Callback when CatalogTabManager completes initial product load
   * Unified loading state: container waits for initial products before showing tabs
   */
  private handleCatalogInitialLoadComplete = (): void => {
    if (!this.isMounted) return;
    this.setState({ hasCatalogLoadedInitially: true });
  };

  /**
   * Set localStorage flag indicating a successful save occurred.
   * The calling JS web resource checks this flag to decide whether to refresh the subgrid.
   */
  private setSavedFlag(): void {
    try {
      const key = `productaddgrid_saved_${this.props.parentRecordId}`;
      localStorage.setItem(key, Date.now().toString());
    } catch (_error) {
      // localStorage unavailable
    }
  }

  /**
   * Store pre-localized notification payloads for the calling JS to display
   * via Xrm.App.addGlobalNotification after the dialog closes.
   */
  private setSaveNotifications(notifications: GlobalNotification[]): void {
    try {
      const key = `productaddgrid_notifications_${this.props.parentRecordId}`;
      localStorage.setItem(key, JSON.stringify(notifications));
    } catch (_error) {
      // localStorage unavailable
    }
  }

  /**
   * Signal the JS bridge to unhide a tab after successful product request save.
   * @param tabName - Name of the tab to unhide (e.g., 'price_request_tab')
   */
  private setTabVisibilityFlag(tabName: string): void {
    try {
      const key = `productaddgrid_showtab_${this.props.parentRecordId}`;
      localStorage.setItem(key, tabName);
    } catch (_error) {
      // localStorage unavailable
    }
  }

  /**
   * Build pre-localized save notification payloads
   */
  private buildSaveNotifications(savedCount: number, skippedDuplicates: number): GlobalNotification[] {
    const notifications: GlobalNotification[] = [];
    if (skippedDuplicates > 0) {
      if (savedCount > 0) {
        notifications.push({
          message: this.localizationService.getString('notification.savedSuccess', savedCount),
          level: 1,
          duration: 10000
        });
      }
      notifications.push({
        message: this.localizationService.getString('notification.duplicatesSkipped', skippedDuplicates),
        level: 2,
        duration: 20000
      });
    } else {
      notifications.push({
        message: this.localizationService.getString('notification.savedSuccess', savedCount),
        level: 1,
        duration: 10000
      });
    }
    return notifications;
  }

  /**
   * Handle save all
   */
  private handleSaveAll = async (): Promise<void> => {
    const {
      stagedProducts
    } = this.props.stagingContext;

    // Determine what needs to be saved
    const hasRegularProducts = stagedProducts.length > 0;
    const hasProductRequests = this.state.productRequestsStagedCount > 0;

    if (!hasRegularProducts && !hasProductRequests) {
      return;
    }

    this.setState({ isSaving: true });

    try {
      // Stock validation before save (for entities that require it)
      if (hasRegularProducts) {
        const stockValid = await this.validateStockBeforeSave();
        if (!stockValid) {
          this.setState({ isSaving: false });
          return;
        }
      }

      // Save regular products
      let savedCount = 0;
      let skippedDuplicates = 0;
      if (hasRegularProducts) {
        ({ savedCount, skippedDuplicates } = await this.saveRegularProducts());
      }

      // Submit product requests
      if (hasProductRequests && this.productRequestsManagerRef.current) {
        const prResult: { apiSuccess: boolean; apiMessage?: string } = await this.productRequestsManagerRef.current.submitProductRequests();
        // Product requests clears its own state
        // Also clear regular staging if any regular products were saved alongside
        if (hasRegularProducts) {
          this.props.stagingContext.clearAllStaging();
          this.notifyDataChanged();
        }
        this.setState({ isSaving: false, productRequestsStagedCount: 0 });

        // Build pre-localized notifications for the JS to display after dialog closes
        const notifications: GlobalNotification[] = [];
        if (hasRegularProducts) {
          notifications.push(...this.buildSaveNotifications(savedCount, skippedDuplicates));
        }
        // Product request result notification
        if (prResult.apiMessage) {
          notifications.push({
            message: this.localizationService.getString('notification.customApiMessage', prResult.apiMessage),
            level: prResult.apiSuccess ? 1 : 3, // success : error
            duration: prResult.apiSuccess ? 10000 : 20000
          });
        } else {
          const key = prResult.apiSuccess ? 'notification.requestSubmitted' : 'notification.requestApiError';
          notifications.push({
            message: this.localizationService.getString(key),
            level: prResult.apiSuccess ? 1 : 3, // success : error
            duration: prResult.apiSuccess ? 10000 : 20000
          });
        }
        this.setSaveNotifications(notifications);
        this.setSavedFlag();
        // Signal JS to unhide price request tab after successful save
        if (prResult.apiSuccess) {
          this.setTabVisibilityFlag(this.configService.getTabVisibilityFlagName() ?? 'price_request_tab');
        }
        if (this.props.onDialogClose) {
          this.props.onDialogClose();
        }
        return;
      }

      // Clear staging and close if regular products only
      if (hasRegularProducts) {
        this.props.stagingContext.clearAllStaging();
        this.setState({ isSaving: false });
        this.notifyDataChanged();
        
        const notifications: GlobalNotification[] = [];
        notifications.push(...this.buildSaveNotifications(savedCount, skippedDuplicates));
        
        this.setSaveNotifications(notifications);
        this.setSavedFlag();
        if (this.props.onDialogClose) {
          this.props.onDialogClose();
        }
      }
    } catch (error) {
      LoggerService.error('Error saving:', error);
      this.setState({ isSaving: false });
      const errorMsg = extractErrorMessage(error);
      this.showToast('error', this.localizationService.getString('notification.savedError', errorMsg));
      this.setSaveNotifications([{ 
        message: this.localizationService.getString('notification.savedError', errorMsg),
        level: 3, // error
        duration: 20000
      }]);
    }
  };

  /**
   * Validate stock availability before saving catalog products.
   * Only runs for entities with validateStockBeforeSave: true in config.
   * Returns false (and shows a toast) if any product's staged quantity exceeds available stock.
   */
  private validateStockBeforeSave = async (): Promise<boolean> => {
    if (!this.configService.shouldValidateStockBeforeSave(this.props.parentEntityName)) {
      return true;
    }

    const { stagedProducts } = this.props.stagingContext;
    const catalogProducts = stagedProducts.filter(sp => !sp.isWriteIn && sp.productId);

    if (catalogProducts.length === 0) {
      return true;
    }

    try {
      const productIds = catalogProducts.map(sp => sp.productId);
      const stockMap = await this.dataService.getProductsAvailableStock(productIds);
      const productCodeField = this.configService.getProductCodeField();

      for (const staged of catalogProducts) {
        const currentStock = stockMap.get(staged.productId) ?? 0;
        const stagedQuantity = Number(staged.quantity ?? 0);

        if (stagedQuantity > currentStock) {
          const productCode =
            (staged.product?.[productCodeField] as string | undefined) ?? staged.productId;
          const errorMessage = this.localizationService
            .getString('toast.stockQuantityExceeded')
            .replace('{0}', productCode);
          this.showToast('error', errorMessage);
          return false;
        }
      }
    } catch (error) {
      LoggerService.warn('Stock validation check failed, proceeding with save:', error);
    }

    return true;
  };

  /**
   * Save regular products
   */
  private saveRegularProducts = async (): Promise<{ savedCount: number; skippedDuplicates: number }> => {
    const { stagedProducts } = this.props.stagingContext;
    const { parentRecord, entityConfig, viewMetadata } = this.state;

    if (!entityConfig || !parentRecord || !viewMetadata) {
      throw new Error('Missing configuration for saving');
    }

    const isDevelopment = ConfigService.isDevelopment();
    const uomId = this.configService.getDefaultUomId(isDevelopment);
    const systemFields = this.configService.getSystemFields(this.props.parentEntityName);
    const productFieldMappings = this.configService.getProductFieldMappings(
      this.props.parentEntityName
    );
    const conditionalFieldsConfig = this.configService.getConditionalFieldsConfig(
      this.props.parentEntityName
    );

    if (!systemFields) {
      throw new Error(`System fields not configured for entity '${this.props.parentEntityName}'`);
    }

    // Duplicate product detection (catalog products only)
    let productsToSave = stagedProducts;
    let skippedDuplicates = 0;

    if (entityConfig.preventDuplicateProducts === true) {
      
      // Ensure required system fields exist for duplicate check
      const parentLookupName = systemFields.parentLookup?.logicalName;
      const productLookupName = systemFields.productLookup?.logicalName;
      const detailEntitySet = entityConfig.detailEntitySet;
      
      if (parentLookupName && productLookupName && detailEntitySet) {
        try {
          // Get existing product IDs on parent record
          const existingProductIds = await this.dataService.getExistingProductIds(
            parentLookupName,
            this.props.parentRecordId,
            productLookupName,
            detailEntitySet
          );

          if (existingProductIds.length > 0) {

            // Filter out catalog products that already exist (keep write-in products always)
            const originalCount = productsToSave.length;
            productsToSave = stagedProducts.filter(sp => {
              // Always include write-in products (no productId to check)
              if (sp.isWriteIn === true) {
                return true;
              }
              // Check if catalog product already exists
              const productIdLower = sp.productId.toLowerCase();
              return !existingProductIds.includes(productIdLower);
            });

            skippedDuplicates = originalCount - productsToSave.length;
          }
        } catch (error) {
          LoggerService.error('Error during duplicate detection (proceeding with save):', error);
          // On error, proceed with all products to avoid blocking save
        }
      }
    }

    // Reservation batch-add: when the parent reservation is already bound to Logo, each created
    // line defers its per-line Logo push (emd_skiplogopush) and one batched emd_SyncReservationLines
    // call pushes them all at once. Drafts (no emd_logocode) skip the batch entirely.
    const isReservation = this.isReservationParent();
    const logoCode = isReservation ? String(parentRecord[FIELD_LOGO_CODE] ?? '') : '';
    const isLogoBound = isReservation && logoCode.length > 0;

    // Save products (only non-duplicates if filtering was applied)
    if (productsToSave.length > 0) {
      let createdIds: string[] = [];
      try {
        createdIds = await this.dataService.saveProducts(
          productsToSave,
          this.props.parentRecordId,
          entityConfig.detailEntity,
          systemFields,
          viewMetadata,
          null,
          parentRecord.transactionCurrencyId,
          uomId,
          productFieldMappings,
          conditionalFieldsConfig?.fields,
          // Abort-on-first-failure only for Logo-bound reservations (true unit semantics).
          isLogoBound,
          isLogoBound ? FIELD_SKIP_LOGO_PUSH : undefined
        );
      } catch (saveError) {
        // Branch B: a createRecord aborted mid-loop. The partial line IDs ride on the error —
        // hand them to the dispatcher's compensate mode to clean up server-side, then rethrow so
        // handleSaveAll surfaces the error and keeps the dialog open.
        const partialIds = (saveError as { createdIds?: string[] }).createdIds ?? [];
        if (isLogoBound && partialIds.length > 0) {
          await this.dataService.syncReservationLines(this.props.parentRecordId, partialIds, 'compensate');
        }
        throw saveError;
      }

      // Branch A: all lines created — fire ONE batched Logo push. On failure the dispatcher has
      // already compensated (hard-deleted the lines) server-side and returns success=false; throw
      // so handleSaveAll shows the error toast and leaves the dialog open.
      if (isLogoBound && createdIds.length > 0) {
        const result = await this.dataService.syncReservationLines(this.props.parentRecordId, createdIds, 'sync');
        if (!result.success) {
          throw new Error(result.message ?? this.localizationService.getString('notification.savedError', ''));
        }
      }
    }

    return { savedCount: productsToSave.length, skippedDuplicates };
  };

  /**
   * True when the parent is a reservation record (crcad_reservationrecord) — the only entity that
   * participates in the batched Logo sync. All other configs (opportunity/quote/order) are unaffected.
   */
  private isReservationParent = (): boolean => {
    return this.props.parentEntityName === RESERVATION_PARENT_ENTITY;
  };

  /**
   * Handle clearing all staging - show confirmation dialog
   */
  private handleClearStaging = (): void => {
    this.setState({ showClearConfirmDialog: true });
  };

  /**
   * Confirm clear staging action
   */
  private handleConfirmClearStaging = (): void => {
    this.setState({ showClearConfirmDialog: false });
    this.props.stagingContext.clearAllStaging();
    // Also clear product request rows
    this.productRequestsManagerRef.current?.clearStaging();
    this.notifyDataChanged();
  };

  /**
   * Cancel clear staging action
   */
  private handleCancelClearStaging = (): void => {
    this.setState({ showClearConfirmDialog: false });
  };

  /**
   * Show toast notification
   */
  private showToast = (
    type: 'success' | 'error' | 'warning' | 'info',
    message: string,
    position: 'top-left' | 'top-right' = 'top-right'
  ): void => {
    // Auto-dismiss: success/info after 5s, errors/warnings after 7s
    const timeout = type === 'error' || type === 'warning' ? 7000 : 5000;
    
    const toast: Toast = {
      id: `toast-${Date.now()}`,
      type,
      message,
      timeout,
      position
    };

    this.setState(prevState => ({
      toasts: [...prevState.toasts, toast]
    }));
  };

  /**
   * Dismiss toast notification
   */
  private handleDismissToast = (toastId: string): void => {
    this.setState(prevState => ({
      toasts: prevState.toasts.filter(t => t.id !== toastId)
    }));
  };

  /**
   * Notify data changed
   */
  private notifyDataChanged = (): void => {
    if (this.props.onDataChanged) {
      this.props.onDataChanged(this.props.stagingContext.stagedProducts);
    }
  };

  /**
   * Handle staged count changes from ProductRequestsManager
   */
  private handleProductRequestsStagedCountChange = (count: number): void => {
    this.setState({ productRequestsStagedCount: count });
  };

  render(): React.ReactElement {
    const {
      activeTab,
      isLoading,
      isSaving,
      toasts,
      parentRecord,
      entityConfig,
      viewMetadata,
      viewConfig,
      mergedColumns,
      isProductDetailView,
      currencyCode,
      currencySymbol,
      conditionalFieldsPanel,
      writeInEnabled,
      productRequestEnabled
    } = this.state;

    const {
      stagedProducts,
      stagedProductsById,
      writeInRows,
      writeInEditedValues,
      stagedWriteInsById
    } = this.props.stagingContext;

    const stagedCount = stagedProducts.length;
    const { productRequestsStagedCount } = this.state;
    const hasAnyStagedItems = stagedCount > 0 || productRequestsStagedCount > 0;

    // Show unified loading state until metadata AND initial catalog loaded
    // Note: We still render tabs below (hidden) so CatalogTabManager can mount and trigger callback
    const isInitializing = isLoading || !this.state.hasCatalogLoadedInitially;
    
    if (!entityConfig) {
      return (
        <ThemeProvider theme={ProductAddGridTheme}>
          <div ref={this.containerRef} className="product-add-grid" data-modal="true">
            <LoadingSpinner labelText={this.localizationService.getString('general.loading')} fullscreen />
          </div>
        </ThemeProvider>
      );
    }

    // Show loading spinner during initialization, only show error if not loading
    if (!viewConfig || !parentRecord) {
      if (isLoading) {
        return (
          <ThemeProvider theme={ProductAddGridTheme}>
            <div ref={this.containerRef} className="product-add-grid" data-modal="true">
              <LoadingSpinner labelText={this.localizationService.getString('general.loading')} fullscreen />
            </div>
          </ThemeProvider>
        );
      }
      return (
        <ThemeProvider theme={ProductAddGridTheme}>
          <div ref={this.containerRef} className="product-add-grid" data-modal="true">
            <div className="pag-error">{this.localizationService.getString('error.configuration')}</div>
          </div>
        </ThemeProvider>
      );
    }

    return (
      <ThemeProvider theme={ProductAddGridTheme}>
        <div ref={this.containerRef} className="product-add-grid" data-modal="true">
          {/* Loading overlay - shown while initializing */}
          {isInitializing && (
            <LoadingSpinner labelText={this.localizationService.getString('general.loading')} fullscreen />
          )}

          {/* Tab header */}
          {(writeInEnabled || productRequestEnabled) && (
            <Pivot
              selectedKey={activeTab}
              onLinkClick={this.handleTabChange}
              className="pag-tabs"
              styles={{
                root: { marginBottom: 0 },
                link: { fontSize: '14px', fontWeight: 600 },
                linkIsSelected: { fontWeight: 600 }
              }}
            >
              <PivotItem
                headerText={this.localizationService.getString('tabs.catalogProducts')}
                itemKey="catalog"
              />
              {writeInEnabled && (
                <PivotItem
                  headerText={this.localizationService.getString('tabs.writeInProducts')}
                  itemKey="writeIn"
                />
              )}
              {productRequestEnabled && (
                <PivotItem
                  headerText={this.localizationService.getString('tabs.productRequests')}
                  itemKey="productRequests"
                />
              )}
            </Pivot>
          )}

          {/* Catalog tab - always rendered to trigger initial load, but only visible when active */}
          {viewMetadata && (
            <div className={`pag-tab-wrapper${activeTab !== 'catalog' ? ' pag-tab-wrapper--hidden' : ''}`}>
              <CatalogTabManager
                parentEntityName={this.props.parentEntityName}
                parentRecordId={this.props.parentRecordId}
                dataService={this.dataService}
                configService={this.configService}
                localizationService={this.localizationService}
                viewMetadata={viewMetadata}
                viewConfig={viewConfig}
                mergedColumns={mergedColumns}
                isProductDetailView={isProductDetailView}
                currencyCode={currencyCode}
                currencySymbol={currencySymbol}
                stagedProductsById={stagedProductsById}
                stagedProducts={stagedProducts}
                onStageProduct={this.handleStageProduct}
                onRemoveStaged={this.props.stagingContext.removeStaged}
                onShowToast={this.showToast}
                onInitialLoadComplete={this.handleCatalogInitialLoadComplete}
              />
            </div>
          )}

          {/* Write-in tab */}
          {activeTab === 'writeIn' && (
            <div className="pag-tab-wrapper">
              <WriteInTabManager
                parentEntityName={this.props.parentEntityName}
                dataService={this.dataService}
                configService={this.configService}
                localizationService={this.localizationService}
                currencyCode={currencyCode}
                currencySymbol={currencySymbol}
                writeInRows={writeInRows}
                writeInEditedValues={writeInEditedValues}
                stagedWriteInsById={stagedWriteInsById}
                onStageWriteIn={this.props.stagingContext.stageWriteIn}
                onUpdateRows={this.props.stagingContext.updateWriteInRows}
                onRemoveStaged={this.props.stagingContext.removeStaged}
                onShowToast={this.showToast}
              />
            </div>
          )}

          {/* Product Requests tab - always mounted to preserve state across tab switches */}
          <div className={`pag-tab-panel pag-tab-panel-product-requests${activeTab === 'productRequests' ? ' pag-tab-panel--active' : ''}`}>
            <ProductRequestsManager
              ref={this.productRequestsManagerRef}
              parentEntityName={this.props.parentEntityName}
              parentRecordId={this.props.parentRecordId}
              parentRecord={parentRecord}
              entityConfig={entityConfig}
              dataService={this.dataService}
              configService={this.configService}
              localizationService={this.localizationService}
              currencyCode={currencyCode}
              currencySymbol={currencySymbol}
              onShowToast={this.showToast}
              onRequestSave={() => {
                // ProductRequestsManager handles its own state clearing
                // Just notify parent to close dialog
                if (this.props.onDialogClose) {
                  this.props.onDialogClose();
                }
              }}
              onStagedCountChange={this.handleProductRequestsStagedCountChange}
              onRestoredFromStorage={(totalRestored: number) => {
                this.showToast(
                  'info',
                  this.localizationService.getString('staging.priceRequestRestored', totalRestored),
                  'top-left'
                );
              }}
            />
          </div>

          {/* Saving overlay */}
          {isSaving && (
            <div className="pag-saving-overlay">
              <div className="pag-saving-spinner">
                <svg className="pag-saving-spinner-svg" viewBox="0 0 100 100">
                  <circle
                    className="pag-saving-spinner-track"
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    strokeWidth="8"
                  />
                  <circle
                    className="pag-saving-spinner-head"
                    cx="50"
                    cy="50"
                    r="40"
                    fill="none"
                    strokeWidth="8"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <div className="pag-saving-label">
                {this.localizationService.getString('general.saving')}
              </div>
            </div>
          )}

          {/* Action buttons - always visible in modal mode (this control always runs on Custom Page) */}
          <Stack
            horizontal
            horizontalAlign="end"
            verticalAlign="center"
            className="pag-modal-actions"
          >
            <Stack
              horizontal
              tokens={{ childrenGap: FluentTokens.spacing.m }}
              className="pag-modal-actions-buttons"
            >
              <DefaultButton
                text={this.localizationService.getString('actions.clearStaging')}
                onClick={this.handleClearStaging}
                disabled={isSaving || !hasAnyStagedItems}
                iconProps={{ iconName: 'Clear' }}
              />
              <PrimaryButton
                text={
                  isSaving
                    ? this.localizationService.getString('general.saving')
                    : this.localizationService.getString('actions.saveAll')
                }
                onClick={() => void this.handleSaveAll()}
                disabled={isSaving || !hasAnyStagedItems}
                iconProps={isSaving ? undefined : { iconName: 'Save' }}
              />
            </Stack>
          </Stack>

          <ToastContainer
            toasts={toasts}
            onDismiss={this.handleDismissToast}
            localizationService={this.localizationService}
          />

          {/* Clear staging confirmation dialog */}
          <Dialog
            hidden={!this.state.showClearConfirmDialog}
            onDismiss={this.handleCancelClearStaging}
            dialogContentProps={{
              type: DialogType.normal,
              title: this.localizationService.getString('actions.clearStaging'),
              subText: this.localizationService.getString('confirm.clearStaging.message')
            }}
            modalProps={{
              isBlocking: true
            }}
          >
            <DialogFooter>
              <PrimaryButton
                onClick={this.handleConfirmClearStaging}
                text={this.localizationService.getString('actions.clearStaging')}
              />
              <DefaultButton
                onClick={this.handleCancelClearStaging}
                text={this.localizationService.getString('actions.cancel')}
              />
            </DialogFooter>
          </Dialog>

          {/* Conditional Fields Panel */}
          {conditionalFieldsPanel?.product && (
            <ConditionalFieldsPanel
              isOpen={conditionalFieldsPanel.isOpen}
              product={conditionalFieldsPanel.product}
              productCodeField={this.configService.getProductCodeField()}
              existingValues={conditionalFieldsPanel.conditionalValues}
              conditionalFields={
                this.configService.getConditionalFieldsConfig(this.props.parentEntityName)
                  ?.fields ?? []
              }
              detailEntity={
                this.configService.getDetailEntityName(this.props.parentEntityName) ?? ''
              }
              localizationService={this.localizationService}
              configService={this.configService}
              dataService={this.dataService}
              onSave={this.handleConditionalFieldsSave}
              onDismiss={this.handleConditionalFieldsDismiss}
            />
          )}
        </div>
      </ThemeProvider>
    );
  }
}

/**
 * Wrapper function component that provides staging context
 */
export const ProductAddGridContainer: React.FC<IProductAddGridContainerProps> = props => {
  const stagingContext = useStagingContext();
  return <ProductAddGridContainerComponent {...props} stagingContext={stagingContext} />;
};
