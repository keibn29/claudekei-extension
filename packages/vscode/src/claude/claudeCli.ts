/**
 * Runs subcommands of the installed `claude` CLI (`mcp add-json`, `plugin enable`, ...). Claude Code locks `~/.claude.json`
 * and `settings.json`, so those files are only ever changed through the CLI (docs/SETTINGS_USAGE_SPEC.md section 0).
 */
import { execFile } from 'node:child_process';

export type CliRunner = (args: string[], o: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** `resolveExecutable` is called per run (the executable setting may change); undefined = no CLI available. */
export function createCliRunner(resolveExecutable: () => string | undefined): CliRunner {
  return (args, o) =>
    new Promise((resolve, reject) => {
      const executable = resolveExecutable();
      if (!executable) {
        reject(new Error('Claude Code executable not found'));
        return;
      }
      execFile(executable, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ stdout, stderr });
      });
    });
}
