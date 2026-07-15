import * as React from 'react';
import { StagingProvider } from '../contexts/StagingContext';
import {
  ProductAddGridContainer,
  IProductAddGridContainerProps
} from './ProductAddGridContainer';
import { ConfigService, LocalizationService } from '../services';

/**
 * Props interface for ProductAddGrid wrapper
 */
export type IProductAddGridProps = IProductAddGridContainerProps;

/**
 * ProductAddGrid - Thin wrapper component
 * Provides StagingContext to ProductAddGridContainer
 * Creates ConfigService early for StagingProvider
 */
export const ProductAddGrid: React.FC<IProductAddGridProps> = props => {
  // Create ConfigService instance for StagingProvider
  // Must be done outside StagingProvider to avoid circular dependency
  const configServiceRef = React.useRef<ConfigService>();
  
  if (!configServiceRef.current) {
    const localizationService = new LocalizationService(props.context);
    const configService = new ConfigService();
    configService.setLocalizationService(localizationService);
    configService.initializeVariant(props.parentEntityName, props.parentVariantKey, { stockCheckEnabled: props.stockCheckEnabled });
    configServiceRef.current = configService;
  }

  return (
    <StagingProvider
      configService={configServiceRef.current}
      parentEntityName={props.parentEntityName}
    >
      <ProductAddGridContainer {...props} configServiceInstance={configServiceRef.current} />
    </StagingProvider>
  );
};
