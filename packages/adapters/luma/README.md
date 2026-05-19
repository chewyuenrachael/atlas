# @atlas/adapter-luma

Luma source adapter for the Cursor Community Atlas.

**Spec refs.** SPEC.md §5.1 (source adapter contract), §5.2.1 (Luma source
spec), §3.5 (raw table convention), §6.1 (raw → normalized pipeline).

## What this adapter ingests

For every event listed on the configured Luma community page (default:
`https://lu.ma/cursorcommunity`), the adapter produces one `RawLumaEvent`
that captures the scraped HTML in a structured envelope:

- Slug, canonical URL, payload SHA-256 hash, scrape timestamp.
- Title, description, start/end ISO, timezone, registered count, format.
- Venue name, address, city, country.
- Organizer list — one per host on the event page, each with their Luma
  handle, profile URL, avatar, and any Twitter/GitHub/LinkedIn links lifted
  from the page.

The normalizer then converts each `RawLumaEvent` into a deterministic
`NormalizedRecord[]`:

| Output record | How many | Notes |
|---|---|---|
| `Event` | 1 per event | Maps to SPEC.md §3.2.3 Event fields. |
| `Person` | 1 per organizer | Each carries `platform_identities` for Luma + any external links found on the page. |

**Edges are NOT emitted here.** `person_event` and `person_platform_identity`
rows are synthesized by the identity-resolution service in Phase 1C, which
reads `NormalizedRecord[]` and applies resolution policy (SPEC.md §4).

## Architecture

Two layers, separated so unit tests can exercise parsing without launching a
browser:

1. **Page fetchers** (`scraper.ts::scrapeCommunityPage`,
   `scrapeEventDetail`) launch headless Chromium via Playwright, render the
   React-rendered page, and return the final HTML. They honor a filesystem
   cache under `.cache/luma/` (gitignored) so development never hammers
   Luma.
2. **Pure HTML parsers** (`parseCommunityPageHtml`, `parseEventDetailHtml`)
   are pure functions over an HTML string. They inspect, in priority order:
   the Next.js `__NEXT_DATA__` JSON, JSON-LD `application/ld+json` blocks,
   then Open Graph meta tags, then anchor hrefs and visible text.

The `LumaAdapter` class composes the two layers and implements the
`SourceAdapter<RawLumaEvent>` contract (SPEC.md §5.1) by extending
`BaseSourceAdapter`. The base class provides the rate limiter, retry
policy, and structured logging.

```
packages/adapters/luma/
├── src/
│   ├── adapter.ts            # LumaAdapter + InMemoryRawLumaStore
│   ├── scraper.ts            # playwright + pure HTML parsers
│   ├── normalizer.ts         # RawLumaEvent → NormalizedRecord[]
│   ├── types.ts              # RawLumaEvent, ScrapedEventDetail, …
│   ├── cli.ts                # one-shot fetch CLI
│   ├── adapter.test.ts
│   ├── normalizer.test.ts
│   ├── scraper.test.ts
│   ├── __fixtures__/
│   │   ├── community_page.html
│   │   ├── event_detail.html
│   │   ├── event_detail_minimal.html
│   │   ├── event_detail_malformed.html
│   │   └── expected_normalized.json
│   └── index.ts              # public surface
├── scripts/
│   └── generate-fixture.ts   # regenerate expected_normalized.json
└── package.json
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LUMA_BASE_URL` | `https://lu.ma` | Override the Luma base origin (useful for local mocks). |
| `LUMA_COMMUNITY_SLUG` | `cursorcommunity` | Override the community page slug to ingest. |
| `ATLAS_ENV` | `development` | When `development`, the scraper auto-enables filesystem HTML caching under `.cache/luma/`. |
| `LOG_LEVEL` | `info` | Pino log level. |

`LUMA_API_KEY` is declared in `.env.example` for forward-compatibility but is
intentionally **not used** by this adapter — see "Known limitations" below.

## One-shot fetch (local)

The CLI runs the adapter end-to-end against the live community page and
reports counts. It's the operator-facing smoke test.

```sh
# from the repo root
pnpm --filter @atlas/adapter-luma cli

# or, directly:
pnpm tsx packages/adapters/luma/src/cli.ts

# useful flags
pnpm tsx packages/adapters/luma/src/cli.ts --no-cache
pnpm tsx packages/adapters/luma/src/cli.ts --community=cursorcommunity --limit=3
pnpm tsx packages/adapters/luma/src/cli.ts --json > out.json
```

The first run downloads Chromium via Playwright. If you see a "missing
browser" error, run:

```sh
pnpm exec playwright install chromium
```

Cached HTML is written to `.cache/luma/`. Delete that folder to force a
re-scrape.

## Tests

```sh
pnpm vitest run packages/adapters/luma
```

Tests cover:

- Typical event (full JSON-LD + `__NEXT_DATA__`) — `event_detail.html`
- Event with multiple organizers and external links — same fixture
- Event with only minimal metadata (no organizers, no times) — `event_detail_minimal.html`
- Malformed HTML (truncated tags, invalid JSON-LD) — `event_detail_malformed.html`
- Community page parsing from both `__NEXT_DATA__` and anchor hrefs
- Adapter idempotency (re-running produces zero new rows)
- Adapter resilience (one event's scrape failure does not block the rest)
- Normalizer determinism (byte-for-byte stable output)

## Inngest function

`packages/workflows/_shared/src/luma-ingest-pipeline.ts` exposes
`lumaIngestPipeline` (ID `luma-ingest-pipeline`) on a `0 */4 * * *` cron
per SPEC.md §5.2.1. The same module also exports `runLumaIngest`, the
pure-function entry point used by `scripts/backfill-luma.ts`. Each side
effect lives in its own `step.run('...')` so Inngest's durable-execution
guarantees apply.

## Known limitations

1. **Attendee data is not scraped.** Public Luma pages do not expose
   attendee lists without authentication. This is by design — attempting to
   extract them would violate Luma's auth boundary and produce unreliable
   data. SPEC.md §5.2.1 calls for attendee normalization, but the listed
   per-attendee fields require an authenticated Luma session.
   **Action:** flagged as a Phase 2+ task that requires post-employment
   Luma API access (see SPEC.md §14 Open Question #1).
2. **Persistence is in-memory.** The adapter accepts a `RawLumaStore`; the
   default `InMemoryRawLumaStore` is wired for tests and the CLI. A
   Supabase-backed store is deferred to Phase 1B once
   `packages/db/queries/event.ts` exposes `insertRawLumaEvent` and
   `getRawLumaEventById`. The migration that creates the table lives in
   `infra/migrations/0001_create_raw_luma_event.sql`.
3. **No pagination cursor.** The Luma community page is a single SPA route
   that renders all upcoming events; pagination is not yet relevant. If
   Luma adds a paginated archive view, the `fetchPage`/`Cursor` contract
   already supports it.
4. **HTML structure changes will degrade gracefully.** Parsers return
   `null` for missing fields and log warnings rather than throwing.
   Re-generate `expected_normalized.json` via
   `pnpm --filter @atlas/adapter-luma regenerate-fixture` when an
   intentional normalizer change shifts the canonical output.

## Phase 1B follow-up

When `packages/db` lands Luma-aware query helpers, swap the
`InMemoryRawLumaStore` in `LumaAdapter` for a Supabase-backed
implementation. Constructor signature already accepts a `RawLumaStore` so
the swap is a one-line change at every call site.
