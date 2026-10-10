/**
 * Read-only slash command list mirrored from the host catalog (chat autocomplete, session-ui-store).
 * Command files are created and edited through `useClaudeConfigStore`.
 */
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools } from "zustand/middleware";
import { claudeHost } from "@/lib/claude/host";
import { subscribeBootstrapCache } from "@/lib/claude/bootstrapCache";

export type CommandScope = 'user' | 'project';

export interface Command {
  name: string;
  description?: string;
  agent?: string | null;
  model?: string | null;
  template?: string;
  scope?: CommandScope;
  isBuiltIn?: boolean;
}

export const isCommandBuiltIn = (command: Command): boolean => {
  return command.isBuiltIn === true;
};

const buildCommandsSignature = (commands: Command[]): string =>
  commands
    .map((command) => [
      command.name,
      command.scope ?? '',
      command.description ?? '',
      command.agent ?? '',
      command.model ?? '',
      String(command.isBuiltIn === true),
    ].join('|'))
    .join('||');

interface CommandsStore {
  commands: Command[];
  isLoading: boolean;
  loadCommands: () => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_commands_store__?: UseBoundStore<StoreApi<CommandsStore>>;
  }
}

let loadInFlight: Promise<boolean> | null = null;

export const useCommandsStore = create<CommandsStore>()(
  devtools(
    (set, get) => ({
      commands: [],
      isLoading: false,

      loadCommands: () => {
        if (loadInFlight) return loadInFlight;
        loadInFlight = (async () => {
          set({ isLoading: true });
          try {
            const commands = await claudeHost.listCommandsWithDetails();
            // The catalog marks Claude's own commands as `source: 'command'`; plugin/user skills are `skill`.
            const next: Command[] = commands.map((cmd) => ({
              name: cmd.name,
              description: cmd.description,
              template: cmd.template,
              isBuiltIn: cmd.source === 'command',
            }));
            if (buildCommandsSignature(get().commands) !== buildCommandsSignature(next)) {
              set({ commands: next, isLoading: false });
            } else {
              set({ isLoading: false });
            }
            return true;
          } catch (error) {
            console.error("Failed to load commands:", error);
            set({ isLoading: false });
            return false;
          } finally {
            loadInFlight = null;
          }
        })();
        return loadInFlight;
      },
    }),
    { name: "commands-store" },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_commands_store__ = useCommandsStore;
  subscribeBootstrapCache(() => {
    if (useCommandsStore.getState().commands.length > 0) {
      void useCommandsStore.getState().loadCommands();
    }
  });
}
