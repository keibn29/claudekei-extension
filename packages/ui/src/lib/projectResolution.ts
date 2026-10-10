import type { ProjectEntry } from "@/lib/api/types";

export const normalizeProjectPath = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const replaced = trimmed.replace(/\\/g, "/");
  if (replaced === "/") return "/";
  return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced;
};

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if (!pp) continue;
    if (nd !== pp && !nd.startsWith(`${pp}/`)) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};
