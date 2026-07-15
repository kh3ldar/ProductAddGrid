/**
 * FormattingService
 * 
 * Responsibility: Display value formatting
 * 
 * Handles formatting of values for display including:
 * - Currency formatting with localization
 * - Decimal number formatting
 * - Currency metadata retrieval
 */

/**
 * FormattingService - Handles display value formatting
 */
export class FormattingService {
  private context: ComponentFramework.Context<unknown>;
  private webApi: ComponentFramework.WebApi;

  constructor(context: ComponentFramework.Context<unknown>) {
    this.context = context;
    this.webApi = context.webAPI;
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Get currency formatting information
   * @param currencyId - Currency record ID
   * @returns Currency entity record or null if not found
   */
  public async getCurrencyInfo(currencyId: string): Promise<ComponentFramework.WebApi.Entity | null> {
    try {
      const response = await this.webApi.retrieveRecord(
        'transactioncurrency',
        currencyId,
        '?$select=currencysymbol,currencyname,exchangerate,isocurrencycode'
      );
      return response;
    } catch {
      // Currency info not available, will use default formatting
      return null;
    }
  }

  /**
   * Format currency value based on user settings
   * @param value - Numeric value to format
   * @param currencyCode - Optional ISO currency code (e.g., 'USD', 'EUR', 'TRY')
   * @returns Formatted currency string
   */
  public formatCurrency(value: number, currencyCode?: string): string {
    try {
      const userSettings = this.context.userSettings;
      const locale = userSettings.languageId === 1055 ? 'tr-TR' : 'en-US';
      
      if (currencyCode && /^[A-Za-z]{3}$/.test(currencyCode)) {
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: currencyCode.toUpperCase(),
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(value);
      }
      
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value);
    } catch {
      return value.toFixed(2);
    }
  }

  /**
   * Format decimal value based on user settings
   * @param value - Numeric value to format
   * @param decimalPlaces - Number of decimal places (default: 2)
   * @returns Formatted decimal string
   */
  public formatDecimal(value: number, decimalPlaces = 2): string {
    try {
      const userSettings = this.context.userSettings;
      const locale = userSettings.languageId === 1055 ? 'tr-TR' : 'en-US';
      
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces
      }).format(value);
    } catch {
      return value.toFixed(decimalPlaces);
    }
  }
}
