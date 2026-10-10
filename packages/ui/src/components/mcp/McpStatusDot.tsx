import React from 'react';
import { cn } from '@/lib/utils';
import type { McpServerInfo } from '@/lib/claude/types';

export const McpStatusDot: React.FC<{ status: McpServerInfo['status']; label?: string; className?: string }> = ({ status, label, className }) => (
  <span
    role="img"
    aria-label={label}
    className={cn(
      'h-2 w-2 flex-shrink-0 rounded-full',
      status === 'connected' && 'bg-status-success',
      status === 'failed' && 'bg-status-error',
      status === 'needs-auth' && 'bg-status-warning',
      status === 'pending' && 'animate-pulse bg-muted-foreground/60',
      status === 'disabled' && 'bg-muted-foreground/30',
      className,
    )}
  />
);
