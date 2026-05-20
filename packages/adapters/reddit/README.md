# @atlas/adapter-reddit

Reddit source adapter. See SPEC.md §5.2.5 for the source contract and §5.1 for the `SourceAdapter` interface.

## What it does

Hourly polls a curated set of subreddits for posts mentioning `cursor`, plus the top 50 comments on each surviving post:

- `r/cursor` (primary)
- `r/MachineLearning`
- `r/LocalLLaMA`
- `r/programming`
- `r/webdev`
- `r/learnprogramming`

Each raw post and comment is scored for `cursor_relevance_score` (0–1) using a deterministic keyword + co-occurring-term model implemented in `relevance.ts`. Items where `cursor` does not appear at a word boundary are dropped before persistence; everything that survives is captured as a `RawRedditItem` and normalized into one `Communication` plus (optionally) one `Person` record (skipped when the author is `[deleted]`).

## Architecture

```
client.ts      → public Reddit JSON endpoints (no OAuth needed)
relevance.ts   → cursor_relevance_score 0-1
normalizer.ts  → RawRedditItem → NormalizedRecord[]
adapter.ts     → BaseSourceAdapter wiring + in-memory raw store
cli.ts         → one-shot live fetch + relevance histogram
```

## Source

Reddit public `.json` endpoints. No OAuth required for read-only access to public listings.

- Search: `https://www.reddit.com/r/<sub>/search.json?q=cursor&restrict_sr=1&limit=25`
- Thread: `https://www.reddit.com/r/<sub>/comments/<post_id>.json?limit=50&sort=top`

Rate limit: **60 req/min** (`RATE_LIMIT_REDDIT` in `@atlas/core/constants`). Send a polite `User-Agent` header — Reddit rejects anonymous "browser-like" UAs and aggressively throttles them. Default UA is `atlas-community-bot/0.1`.

## CLI

```sh
pnpm --filter @atlas/adapter-reddit cli
pnpm --filter @atlas/adapter-reddit cli -- --subreddits=cursor,programming --posts-per=10
pnpm --filter @atlas/adapter-reddit cli -- --min-relevance=0.5 --json
```

The CLI prints raw counts, deleted-author counts, normalized records, and a cursor-relevance histogram. Use `--limit=N` for a smoke-test run that stops after N raw items.

## Persistence boundary

Phase 2 ships against an in-memory `RawRedditStore`. The Supabase-backed store will land in a follow-up PR once `packages/db/queries/reddit.ts` exposes `insertRawRedditItem`, `getRawRedditItemById`, `markRawRedditItemNormalized` (mirroring the Luma store pattern in `@atlas/adapter-luma`).
