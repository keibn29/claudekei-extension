import React from 'react';
import { getUsage, subscribeBootstrapCache } from './bootstrapCache';
import type { UsageLimits } from './types';

/** Plan usage limits (bootstrap snapshot, `usage.updated` pushes and `claude:usage.refresh` results). */
export const useUsageLimits = (): UsageLimits | null => React.useSyncExternalStore(subscribeBootstrapCache, getUsage, getUsage);
