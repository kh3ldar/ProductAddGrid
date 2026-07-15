/**
 * Services barrel export
 * Re-exports consumer-facing service modules for clean imports
 * Internal sub-services (MetadataService, FormattingService, ColumnService,
 * ProductQueryService, RecordOperationsService, CustomApiService) are composed
 * inside DataService and not exported here.
 */

export { DataService } from './DataService';
export { ConfigService } from './ConfigService';
export { LocalizationService } from './LocalizationService';
export { LoggerService } from './LoggerService';
export { CacheService } from './CacheService';
export { StagingPersistenceService } from './StagingPersistenceService';
