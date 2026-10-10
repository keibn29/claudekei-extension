/**
 * Phase 1.1 strings: subagent cards / groups / child session view and main-agent switching
 * (docs/PHASE1_1_UI_SPEC.md sections 1.7, 2.3, 2.5). Other locales spread this dictionary
 * until they are translated.
 */
export const subagentsDict = {
  // Card titles and labels
  'chat.subagent.title.agent': 'Subagent Task',
  'chat.subagent.title.message': 'Message to',
  'chat.subagent.fallbackType': 'Agent',
  'chat.subagent.copy': 'Copy',
  'chat.subagent.openFullText': 'Open full text',

  // Actions
  'chat.subagent.open': 'Open {type} session',
  'chat.subagent.openAlias': 'Open {type} ({alias}) session',
  'chat.subagent.unlinkedTooltip': 'Session not available yet',

  // Status
  'chat.subagent.status.starting': 'Starting...',
  'chat.subagent.status.running': 'running',
  'chat.subagent.status.done': 'done',
  'chat.subagent.status.failed': 'Failed',
  'chat.subagent.status.stopped': 'Stopped',
  'chat.subagent.status.noSession': 'No session',
  'chat.subagent.status.sent': 'sent',
  'chat.subagent.status.notDelivered': 'Not delivered',
  'chat.subagent.announce.finished': '{agent} finished',
  'chat.subagent.announce.failed': '{agent} failed',
  'chat.subagent.announce.stopped': '{agent} stopped',

  // Live lines and placeholders
  'chat.subagent.live.working': '{type} is working',
  'chat.subagent.live.replied': '{type} replied',
  'chat.subagent.activity.none': 'No activity yet',
  'chat.subagent.tools.one': '1 tool',
  'chat.subagent.tools.many': '{count} tools',
  'chat.subagent.tokens': '{count} tok',

  // Group
  'chat.subagent.group.title': '{count} subagents',
  'chat.subagent.group.running': '{count} running',
  'chat.subagent.group.done': '{count} done',
  'chat.subagent.group.failed': '{count} failed',
  'chat.subagent.group.stopped': '{count} stopped',

  // Child session view
  'chat.subagent.child.back': 'Back to {parent}',
  'chat.subagent.child.backAria': 'Back to {parent} session',
  'chat.subagent.child.mainAgent': 'main agent',
  'chat.subagent.child.instructionsOne': '1 instruction',
  'chat.subagent.child.instructionsMany': '{count} instructions',
  'chat.subagent.child.initialTask': 'Initial task',
  'chat.subagent.child.followUp': 'Follow-up',
  'chat.subagent.child.from': 'From {agent}',
  'chat.subagent.child.instructionAria': 'Instruction {index} from {agent}',
  'chat.subagent.child.viewInParent': 'View in {parent}',
  'chat.subagent.child.readOnly': 'Read-only. Instructions come from {parent}.',

  // Agent switching (Option B: in-place, made explicit)
  'chat.agentSwitch.pendingLabel': 'Next message → {agent}',
  'chat.agentSwitch.pendingHint': 'restarts Claude, keeps history',
  'chat.agentSwitch.pendingBusyLabel': 'After this reply → {agent}',
  'chat.agentSwitch.pendingBusyHint': 'applies when the current reply finishes',
  'chat.agentSwitch.undo': 'Undo',
  'chat.agentSwitch.undoAria': 'Undo agent switch and stay as {agent}',
  'chat.agentSwitch.nextBadge': 'next',
  'chat.agentSwitch.chipTitlePending': 'Agent switches to {agent} on your next message. Claude restarts and keeps history.',
  'chat.agentSwitch.announce.draft': 'Agent: {agent}',
  'chat.agentSwitch.announce.pending': 'Next message will run as {agent}. Claude restarts and keeps history.',
  'chat.agentSwitch.announce.undone': 'Agent switch undone. Staying as {agent}.',
  'chat.agentSwitch.divider': 'Switched to {agent}',
  'chat.agentSwitch.dividerHint': 'Claude restarted · history kept',

  // Model and effort
  'chat.modelControls.effort': 'Effort',
  'chat.modelControls.effortDefault': 'Model default',
  'chat.modelControls.effortDefaultHint': 'Let the model decide',

  // Context window / plan usage popup
  'contextUsage.popover.title': 'Context window',
  'contextUsage.popover.detailsAria': 'Show the context window breakdown',
  'contextUsage.popover.barAria': 'Context window usage',
  'contextUsage.popover.limitsTitle': 'Your usage limits',
  'contextUsage.popover.limitsTitlePlan': 'Your usage limits · {plan}',
  'contextUsage.popover.seeDetails': 'See detailed breakdown',
  'contextUsage.popover.backAria': 'Back to the usage summary',
  'contextUsage.popover.estimated': 'Estimated. Exact figures appear after the next turn.',
  'contextUsage.popover.deferred': 'Deferred (not in the window)',
  'contextUsage.popover.autocompact': 'Autocompact at {tokens}',
  'contextUsage.popover.noData': 'No context data yet. Send a message to measure it.',
  'contextUsage.popover.limitAria': '{label}: {percent} used',
} as const;
