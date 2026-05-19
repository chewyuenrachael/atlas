# AGENTS.md — Operating Manual

This document is the operating manual for every agent (human or AI) working in this repository. It complements `.cursor/rules` (which encodes mechanical conventions) and SPEC.md (the canonical technical specification).

Read this end-to-end before you touch anything.

---

## 1. Project Purpose

The Cursor Community Atlas is the keystone data layer for Cursor's community function. It converts ambient community signal across at least seven external sources into a queryable graph of people, companies, events, communications, artifacts, programs, and signals. Downstream workflows (organizer activation, champion routing, vertical programs, internal signal pull) compose off this one coherent graph.

**Who it serves.** Internal community operators, GTM partners, and engineering. It is not a customer-facing product.

**What it does not do.**
- Replace a CRM. Sales workflow stays in Salesforce/HubSpot.
- Deliver marketing outreach. The Atlas drafts; humans send via standard tools.
- Solve identity resolution perfectly. Target is 95%+ accuracy with explicit handling of remaining ambiguity.
- Serve real-time use cases. Most ingestion is hourly or daily.

See SPEC.md §1 for the full mission, goals, and non-goals.

---

## 2. SPEC.md is Canonical

`SPEC.md` is the single source of truth for the system. Every architectural decision, schema field, ingestion pipeline, and workflow downstream must trace back to a section in that document.

**Agents do not modify SPEC.md.** If you believe the spec is wrong or incomplete, open an issue or PR titled `spec:` and explain the change you would propose; do not edit SPEC.md as part of an implementation task. Material spec changes require human review and a bumped version number (SPEC.md §0).

When the spec is ambiguous on a specific decision:
1. Choose the simplest viable option.
2. Document the choice with a `TODO(spec):` comment.
3. Proceed with the most defensible default.
4. Surface the ambiguity in the PR description so it can be raised at the next spec review.

---

## 3. File Layout

```
atlas/
├── .cursor/rules                  # Mechanical conventions every agent inherits
├── .github/workflows/             # CI pipelines
├── apps/cockpit/                  # Next.js 14 App Router operator UI (SPEC §2.1 Layer 5, §11 Phase 3)
├── packages/
│   ├── core/                      # Types, constants, errors, Result, logger (SPEC §3, §4, §9.1)
│   ├── db/                        # Supabase client + named query helpers (SPEC §3, §7)
│   ├── adapters/
│   │   ├── _shared/               # BaseSourceAdapter, RateLimiter, withRetry (SPEC §5.1, §5.4, §5.5)
│   │   ├── luma/ github/ … cursor-forum/  # One folder per source (SPEC §5.2)
│   ├── intelligence/
│   │   ├── identity-resolution/   # Tier 1/2/3 resolver (SPEC §4)
│   │   ├── scoring/               # Activity, churn, organizer scoring (SPEC §4, §7.2)
│   │   └── classification/        # Persona + lifecycle (SPEC §3.2.1, §4)
│   ├── workflows/                 # Inngest workflows (SPEC §5.3, §8.3)
│   └── api/
│       ├── rest/ graphql/ ask-anything/  # Query layer (SPEC §7)
├── infra/migrations/              # Postgres migrations (SPEC §3, §11 Phase 1)
├── SPEC.md                        # Canonical specification (DO NOT MODIFY)
├── AGENTS.md                      # This file
├── package.json, pnpm-workspace.yaml, tsconfig.base.json, …
```

The layout mirrors the 5-layer architecture in SPEC.md §2.1: ingestion (adapters), data foundation (db, migrations), intelligence (intelligence/), workflows (workflows/), cockpit + APIs (apps/cockpit, packages/api).

---

## 4. How to Add a New Adapter

See SPEC.md §5 for the full source adapter contract, §5.1 for the `SourceAdapter` interface, and §5.2 for per-source specifications.

**Recipe:**

1. **Read.** SPEC.md §5.1 (interface), §5.2.x (target source), §3.5 (raw table conventions).
2. **Scaffold.** The folder `packages/adapters/<name>/` already exists from Phase 0. It contains a `package.json`, `tsconfig.json`, and an empty `src/index.ts`.
3. **Define raw types.** In `src/types.ts`, write the TypeScript shape of one raw record exactly as the source returns it. No transformation.
4. **Implement the adapter class.** In `src/adapter.ts`, extend `BaseSourceAdapter<RawXyzRecord>` and implement:
   - `sourceName`
   - `rateLimit` (import from `@atlas/core/constants`)
   - `idempotencyKey`
   - `fetchPage`, `persistRaw`, `normalizeRaw`
5. **Add the raw table migration.** New file `infra/migrations/NNNN_create_raw_<source>.sql`. Follow the schema convention in SPEC.md §3.5: UUID PK, source ID unique, JSONB payload, ingestion timestamps, normalization status.
6. **Add an Inngest function.** One file per function in `packages/workflows/<source>-fetch.ts`. ID matches file name. Cron from SPEC.md §5.2.x schedule.
7. **Add tests.** `src/normalize.test.ts` with one or more JSON fixtures in `src/__fixtures__/`. Vitest.
8. **Open a PR.** Title format `feat(adapters/<source>): …`. Body includes `Spec ref: §5.2.x`.

Definition of done for an adapter:
- The adapter's `normalize.test.ts` passes on at least three real-world fixtures.
- The Inngest function appears in the Inngest dashboard after the next deploy.
- A `SELECT COUNT(*) FROM raw_<source>` against a staging DB returns a sensible number within an hour of the first scheduled run.

---

## 5. How to Add a New Workflow

See SPEC.md §8.3.

**Recipe:**

1. **Read.** SPEC.md §8.3 (extension model), §5.3 (Inngest patterns), §6.3 (event-driven CDC).
2. **Decide the trigger.** Cron, event, or webhook? Cron is the default.
3. **Create the file.** `packages/workflows/<workflow-name>.ts`. One function per file. File name matches `inngest.createFunction({ id: '<workflow-name>' })`.
4. **Compose intelligence services.** Workflows should not contain business logic of their own; they orchestrate calls to `@atlas/intelligence-*` and `@atlas/db` helpers.
5. **One `step.run(...)` per side effect.** Step bodies must be idempotent — Inngest will retry them on failure.
6. **Output goes to the review queue.** Workflows that produce drafts (outreach, briefings) enqueue `WorkflowOutput` records via the queue helper, never deliver directly.
7. **Add tests.** Unit-test pure logic in helpers; do not test Inngest orchestration itself (Inngest handles durable execution).
8. **Open a PR.** Title `feat(workflows/<name>): …`. Body includes `Spec ref: §8.3` plus the specific workflow being implemented.

---

## 6. How to Add a New Query Helper

See SPEC.md §7 for the query layer.

**Recipe:**

1. **Locate the entity file.** `packages/db/src/queries/<entity>.ts` (`person.ts`, `company.ts`, etc).
2. **Define the contract first.** TypeScript signature with `Result<T, AtlasError>` return type. Name in `camelCase`, verb-first (`findPersonById`, `upsertCompany`, `listChampionsForCompany`).
3. **Implement using the Supabase client.** Import from `./client.js` via `getServiceClient()` (server-only) or `getAnonClient()` (RLS-respecting).
4. **Always return `Result`.** Errors get a specific `QueryError` subclass with a stable code from `AtlasErrorCode`.
5. **Add a unit test.** Use the in-memory Supabase mock pattern (deferred to Phase 2 when the testing infra lands) or hit a Supabase test schema in CI.
6. **Export from `packages/db/src/queries/index.ts`** if not already part of the entity's namespace export.

Do not put query helpers in adapters, workflows, or API routes. Those layers consume helpers; they do not define them.

---

## 7. Definition of Done

A task is **done** only when **all** of the following are true:

- [ ] Implementation matches the SPEC.md section(s) referenced in the task.
- [ ] All new code has tests; existing tests still pass (`pnpm test`).
- [ ] `pnpm typecheck` passes across every workspace.
- [ ] `pnpm lint` passes with no warnings.
- [ ] Public functions and classes have JSDoc with at least one `@example`.
- [ ] PR description includes `Spec ref:` line linking to the relevant SPEC.md section(s).
- [ ] Bugbot (or the equivalent automated review) is clean.
- [ ] No `TODO(spec):` left behind without a corresponding note in the PR description.
- [ ] If the change is to data shape or migration, a corresponding entry in `infra/migrations/` exists and was tested against a Postgres instance.

---

## 8. Testing Standards

- **Unit tests for pure logic.** Functions with no side effects. Fast (< 50ms per test).
- **Integration tests for adapter normalization.** Use JSON fixtures in `__fixtures__/` next to the adapter. Assert that the normalized output matches the canonical schema.
- **No end-to-end tests in Phases 0-4.** They get added in Phase 5 once the demo flow stabilizes.
- **Co-located.** Tests live next to source as `*.test.ts`. Vitest discovers them automatically.
- **Deterministic.** No reliance on real network calls, real time, or random seeds. Use `vi.useFakeTimers()` and stubbed RNG.

```ts
// good
import { describe, expect, it, vi } from 'vitest';
vi.useFakeTimers().setSystemTime(new Date('2024-01-15T00:00:00Z'));
```

---

## 9. Branch Naming

Prefix with intent, then a short kebab-case description.

| Prefix | When to use |
|---|---|
| `feat/` | New capability that ships value to users (`feat/luma-attendee-ingestion`) |
| `fix/` | Bug fix or correctness regression (`fix/resolution-corroboration-cap`) |
| `chore/` | Tooling, dependency bumps, repo hygiene (`chore/upgrade-vitest`) |
| `refactor/` | Behavior-preserving restructure (`refactor/extract-rate-limiter`) |
| `test/` | Test-only changes (`test/identity-resolution-fixtures`) |
| `docs/` | Documentation only (`docs/agents-md-recipes`) |

Branches off `main`. PRs merge to `main` via squash merge.

---

## 10. PR Conventions

- **Title:** conventional commit format. `feat(scope): one-line description`.
- **Body must include:**
  - `Spec ref:` line pointing to the SPEC.md section(s) implemented.
  - "What" — a short paragraph.
  - "Why" — the motivation, especially if the SPEC is ambiguous.
  - "Test plan" — a brief checklist of what you ran locally.
- **Size:** prefer small, reviewable PRs over giant ones. If a PR exceeds ~500 net lines of changed code, consider splitting.
- **No work outside scope.** If you find an unrelated bug, open a separate PR or issue. Do not bundle.

---

## 11. What Agents Must NOT Do

These are bright lines. Crossing them is grounds for the PR to be rejected.

1. **Do not modify `SPEC.md`** as part of an implementation task. Open a separate `spec:` PR if a change is genuinely required.
2. **Do not modify `packages/core/src/types.ts` without an explicit task** that calls for it. The entity types are the keystone for type safety across the monorepo. Any change cascades.
3. **Do not introduce new top-level dependencies** without justification in the PR description. The dependency set is deliberately small.
4. **Do not write code outside the scope of the assigned task.** Do not "drive-by refactor" unrelated files even when they look wrong. Open a separate PR.
5. **Do not commit secrets.** No `.env` files, no API keys in code, no test fixtures containing real credentials. `.env.example` is the only env file that gets committed.
6. **Do not bypass `packages/db/queries/*` for SQL access.** No raw `supabase.from(...)` calls outside that package.
7. **Do not throw exceptions across module boundaries.** Use `Result<T, AtlasError>`.
8. **Do not weaken `tsconfig.base.json`** — no setting `strict: false`, no `// @ts-ignore` without a `// FIXME(reason): …` comment explaining why.
9. **Do not introduce a second test runner, linter, or formatter.** Vitest, ESLint 9 flat config, Prettier are the canonical tools.
10. **Do not stop at the first green build.** A PR is done when the Definition of Done in §7 is fully satisfied.

---

## 12. Environment

**`.env.example`** at the repo root documents every environment variable the system reads, with a comment per variable explaining what it does.

**Local development:** copy `.env.example` to `.env` (root) and `apps/cockpit/.env.local` (cockpit). Fill in real values. Never commit `.env` files — they are gitignored.

**Production secrets** live in the Vercel, Supabase, and Inngest dashboards. The repository never contains real secrets. CI uses GitHub Actions secrets injected at job time.

**Env-var reads** go through `process.env['VAR_NAME']` (string-indexed) so that TypeScript's `noUncheckedIndexedAccess` forces a `| undefined` and you handle missing values explicitly. Wrap env reads in a config module (see `packages/db/src/client.ts` for the pattern) that returns a `Result<Config, ConfigError>` rather than scattering env reads across the codebase.

```ts
// good
const apiKey = process.env['LUMA_API_KEY'];
if (!apiKey) return err(new ConfigError('LUMA_API_KEY not set', 'INVALID_CONFIG'));

// bad
const apiKey = process.env.LUMA_API_KEY!;  // ! silences noUncheckedIndexedAccess
```

---

## 13. Where to Get Help

- SPEC.md — the canonical specification.
- `.cursor/rules` — mechanical conventions every agent inherits.
- The "Open Questions" section of SPEC.md (§14) — decisions deferred to later phases.
- Slack #atlas — synchronous human help (link in private docs).

Build well. Ship small. Compound.
