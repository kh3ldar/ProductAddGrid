import * as React from 'react';

/**
 * Base class for tab managers (CatalogTabManager, WriteInTabManager, ProductRequestsManager).
 * Consolidates the common isMounted lifecycle pattern.
 */
export abstract class BaseTabManager<P, S> extends React.PureComponent<P, S> {
  protected isMounted = false;

  componentDidMount(): void {
    this.isMounted = true;
    void this.onMount();
  }

  componentWillUnmount(): void {
    this.isMounted = false;
    this.onUnmount();
  }

  protected abstract onMount(): Promise<void>;
  protected onUnmount(): void { /* override if needed */ }
}
