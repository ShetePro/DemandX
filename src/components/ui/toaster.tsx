'use client';

import { Toaster as SonnerToaster } from 'sonner';

/**
 * App-wide toast host. Mounted once in the root layout; colors come from the
 * same semantic tokens as the rest of the UI so both themes stay consistent.
 */
export function Toaster() {
  return (
    <SonnerToaster
      theme="system"
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'border border-border bg-surface text-fg shadow-lg',
          description: 'text-muted',
          actionButton: 'bg-accent text-on-accent',
          cancelButton: 'bg-surface-2 text-muted',
          error: 'border-danger/40 bg-danger-soft text-danger',
          success: 'border-success/40 bg-success-soft text-success',
        },
      }}
    />
  );
}
