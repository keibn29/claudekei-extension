/**
 * Prompt composition for `claude:session.send`.
 *
 * Existing UI code hands over a main text plus optional preface/context parts and attachments.
 * Claude takes one prompt string plus base64 files, so context parts are folded into the text
 * (selection context stays a fenced block, `@path` mentions stay inline) and attachments that are
 * not inline data URLs (server-side file mentions) are dropped.
 */

import { claudeClient } from './client';
import type { SendFile } from './protocol';
import { isPermissionModeValue } from './permissionMode';
import type { EffortLevel, PermissionMode } from './types';

export type SendFileInput = {
  mime: string;
  filename?: string;
  url: string;
};

export type SendAdditionalPart = {
  text: string;
  synthetic?: boolean;
  files?: SendFileInput[];
};

export type ComposePromptInput = {
  text: string;
  prefaceText?: string;
  files?: SendFileInput[];
  additionalParts?: SendAdditionalPart[];
};

const isDataUrl = (url: string): boolean => url.startsWith('data:');

const isHeicMime = (mime: string): boolean => {
  const lower = mime.toLowerCase();
  return lower === 'image/heic' || lower === 'image/heif';
};

/** Claude does not accept HEIC/HEIF, so convert to JPEG in the browser before sending. */
const convertHeicToJpeg = async (file: SendFileInput): Promise<SendFileInput> => {
  try {
    const heic2any = (await import('heic2any')).default;
    const commaIndex = file.url.indexOf(',');
    if (commaIndex === -1) return file;
    const binary = atob(file.url.substring(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const jpegBlob = (await heic2any({
      blob: new Blob([bytes], { type: file.mime }),
      toType: 'image/jpeg',
      quality: 0.9,
    })) as Blob;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(jpegBlob);
    });
    return {
      mime: 'image/jpeg',
      filename: file.filename?.replace(/\.(heic|heif)$/i, '.jpg'),
      url: dataUrl,
    };
  } catch (error) {
    console.warn('Failed to convert HEIC to JPEG:', error);
    return file;
  }
};

const toSendFile = async (file: SendFileInput): Promise<SendFile> => {
  const normalized = isHeicMime(file.mime) ? await convertHeicToJpeg(file) : file;
  return {
    mime: normalized.mime,
    filename: normalized.filename || 'attachment',
    dataUrl: normalized.url,
  };
};

/** Fold preface, main text and context parts into one prompt string. */
export const composePromptText = (input: ComposePromptInput): string => {
  const chunks: string[] = [];
  if (input.prefaceText?.trim()) chunks.push(input.prefaceText.trim());
  if (input.text?.trim()) chunks.push(input.text.trim());
  for (const part of input.additionalParts ?? []) {
    if (part.text?.trim()) chunks.push(part.text.trim());
  }
  return chunks.join('\n\n');
};

/** Collect inline attachments from the main files and every additional part. */
export const collectSendFiles = async (input: ComposePromptInput): Promise<SendFile[]> => {
  const candidates = [
    ...(input.files ?? []),
    ...(input.additionalParts ?? []).flatMap((part) => part.files ?? []),
  ].filter((file) => isDataUrl(file.url));
  return Promise.all(candidates.map(toSendFile));
};

export type SendPromptInput = ComposePromptInput & {
  sessionId: string;
  modelID?: string;
  /** Main-thread agent name (a plugin primary agent such as `claudekei:orchestrator`). */
  agent?: string;
  /** Permission mode (separate from the agent). */
  mode?: PermissionMode;
  /** Effort for this and following turns; `null` = model default, `undefined` = leave the session's choice alone. */
  effort?: EffortLevel | null;
  /** Slash command to run instead of a plain prompt. */
  command?: { name: string; args: string };
};

/** Send a prompt (or slash command) to a session. Resolves with the host-assigned message id. */
export const sendPrompt = async (input: SendPromptInput): Promise<string> => {
  const text = composePromptText(input);
  const files = await collectSendFiles(input);
  if (!input.command && text.length === 0 && files.length === 0) {
    throw new Error('Message must have at least one part (text or file)');
  }
  const { messageId } = await claudeClient.send({
    sessionId: input.sessionId,
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.modelID ? { model: input.modelID } : {}),
    ...(input.agent?.trim() ? { agent: input.agent.trim() } : {}),
    ...(isPermissionModeValue(input.mode) ? { mode: input.mode } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  return messageId;
};
