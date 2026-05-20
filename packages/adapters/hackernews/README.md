# @atlas/adapter-hackernews

Hacker News source adapter for the Cursor Community Atlas.

**Spec refs.** SPEC.md §5.1 (source adapter contract), §5.2.6 (HN source
spec), §3.5 (raw table convention), §6.1 (raw → normalized pipeline).

## What this adapter ingests

For every Hacker News item (story or comment) mentioning Cursor in the
Algolia HN search index, the adapter produces one `RawHackerNewsItem` that
captures the upstream JSON hit in a structured envelope:

- `hnItemId` (matches HN's `objectID`), `itemType` (`story` | `comment` |
  `poll` | `unknown`), canonical permalink, payload SHA-256 hash, fetch
  timestamp.
- The verbatim Algolia hit — title, URL, author, points, comment counts,
  parent / story linkage, tags.

The normalizer then converts each `RawHackerNewsItem` into a deterministic
`NormalizedRecord[]`:

| Output record | How many | Notes |
|---|---|---|
| `Communication` | 1 per item | Maps to SPEC.md §3.2.4 Communication fields with `source_platform=hackernews`. |
| `Person` | 1 per non-deleted item | Carries the author's `platform_identities` (HN handle + profile URL). |

Deleted or dead items (Algolia author=`null` or content body matches
`[deleted]` / `[dead]`) normalize to `[]` — the raw row is still persisted
so future re-normalization can recover from upstream changes.

**Edges are NOT emitted here.** `communication_mentions_person` and
`person_platform_identity` rows are synthesized by the identity-resolution
service, which reads `NormalizedRecord[]` and applies resolution policy
(SPEC.md §4).

## Architecture

Three layers, each in its own file so unit tests can exercise normalization
without HTTP and HTTP without normalization:

1. **HTTP client** (`client.ts::AlgoliaHackerNewsClient`) wraps the
   public Algolia HN Search API
   (`https://hn.algolia.com/api/v1/search_by_date`). No new runtime
   dependencies — Node 20+ ships `globalThis.fetch` natively.
2. **Adapter** (`adapter.ts::HackerNewsAdapter`) extends
   `BaseSourceAdapter<RawHackerNewsItem>`, paginates Algolia one page per
   `fetchPage`, and persists hits through an injected `RawHackerNewsStore`.
3. **Normalizer** (`normalizer.ts::normalizeHackerNewsItem`) is a pure
   function from `RawHackerNewsItem` → `NormalizedRecord[]`. Deterministic
   and side-effect free.

```
packages/adapters/hackernews/
├── src/
│   ├── adapter.ts            # HackerNewsAdapter + InMemoryRawHackerNewsStore
│   ├── client.ts             # Algolia HN HTTP client
│   ├── normalizer.ts         # RawHackerNewsItem → NormalizedRecord[]
│   ├── types.ts              # RawHackerNewsItem, HackerNewsAlgoliaHit, …
│   ├── cli.ts                # one-shot fetch CLI
│   ├── adapter.test.ts
│   ├── normalizer.test.ts
│   ├── __fixtures__/
│   │   ├── search_story.json
│   │   ├── search_comment.json
│   │   ├── search_deleted.json
│   │   ├── search_no_url.json
│   │   ├── search_multi_author.json
│   │   └── expected_normalized.json
│   └── index.ts              # public surface
├── scripts/
│   └── generate-fixture.ts   # regenerate expected_normalized.json
└── package.json
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HACKERNEWS_BASE_URL` | `https://hn.algolia.com` | Override the Algolia origin (useful for local mocks). |
| `HACKERNEWS_QUERY` | `cursor` | Override the search query. |
| `LOG_LEVEL` | `info` | Pino log level. |

Hacker News requires no authentication — Algolia exposes the search API
publicly with a generous rate limit (~600 req/min).

## One-shot fetch (local)

The CLI runs the adapter end-to-end against the live Algolia API and
reports counts. It's the operator-facing smoke test for the adapter.

```sh
# from the repo root
pnpm --filter @atlas/adapter-hackernews cli

# or, directly
pnpm tsx packages/adapters/hackernews/src/cli.ts

# useful flags
pnpm tsx packages/adapters/hackernews/src/cli.ts --limit=20
pnpm tsx packages/adapters/hackernews/src/cli.ts --query=cursor --max-pages=2
pnpm tsx packages/adapters/hackernews/src/cli.ts --since-unix=1779000000
pnpm tsx packages/adapters/hackernews/src/cli.ts --json > out.json
```

## Tests

```sh
pnpm vitest run packages/adapters/hackernews
```

Tests cover:

- Typical story (URL, title, points) — `search_story.json`
- Typical comment (parent_id, story linkage) — `search_comment.json`
- Deleted (null author) + dead (`[dead]` body) items — `search_deleted.json`
- Ask HN with no URL — `search_no_url.json`
- Multi-author thread (one Person per distinct author) — `search_multi_author.json`
- Adapter idempotency (re-running yields zero new raw rows)
- Cursor-encoded pagination across multiple Algolia pages
- `maxPages` safety bound
- `numericFilters=created_at_i>X` incremental polling
- Normalizer determinism (byte-for-byte stable output)
- Snapshot match against `expected_normalized.json`

## Inngest function

`packages/workflows/_shared/src/hackernews-fetch.ts` exposes
`hackernewsFetch` (ID `hackernews-fetch`) on a `*/30 * * * *` cron per
SPEC.md §5.2.6. The same module also exports `runHackernewsFetch`, the
pure-function entry point used by integration tests and ad-hoc scripts.
Each side effect lives in its own `step.run('...')` so Inngest's
durable-execution guarantees apply.

## Known limitations

1. **Persistence is in-memory.** The adapter accepts a `RawHackerNewsStore`;
   the default `InMemoryRawHackerNewsStore` is wired for tests, the CLI,
   and the Phase 2 Inngest workflow. A Supabase-backed store is deferred
   until the corresponding `packages/db/queries/communication.ts` helpers
   land. The migration that creates `raw_hackernews_item` already exists
   in `infra/migrations/0001_initial_schema.sql` (SPEC.md §3.5).
2. **No cross-run checkpoint.** The Inngest workflow does not persist its
   high-watermark `created_at_i` between runs because the checkpoint
   store has not been built yet. Idempotency from the `hnItemId` unique
   constraint (eventually enforced by the DB) is the primary deduplication
   mechanism, with the in-memory store serving the same role for now.
3. **Cursor-relevance scoring is deferred.** SPEC.md §3.2.4 defines
   `cursor_relevance_score` but classification lives in
   `packages/intelligence/classification` (Phase 3). The normalizer sets
   `is_about_cursor=true` (the query enforces this) and leaves the score
   to downstream services.
4. **Algolia search is fuzzy.** A query for "cursor" matches HN items
   mentioning *any* `cursor` (database cursors, mouse cursors, the Cursor
   editor, etc). False positives are filtered downstream by the
   classification service.

## Follow-up

When `packages/db/queries/communication.ts` exposes
`insertRawHackerNewsItem` / `getRawHackerNewsItemById` /
`markRawHackerNewsItemNormalized`, add a `SupabaseRawHackerNewsStore`
class mirroring `SupabaseRawLumaStore` and swap it into the Inngest
function. The adapter constructor signature already accepts a
`RawHackerNewsStore` so the swap is a one-line change at every call site.
