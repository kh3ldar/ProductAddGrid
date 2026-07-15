import * as React from 'react';
import { MessageBar, MessageBarType } from '@fluentui/react';
import { Toast } from '../types';
import { LocalizationService } from '../services';

export interface IToastContainerProps {
  toasts: Toast[];
  onDismiss: (toastId: string) => void;
  localizationService: LocalizationService;
}

function mapToastTypeToMessageBarType(type: 'success' | 'error' | 'warning' | 'info'): MessageBarType {
  switch (type) {
    case 'success': return MessageBarType.success;
    case 'error': return MessageBarType.error;
    case 'warning': return MessageBarType.warning;
    case 'info': return MessageBarType.info;
    default: return MessageBarType.info;
  }
}

export const ToastContainer = React.memo<IToastContainerProps>(function ToastContainer({
  toasts,
  onDismiss,
  localizationService
}) {
  // Track active timers by toast ID to avoid resetting on array changes
  const activeTimers = React.useRef<Map<string, NodeJS.Timeout>>(new Map());

  React.useEffect(() => {
    // Set up timers for new toasts that don't have one yet
    toasts.forEach(toast => {
      if (toast.timeout && toast.timeout > 0 && !activeTimers.current.has(toast.id)) {
        const timer = setTimeout(() => {
          activeTimers.current.delete(toast.id);
          onDismiss(toast.id);
        }, toast.timeout);
        activeTimers.current.set(toast.id, timer);
      }
    });

    // Clean up timers for toasts that were dismissed manually
    const currentToastIds = new Set(toasts.map(t => t.id));
    activeTimers.current.forEach((timer, id) => {
      if (!currentToastIds.has(id)) {
        clearTimeout(timer);
        activeTimers.current.delete(id);
      }
    });

    // Cleanup on unmount
    return () => {
      activeTimers.current.forEach(timer => clearTimeout(timer));
      activeTimers.current.clear();
    };
  }, [toasts, onDismiss]);

  if (toasts.length === 0) {
    return null;
  }

  const leftToasts = toasts.filter(t => t.position === 'top-left');
  const rightToasts = toasts.filter(t => t.position !== 'top-left');

  const renderToast = (toast: Toast) => (
    <MessageBar
      key={toast.id}
      messageBarType={mapToastTypeToMessageBarType(toast.type)}
      onDismiss={() => onDismiss(toast.id)}
      dismissButtonAriaLabel={localizationService.getString('toast.dismiss')}
      styles={{
        root: {
          marginBottom: '8px',
          minWidth: '300px',
          boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)'
        }
      }}
    >
      {toast.message}
    </MessageBar>
  );

  return (
    <>
      {leftToasts.length > 0 && (
        <div className="pag-toast-container pag-toast-container--left" role="status" aria-live="polite">
          {leftToasts.map(renderToast)}
        </div>
      )}
      {rightToasts.length > 0 && (
        <div className="pag-toast-container pag-toast-container--right" role="status" aria-live="polite">
          {rightToasts.map(renderToast)}
        </div>
      )}
    </>
  );
});

ToastContainer.displayName = 'ToastContainer';