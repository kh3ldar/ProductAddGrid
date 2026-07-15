import * as React from 'react';
import { DefaultButton, Stack } from '@fluentui/react';
import { PagingInfo } from '../types';
import { LocalizationService } from '../services';

export interface IPagingProps {
  paging: PagingInfo;
  onPageChange: (page: number) => void;
  localizationService: LocalizationService;
}

export const Paging = React.memo<IPagingProps>(function Paging({
  paging,
  onPageChange,
  localizationService
}) {
  const handlePreviousClick = (): void => {
    if (paging.hasPreviousPage) {
      onPageChange(paging.currentPage - 1);
    }
  };

  const handleNextClick = (): void => {
    if (paging.hasNextPage) {
      onPageChange(paging.currentPage + 1);
    }
  };

  if (paging.totalRecords === 0) {
    return null;
  }

  return (
    <div className="pag-paging" role="navigation" aria-label="Pagination">
      <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="center" className="pag-paging-controls">
        <DefaultButton
          text={localizationService.getString('paging.previous')}
          onClick={handlePreviousClick}
          disabled={!paging.hasPreviousPage}
          iconProps={{ iconName: 'ChevronLeft' }}
          ariaLabel={localizationService.getString('paging.previous')}
        />

        <DefaultButton
          text={localizationService.getString('paging.next')}
          onClick={handleNextClick}
          disabled={!paging.hasNextPage}
          iconProps={{ iconName: 'ChevronRight' }}
          ariaLabel={localizationService.getString('paging.next')}
        />
      </Stack>
    </div>
  );
});

Paging.displayName = 'Paging';