/**
 * Relevance scoring tests. The score is the central content filter for the
 * Reddit adapter — false positives flood the raw table with SQL/pagination
 * noise, false negatives drop high-signal Cursor community chatter. We
 * exercise both directions explicitly.
 */
import { describe, expect, it } from 'vitest';
import { computeCursorRelevance } from './relevance.js';

describe('computeCursorRelevance', () => {
  it('returns score 0 and matchedCursor=false when the body lacks a cursor word boundary', () => {
    const rel = computeCursorRelevance('My favorite editor is VSCode for AI coding.', 'programming');
    expect(rel.matchedCursor).toBe(false);
    expect(rel.score).toBe(0);
    expect(rel.boostTerms).toEqual([]);
  });

  it('does not match "Cursor" embedded inside a larger token (substring guard)', () => {
    const rel = computeCursorRelevance('I love Cursorfish, my new pet.', 'programming');
    expect(rel.matchedCursor).toBe(false);
  });

  it('floors at 0.4 + 0.4 primary-subreddit boost = 0.8 for a bare r/cursor mention', () => {
    const rel = computeCursorRelevance('cursor is great', 'cursor');
    expect(rel.matchedCursor).toBe(true);
    expect(rel.score).toBeGreaterThanOrEqual(0.8);
  });

  it('lifts a secondary-subreddit mention via co-occurring IDE + AI + coding terms', () => {
    const rel = computeCursorRelevance(
      'I migrated from VSCode to Cursor for AI-powered coding in my IDE.',
      'programming',
    );
    expect(rel.matchedCursor).toBe(true);
    expect(rel.boostTerms.sort()).toEqual(['ai', 'coding', 'ide', 'vscode'].sort());
    expect(rel.score).toBeGreaterThanOrEqual(0.7);
  });

  it('penalizes SQL/pagination contexts even when "cursor" is present', () => {
    const lowSignal = computeCursorRelevance(
      'In Postgres you can iterate with a server-side cursor using SQL fetchAll for pagination.',
      'programming',
    );
    const highSignal = computeCursorRelevance(
      'In Cursor the editor I use the agent and composer for AI coding work.',
      'programming',
    );
    expect(lowSignal.matchedCursor).toBe(true);
    expect(highSignal.score).toBeGreaterThan(lowSignal.score);
  });

  it('is bounded in [0, 1] regardless of how many boost terms are present', () => {
    const text =
      'Cursor IDE editor AI coding vscode copilot composer agent llm autocomplete tab claude gpt anysphere';
    const rel = computeCursorRelevance(text, 'cursor');
    expect(rel.score).toBeLessThanOrEqual(1);
    expect(rel.score).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic byte-for-byte', () => {
    const text = 'Cursor IDE for AI coding';
    const a = computeCursorRelevance(text, 'programming');
    const b = computeCursorRelevance(text, 'programming');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('produces strictly higher score in primary subreddit than secondary', () => {
    const primary = computeCursorRelevance('Cursor is great', 'cursor');
    const secondary = computeCursorRelevance('Cursor is great', 'programming');
    const unknown = computeCursorRelevance('Cursor is great', 'gardening');
    expect(primary.score).toBeGreaterThan(secondary.score);
    expect(secondary.score).toBeGreaterThan(unknown.score);
  });
});
