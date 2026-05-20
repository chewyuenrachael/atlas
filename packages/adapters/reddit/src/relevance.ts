/**
 * Cursor-relevance scoring for Reddit posts and comments.
 *
 * Reddit's search hits a lot of false positives: "move the cursor", SQL
 * cursors, the cursor pagination pattern, etc. Before persisting a raw
 * record we score every candidate body and drop anything that doesn't
 * mention `cursor` at a word boundary. Posts in subreddits where Cursor-
 * the-editor is the obvious referent (r/cursor) get a higher base score;
 * generic subreddits depend on co-occurring AI/IDE terms to boost above
 * the noise floor.
 *
 * Pure function. Deterministic. Tested directly in `normalizer.test.ts`
 * via the public adapter surface and indirectly through fixture replays.
 *
 * SPEC ref: SPEC.md §5.2.5 (Reddit normalization output).
 */
import type { CursorRelevance } from './types.js';

/** Subreddits where any cursor mention is high-confidence about Cursor. */
const PRIMARY_SUBREDDITS = new Set([
  'cursor',
  'cursor_ai',
  'cursorai',
  'cursoride',
  'cursorcommunity',
]);

/**
 * Subreddits where Cursor is a plausible (but not default) referent. The
 * cursor IDE is part of the discourse in these communities.
 */
const SECONDARY_SUBREDDITS = new Set([
  'machinelearning',
  'localllama',
  'programming',
  'webdev',
  'learnprogramming',
  'chatgptcoding',
  'artificial',
  'singularity',
]);

/** Tokens that strongly correlate with Cursor-the-editor. */
const BOOST_TERMS: ReadonlyArray<{ token: string; weight: number }> = [
  { token: 'ide', weight: 0.15 },
  { token: 'editor', weight: 0.15 },
  { token: 'ai', weight: 0.1 },
  { token: 'coding', weight: 0.1 },
  { token: 'vscode', weight: 0.15 },
  { token: 'copilot', weight: 0.15 },
  { token: 'composer', weight: 0.2 },
  { token: 'agent', weight: 0.1 },
  { token: 'llm', weight: 0.1 },
  { token: 'autocomplete', weight: 0.1 },
  { token: 'tab', weight: 0.05 },
  { token: 'claude', weight: 0.1 },
  { token: 'gpt', weight: 0.1 },
  { token: 'anysphere', weight: 0.3 },
];

/**
 * Tokens that strongly suggest a *different* "cursor": SQL/DB cursors,
 * pagination cursors, the visible insertion caret. Their presence does
 * not zero the score but reduces it.
 */
const NEGATIVE_TERMS: ReadonlyArray<{ token: string; weight: number }> = [
  { token: 'sql', weight: 0.1 },
  { token: 'postgres', weight: 0.1 },
  { token: 'mysql', weight: 0.1 },
  { token: 'mongodb', weight: 0.1 },
  { token: 'pagination', weight: 0.1 },
  { token: 'fetchall', weight: 0.1 },
  { token: 'mouse', weight: 0.05 },
  { token: 'caret', weight: 0.05 },
];

const CURSOR_WORD_RE = /\bcursor\b/i;
/** Conservative tokenizer: word characters, lowercased. */
const TOKEN_RE = /[a-z0-9_]+/gi;

/**
 * Compute the cursor-relevance for a piece of text in a subreddit context.
 *
 * Score components:
 *   - Base 0.4 floor when "cursor" matches at a word boundary.
 *   - +0.4 when the subreddit is a primary Cursor community.
 *   - +0.2 when the subreddit is a known dev/AI community.
 *   - +sum(boost weights) for each co-occurring term that fires.
 *   - −sum(negative weights) for each anti-signal term.
 *   - Clamped to [0, 1] and rounded to 3 decimal places.
 *
 * @param text - Combined title + body (posts) or body (comments).
 * @param subreddit - Display name of the subreddit, lowercased.
 *
 * @example
 * ```ts
 * const rel = computeCursorRelevance('I love the Cursor IDE for AI coding', 'programming');
 * // → { score: 0.85, matchedCursor: true, boostTerms: ['ide','ai','coding'], tokenCount: 8 }
 * ```
 */
export function computeCursorRelevance(text: string, subreddit: string): CursorRelevance {
  const safeText = text ?? '';
  const matchedCursor = CURSOR_WORD_RE.test(safeText);
  const tokens = tokenize(safeText);
  const tokenSet = new Set(tokens);

  if (!matchedCursor) {
    return {
      score: 0,
      matchedCursor: false,
      boostTerms: [],
      tokenCount: tokens.length,
    };
  }

  let score = 0.4;

  const sub = subreddit.toLowerCase();
  if (PRIMARY_SUBREDDITS.has(sub)) score += 0.4;
  else if (SECONDARY_SUBREDDITS.has(sub)) score += 0.2;

  const boostTerms: string[] = [];
  for (const { token, weight } of BOOST_TERMS) {
    if (tokenSet.has(token)) {
      score += weight;
      boostTerms.push(token);
    }
  }

  for (const { token, weight } of NEGATIVE_TERMS) {
    if (tokenSet.has(token)) score -= weight;
  }

  const clamped = Math.max(0, Math.min(1, score));
  return {
    score: Math.round(clamped * 1000) / 1000,
    matchedCursor: true,
    boostTerms,
    tokenCount: tokens.length,
  };
}

/** Tokenize to lowercased alphanumeric tokens. Empty/whitespace input -> []. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  const matches = lower.matchAll(TOKEN_RE);
  for (const m of matches) out.push(m[0]);
  return out;
}
