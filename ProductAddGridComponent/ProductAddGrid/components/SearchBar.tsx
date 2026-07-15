import * as React from 'react';
import { SearchBox, Dropdown, IDropdownOption, IDropdownStyles } from '@fluentui/react';
import { ProductFilterOption } from '../types';
import { LocalizationService } from '../services';

export interface ISearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  // Product filter props
  filterOptions?: ProductFilterOption[];
  selectedFilterKey?: string;
  onFilterChange?: (filterKey: string) => void;
  // Sub-filter props
  subFilterOptions?: ProductFilterOption[];
  selectedSubFilterKey?: string;
  onSubFilterChange?: (subFilterKey: string | undefined) => void;
  localizationService?: LocalizationService;
}

const dropdownStyles: Partial<IDropdownStyles> = {
  root: { 
    minWidth: 150,
    maxWidth: 200
  },
  dropdown: {
    fontSize: '14px'
  },
  title: {
    fontSize: '14px',
    border: '1px solid #d2d0ce',
    borderRadius: '2px'
  },
  caretDownWrapper: {
    fontSize: '12px'
  }
};

export const SearchBar = React.memo<ISearchBarProps>(function SearchBar({
  value,
  onChange,
  placeholder,
  disabled = false,
  filterOptions,
  selectedFilterKey,
  onFilterChange,
  subFilterOptions,
  selectedSubFilterKey,
  onSubFilterChange,
  localizationService
}) {
  const handleChange = (_event?: React.ChangeEvent<HTMLInputElement>, newValue?: string): void => {
    onChange(newValue ?? '');
  };

  const handleClear = React.useCallback((): void => {
    // Fluent UI v8 SearchBox onClear doesn't trigger onChange for controlled components
    // We must explicitly call onChange with empty string to clear the controlled value
    onChange('');
  }, [onChange]);

  const handleFilterChange = React.useCallback(
    (_event: React.FormEvent<HTMLDivElement>, option?: IDropdownOption): void => {
      if (option && onFilterChange) {
        onFilterChange(option.key as string);
      }
    },
    [onFilterChange]
  );

  const handleSubFilterChange = React.useCallback(
    (_event: React.FormEvent<HTMLDivElement>, option?: IDropdownOption): void => {
      if (onSubFilterChange) {
        onSubFilterChange(option ? (option.key as string) : undefined);
      }
    },
    [onSubFilterChange]
  );

  // Convert filter options to Dropdown options with localized labels
  const dropdownOptions: IDropdownOption[] = React.useMemo(() => {
    if (!filterOptions) return [];
    
    return filterOptions.map(filter => ({
      key: filter.key,
      text: localizationService?.getString(filter.labelKey) ?? filter.labelKey
    }));
  }, [filterOptions, localizationService]);

  const subDropdownOptions: IDropdownOption[] = React.useMemo(() => {
    if (!subFilterOptions || subFilterOptions.length === 0) return [];
    return subFilterOptions.map(sf => ({
      key: sf.key,
      text: localizationService?.getString(sf.labelKey) ?? sf.labelKey
    }));
  }, [subFilterOptions, localizationService]);

  const showFilter = filterOptions && filterOptions.length > 0 && onFilterChange;
  const showSubFilter = subDropdownOptions.length > 0 && onSubFilterChange;

  return (
    <div className="pag-search-container">
      {showFilter && (
        <div className="pag-filter-dropdown">
          <Dropdown
            selectedKey={selectedFilterKey}
            options={dropdownOptions}
            onChange={handleFilterChange}
            disabled={disabled}
            styles={dropdownStyles}
            ariaLabel={localizationService?.getString('filter.ariaLabel') ?? 'Product filter'}
          />
        </div>
      )}
      {showSubFilter && (
        <div className="pag-filter-dropdown">
          <Dropdown
            selectedKey={selectedSubFilterKey ?? null}
            placeholder={localizationService?.getString('filter.subFilter.placeholder') ?? '—'}
            options={subDropdownOptions}
            onChange={handleSubFilterChange}
            disabled={disabled}
            styles={dropdownStyles}
            ariaLabel={localizationService?.getString('filter.subFilter.ariaLabel') ?? 'Sub-filter'}
          />
        </div>
      )}
      <SearchBox
        value={value}
        onChange={handleChange}
        onClear={handleClear}
        placeholder={placeholder}
        disabled={disabled}
        ariaLabel={placeholder}
        autoComplete="one-time-code"
        styles={{
          root: { width: '100%', maxWidth: '400px' },
          field: { fontSize: '14px' }
        }}
      />
    </div>
  );
});

SearchBar.displayName = 'SearchBar';