import type { Session } from "@/lib/claude/types";
import { claudeClient } from "@/lib/claude/client";
import { retry } from "@/sync/retry";

export type GlobalSessionRecord = Session & {
    project?: {
        id: string;
        name?: string;
        worktree?: string;
    } | null;
};

const toNumber = (value: string | null): number | null => {
    if (!value) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const readResponseHeader = (response: unknown, header: string): string | null => {
    if (!response || typeof response !== "object") {
        return null;
    }
    const container = response as { headers?: unknown };
    const headers = container.headers;
    if (!headers || typeof headers !== "object") {
        return null;
    }

    const maybeGet = headers as { get?: (name: string) => string | null };
    if (typeof maybeGet.get === "function") {
        return maybeGet.get(header);
    }

    const maybeRecord = headers as Record<string, unknown>;
    const direct = maybeRecord[header] ?? maybeRecord[header.toLowerCase()];
    return typeof direct === "string" ? direct : null;
};

export const readNextCursor = (response: unknown): number | null => {
    return toNumber(readResponseHeader(response, "x-next-cursor"));
};

export const isMissingGlobalSessionsEndpointError = (error: unknown): boolean => {
    if (!error || typeof error !== "object") {
        return false;
    }

    const value = error as {
        status?: number;
        response?: { status?: number };
        cause?: { status?: number; response?: { status?: number } };
    };

    const status = value.status
        ?? value.response?.status
        ?? value.cause?.status
        ?? value.cause?.response?.status;

    return status === 404;
};

/**
 * List sessions for the workspace via `claude:session.list`. The host returns the whole list in
 * one call.
 */
export async function listGlobalSessionPages(
    options: {
        pageSize: number;
        onPage?: (sessions: GlobalSessionRecord[]) => void;
    },
): Promise<GlobalSessionRecord[]> {
    const sessions = await retry(
        () => claudeClient.listSessions(),
        { attempts: 3, delay: 500, retryIf: () => true },
    );
    const seenIds = new Set<string>();
    const all: GlobalSessionRecord[] = [];
    for (const session of sessions as GlobalSessionRecord[]) {
        if (!session?.id || seenIds.has(session.id)) continue;
        seenIds.add(session.id);
        all.push(session);
    }
    if (all.length > 0) options.onPage?.(all);
    return all;
}
