/**
 * Module-level cache of the latest `claude:bootstrap` snapshot and catalog.
 * Shared by the sync bootstrap, config stores and the `claudeHost` compat facade so the host
 * is asked once, and `catalog.updated` / `account.updated` events keep every reader current.
 */

import { claudeClient } from './client';
import type { BootstrapResponse } from './protocol';
import type { AccountInfo, Catalog, UsageLimits } from './types';

let latest: BootstrapResponse | null = null;
let inFlight: Promise<BootstrapResponse> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Load (or reuse) the bootstrap snapshot. `force` always asks the host again. */
export const loadBootstrap = (force = false): Promise<BootstrapResponse> => {
  if (!force) {
    if (inFlight) return inFlight;
    if (latest) return Promise.resolve(latest);
  }
  const request = claudeClient
    .bootstrap()
    .then((response) => {
      latest = response;
      notify();
      return response;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });
  inFlight = request;
  return request;
};

export const getBootstrapSnapshot = (): BootstrapResponse | null => latest;
export const getCatalog = (): Catalog | null => latest?.catalog ?? null;
export const getAccount = (): AccountInfo | null => latest?.account ?? null;
export const getWorkspaceCwd = (): string => latest?.cwd ?? '';

export const getUsage = (): UsageLimits | null => latest?.usage ?? null;

/** Plan usage limits (`usage.updated` push, bootstrap, `claude:usage.refresh`). */
export const setUsage = (usage: UsageLimits): void => {
  if (!latest) return;
  latest = { ...latest, usage };
  notify();
};

export const setCatalog = (catalog: Catalog): void => {
  if (!latest) return;
  latest = { ...latest, catalog };
  notify();
};

export const setAccount = (account: AccountInfo | null): void => {
  if (!latest) return;
  latest = { ...latest, account };
  notify();
};

export const subscribeBootstrapCache = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test helper. */
export const resetBootstrapCache = (): void => {
  latest = null;
  inFlight = null;
};
