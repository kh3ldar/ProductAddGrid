export class LocalizationService {
  private context: ComponentFramework.Context<unknown>;

  constructor(context: ComponentFramework.Context<unknown>) {
    this.context = context;
  }

  /**
   * Format a string with placeholder arguments
   */
  private formatString(value: string, args: (string | number)[]): string {
    if (args.length === 0) {
      return value;
    }
    
    let result = value;
    args.forEach((arg, index) => {
      result = result.replace(`{${index}}`, String(arg));
    });
    return result;
  }

  /**
   * Get a localized string by key
   * Loads from PCF context.resources which reads from .resx files
   * Returns the key itself if not found (no hardcoded fallbacks)
   */
  getString(key: string, ...args: (string | number)[]): string {
    const value = this.context.resources?.getString(key) ?? key;
    return this.formatString(value, args);
  }
}