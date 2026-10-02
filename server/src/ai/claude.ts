import { config } from '../config.js';
import { HttpError } from '../http.js';
import { one } from '../db.js';
import { decodeAiKey } from './aiKeys.js';

// Hard ceiling on an Anthropic call. Generous (vision + large outputs are slow)
// but finite, so a hung upstream can't hold a request — and its DB connection —
// open indefinitely. On timeout the call fails with a 504 "timed out" message.
const AI_TIMEOUT_MS = 60_000;

export class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not configured. Add an Anthropic API key in Settings, or set ANTHROPIC_API_KEY on the server.');
    this.name = 'AiNotConfiguredError';
  }
}

// Resolve the effective Anthropic key + model for the current request: the signed-in
// user's saved key (if any), otherwise the server's env key. Runs on the request-scoped
// connection, so it reads the user named by app.user_id.
export async function resolveAiCreds(): Promise<{ apiKey: string; model: string }> {
  let apiKey = config.anthropicApiKey;
  let model = config.anthropicModel;
  try {
    const row = await one<{ ai_api_key: string | null; ai_model: string | null }>(
      `SELECT ai_api_key, ai_model FROM users WHERE id = current_setting('app.user_id', true)::int`
    );
    const personal = decodeAiKey(row?.ai_api_key);
    if (personal) apiKey = personal;
    if (row?.ai_model && row.ai_model.trim()) model = row.ai_model.trim();
  } catch { /* no tenant context (or column missing) — fall back to env */ }
  return { apiKey, model };
}

interface AskOptions {
  system?: string;
  maxTokens?: number;
}

// User-facing messages for Anthropic failures. Anthropic's response body is logged on
// the server but never sent to the client (it can carry request details).
export function anthropicFailure(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(502, 'Anthropic rejected the API key. Check it in AI Settings.');
  if (status === 429) return new HttpError(503, 'Anthropic is rate-limiting requests. Try again in a minute.');
  if (status === 529 || status >= 500) return new HttpError(503, 'Anthropic is temporarily unavailable. Try again shortly.');
  if (status === 400 || status === 404) return new HttpError(502, `The AI request failed (status ${status}). Check the model in AI Settings.`);
  return new HttpError(502, `The AI request failed (status ${status}).`);
}

// POST to the Messages API and return the response's text blocks joined. Bounded by
// AI_TIMEOUT_MS so a stalled upstream can't pin the request's DB connection.
async function callMessages(apiKey: string, payload: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new HttpError(504, 'The AI request timed out. Try again.');
    }
    console.error('Anthropic request failed:', e?.message ?? e);
    throw new HttpError(502, "Couldn't reach Anthropic. Check the server's internet connection and try again.");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Anthropic API error (${res.status}): ${body.slice(0, 500)}`);
    throw anthropicFailure(res.status);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

/**
 * Send a prompt to Claude and return the text response.
 * Uses the standard Anthropic Messages API.
 */
export async function ask(prompt: string, opts: AskOptions = {}): Promise<string> {
  const { apiKey, model } = await resolveAiCreds();
  if (!apiKey) throw new AiNotConfiguredError();

  return callMessages(apiKey, {
    model,
    max_tokens: opts.maxTokens ?? 1500,
    system:
      opts.system ??
      'You are a precise, practical personal-finance analyst. Be concrete, use the numbers you are given, show your arithmetic briefly, and format the answer in clean Markdown. Do not invent data that was not provided.',
    messages: [{ role: 'user', content: prompt }],
  });
}

/**
 * Send one or more images plus a prompt to Claude's vision API and return the
 * text response. Used to extract structured data from receipt photos.
 */
export async function askVision(
  images: { data: string; mime: string }[],
  prompt: string,
  opts: AskOptions = {}
): Promise<string> {
  const { apiKey, model } = await resolveAiCreds();
  if (!apiKey) throw new AiNotConfiguredError();

  // PDFs go in a 'document' block; images in an 'image' block.
  const content: any[] = images.map((img) => (
    img.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: img.data } }
      : { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }
  ));
  content.push({ type: 'text', text: prompt });

  return callMessages(apiKey, {
    model,
    max_tokens: opts.maxTokens ?? 2000,
    system: opts.system ?? 'You extract structured data from images precisely and return only what is asked.',
    messages: [{ role: 'user', content }],
  });
}
