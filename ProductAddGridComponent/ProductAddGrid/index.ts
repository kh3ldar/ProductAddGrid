import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { ProductAddGrid as ProductAddGridView, IProductAddGridProps } from "./components/ProductAddGrid";
import { StagedProduct } from "./types";
import { LoggerService } from "./services";
import * as React from "react";

export class ProductAddGridComponent implements ComponentFramework.ReactControl<IInputs, IOutputs> {
    private notifyOutputChanged: () => void;
    private stagedProducts: StagedProduct[] = [];
    private dialogAction = "";

    /**
     * Empty constructor.
     */
    constructor() {
        // Empty
    }

    /**
     * Used to initialize the control instance. Controls can kick off remote server calls and other initialization actions here.
     * Data-set values are not initialized here, use updateView.
     * @param context The entire property bag available to control via Context Object; It contains values as set up by the customizer mapped to property names defined in the manifest, as well as utility functions.
     * @param notifyOutputChanged A callback method to alert the framework that the control has new outputs ready to be retrieved asynchronously.
     * @param state A piece of data that persists in one session for a single user. Can be set at any point in a controls life cycle by calling 'setControlState' in the Mode interface.
     */
    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary
    ): void {
        // Initialize LoggerService (debug mode disabled in production)
        LoggerService.initialize(context);
        
        this.notifyOutputChanged = notifyOutputChanged;
        
        // Enable container resize tracking to get allocated width/height
        // This helps with dynamic sizing in Custom Page mdal dialogs
        context.mode.trackContainerResize(true);
        
        // Restore state if available
        if (state?.stagedProducts) {
            try {
                this.stagedProducts = JSON.parse(state.stagedProducts as string) as StagedProduct[];
            } catch (error) {
                LoggerService.error('Failed to restore staged products from state:', error);
                this.stagedProducts = [];
            }
        }
    }

    /**
     * Called when any value in the property bag has changed. This includes field values, data-sets, global values such as container height and width, offline status, control metadata values such as label, visible, etc.
     * @param context The entire property bag available to control via Context Object; It contains values as set up by the customizer mapped to names defined in the manifest, as well as utility functions
     * @returns ReactElement root react element for the control
     */
    public updateView(context: ComponentFramework.Context<IInputs>): React.ReactElement {
        const parentEntityName = context.parameters.parentEntityName.raw ?? '';
        const parentRecordIdRaw = context.parameters.parentRecordId.raw ?? '';
        
        // Deserialize recordId: may contain "guid|variantKey|overrideFlags" due to Power Pages parameter limits
        // Override flags format: "sc=0" (stock check disabled) or "sc=1" (stock check enabled)
        let parentRecordId = parentRecordIdRaw;
        let parentVariantKey: string | undefined = undefined;
        let stockCheckEnabled: boolean | undefined = undefined;

        if (parentRecordIdRaw.includes('|')) {
            const parts = parentRecordIdRaw.split('|');
            parentRecordId = parts[0]; // GUID
            parentVariantKey = parts[1] || undefined; // Variant key (empty string → undefined)
            const overrideFlags = parts[2] ?? '';
            if (overrideFlags.includes('sc=0')) stockCheckEnabled = false;
            else if (overrideFlags.includes('sc=1')) stockCheckEnabled = true;
        }
        
        // For now, default to 'auto' mode until displayMode property is fully supported
        const displayMode: 'modal' | 'auto' = 'auto';

        if (!parentEntityName || !parentRecordId) {
            return React.createElement('div', {
                style: { padding: '20px', textAlign: 'center', color: '#666' }
            }, 'Please configure the Parent Entity Name and Parent Record ID properties.');
        }

        const props: IProductAddGridProps = {
            context,
            parentEntityName,
            parentRecordId,
            displayMode,
            parentVariantKey,
            stockCheckEnabled,
            allocatedWidth: context.mode.allocatedWidth,
            allocatedHeight: context.mode.allocatedHeight,
            onDataChanged: this.handleDataChanged.bind(this),
            onDialogClose: this.handleDialogClose.bind(this)
        };

        return React.createElement(ProductAddGridView, props);
    }

    /**
     * Handle data changes from the component
     */
    private handleDataChanged(data: unknown[]): void {
        this.stagedProducts = data as StagedProduct[];
        this.notifyOutputChanged();
    }

    /**
     * Handle dialog close signal from the component
     * Sets dialogAction output to 'close' which Custom Page can bind to OnChange event
     * Custom Page should use: If(ProductAddGrid.dialogAction = "close", Back())
     */
    private handleDialogClose(): void {
        this.dialogAction = "close";
        this.notifyOutputChanged();
    }

    /**
     * It is called by the framework prior to a control receiving new data.
     * @returns an object based on nomenclature defined in manifest, expecting object[s] for property marked as "bound" or "output"
     */
    public getOutputs(): IOutputs {
        return {
            dataOutput: JSON.stringify(this.stagedProducts.map(staged => ({
                id: staged.id,
                productId: staged.productId ?? staged.product?.productid,
                productName: staged.product?.name,
                quantity: staged.quantity,
                unitPrice: staged.unitPrice,
                extendedAmount: (staged.quantity ?? 0) * staged.unitPrice,
                description: staged.description
            }))),
            dialogAction: this.dialogAction
        };
    }

    /**
     * Called when the control is to be removed from the DOM tree. Controls should use this call for cleanup.
     * i.e. cancelling any pending remote calls, removing listeners, etc.
     */
    public destroy(): void {
        // Clear state to help garbage collection
        this.stagedProducts = [];
        this.dialogAction = "";
        
        // Stop periodic cache cleanup timer
        import('./services/CacheService').then(({ CacheService }) => {
            CacheService.stopPeriodicCleanup();
            return CacheService.cleanupExpiredEntries();
        }).catch(() => {
            // Ignore errors during cleanup
        });
    }

    /**
     * Called when control state needs to be persisted
     */
    public getControlState?(): ComponentFramework.Dictionary {
        return {
            stagedProducts: JSON.stringify(this.stagedProducts)
        };
    }
}
