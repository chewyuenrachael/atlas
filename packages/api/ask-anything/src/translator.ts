/**
 * Natural-language → SQL via Claude (Anthropic Messages API).
 *
 * Uses native `fetch` against the public Anthropic endpoint so we don't
 * pull the @anthropic-ai/sdk into the cockpit bundle. Falls back to a
 * deterministic error result if `ANTHROPIC_API_KEY` is unset — the cockpit
 * surfaces this as a "free-form queries need ANTHROPIC_API_KEY" UI state.
 *
 * Spec ref: SPEC.md §7.3.
 */
import { ATLAS_SCHEMA_BRIEF } from './schema-context.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 600;

export interface TranslateResult {
  ok: boolean;
  sql?: string;
  errorMessage?: string;
  /** Wall-clock ms spent in the Anthropic call. */
  translationMs: number;
}

/**
 * Translate `question` into a single SELECT statement. The returned `sql`
 * is the raw model output, stripped of markdown fences and trimmed.
 *
 * Never throws — failures come back as `{ ok: false, errorMessage }`.
 */
export async function translateQuestionToSql(question: string): Promise<TranslateResult> {
  const t0 = Date.now();
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return {
      ok: false,
      errorMessage:
        'ANTHROPIC_API_KEY is not configured — free-form questions require Claude access. The chips above work without it.',
      translationMs: 0,
    };
  }

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    system: ATLAS_SCHEMA_BRIEF,
    messages: [
      {
        role: 'user',
        content: `Question: ${question}\n\nReturn ONLY the SQL.`,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return {
      ok: false,
      errorMessage: `Anthropic request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      translationMs: Date.now() - t0,
    };
  }

  const translationMs = Date.now() - t0;
  if (!response.ok) {
    let detail = '';
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      detail = data.error?.message ?? '';
    } catch {
      // ignore
    }
    return {
      ok: false,
      errorMessage: `Anthropic ${response.status}${detail ? `: ${detail}` : ''}`,
      translationMs,
    };
  }

  const payload = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text =
    (payload.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim() ?? '';
  if (!text) {
    return {
      ok: false,
      errorMessage: "I couldn't translate that question, try rephrasing.",
      translationMs,
    };
  }

  const sql = stripFences(text);
  return { ok: true, sql, translationMs };
}

/** Remove ```sql fences and any leading "SQL:" prefix the model occasionally adds. */
function stripFences(text: string): string {
  let out = text.trim();
  // Code fence
  const fence = /^```(?:sql)?\s*([\s\S]*?)```$/i;
  const fenceMatch = fence.exec(out);
  if (fenceMatch && fenceMatch[1]) {
    out = fenceMatch[1].trim();
  }
  // Leading "SQL:"
  out = out.replace(/^sql\s*:\s*/i, '').trim();
  return out;
}
