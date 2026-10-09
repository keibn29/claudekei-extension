import React from 'react';
import type { AgentSwitchDivider } from '@/lib/claude/agentSwitch';

/** Dividers keyed by the id of the user message they sit above (derived in `MessageList`). */
export const AgentSwitchContext = React.createContext<ReadonlyMap<string, AgentSwitchDivider>>(new Map());
