import { useCallback } from "react"
import { sendPrompt } from "@/lib/claude/send"
import type { PermissionMode } from "@/lib/claude/types"

// ---------------------------------------------------------------------------
// Prompt submission — no optimistic layer (D9): the host emits the user message
// right after `claude:session.send` and the event stream renders it.
// ---------------------------------------------------------------------------

export type SubmitInput = {
  sessionID: string
  text: string
  /** Main-thread agent name. */
  agent?: string
  /** Permission mode. */
  mode?: PermissionMode
  model: { providerID: string; modelID: string }
  command?: { name: string; args: string }
  images?: Array<{ id?: string; type: "file"; mime: string; url: string; filename: string }>
}

export function usePromptSubmit() {
  return useCallback(async (input: SubmitInput) => {
    await sendPrompt({
      sessionId: input.sessionID,
      text: input.text,
      modelID: input.model.modelID,
      agent: input.agent,
      mode: input.mode,
      files: input.images,
      command: input.command,
    })
    return true
  }, [])
}
