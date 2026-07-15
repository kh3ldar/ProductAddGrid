/**
 * Centralized logging service with environment-aware debug levels
 * Replaces console.log statements for production-safe logging
 * 
 * Usage:
 * - LoggerService.error() - Errors and exceptions (always shown)
 */
export class LoggerService {
  private static DEBUG_ENABLED = false;

  /**
   * Initialize debug mode based on environment
   * Call this in index.ts when control initializes
   * 
   * @param context - PCF context (optional, for future environment detection)
   */
  static initialize(_context?: ComponentFramework.Context<unknown>): void {
    // Disabled in production (NODE_ENV check at build time)
    LoggerService.DEBUG_ENABLED = process.env.NODE_ENV !== 'production';
    
    if (LoggerService.DEBUG_ENABLED) {
      console.log('🔍 LoggerService initialized - Debug mode enabled');
    }
  }

  /**
   * Check if debug logging is enabled
   * Use to avoid expensive operations when debug is disabled
   */
  static isDebugEnabled(): boolean {
    return LoggerService.DEBUG_ENABLED;
  }

  /**
   * Debug-level logging (suppressed in production)
   * Use for development/troubleshooting information
   */
  static debug(message: string, ...args: unknown[]): void {
    if (LoggerService.DEBUG_ENABLED) {
      console.log(`🔍 ${message}`, ...args);
    }
  }

  /**
   * Info-level logging (always shown)
   * Use for important operational information
   */
  static info(message: string, ...args: unknown[]): void {
    console.log(`ℹ️ ${message}`, ...args);
  }

  /**
   * Warning-level logging (always shown)
   * Use for recoverable issues
   */
  static warn(message: string, ...args: unknown[]): void {
    console.warn(`⚠️ ${message}`, ...args);
  }

  /**
   * Error-level logging (always shown)
   * Use for errors and exceptions
   */
  static error(message: string, ...args: unknown[]): void {
    console.error(`❌ ${message}`, ...args);
  }

  /**
   * Success-level logging (always shown)
   * Use for successful operations
   */
  static success(message: string, ...args: unknown[]): void {
    console.log(`✅ ${message}`, ...args);
  }
}
