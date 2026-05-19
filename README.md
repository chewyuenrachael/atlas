# Cursor Community Atlas

Keystone data layer that converts ambient community signal across public and internal Cursor surfaces into a queryable graph of people, companies, events, communications, artifacts, programs, and signals.

- **Canonical spec:** [`SPEC.md`](./SPEC.md) — every architectural decision and schema field traces back to a section here. Do not modify.
- **Operating manual for agents:** [`AGENTS.md`](./AGENTS.md) — required reading before touching this repo.
- **Mechanical conventions:** [`.cursor/rules`](./.cursor/rules).

Phase 1 (Foundation) is complete: the schema is live in Supabase, the Luma adapter ingests events into the canonical graph, and the Tier 1 + Tier 2 identity resolver assigns each Person a canonical id with an audit row.

---

## Current state

Phase 1 (SPEC.md §11 Phase 1) is complete. The repository ships:

- The full SPEC.md §3 schema applied to Supabase (entities, edges, raw tables, audit tables, event log, materialized views).
- The Luma source adapter (SPEC.md §5.2.1) — discovers events on
  `lu.ma/cursorcommunity`, captures raw payloads idempotently into
  `raw_luma_event`, and normalizes into Event + organizer Person records.
- The Tier 1 (explicit linking) + Tier 2 (heuristic) identity resolver
  (SPEC.md §4) — every Person record produces exactly one
  `resolution_decision` audit row.
- Supabase-backed implementations of the `RawLumaStore`, `PersonStore`, and
  `ResolutionAuditStore` interfaces wired into an end-to-end Inngest workflow
  (`packages/workflows/_shared/src/luma-ingest-pipeline.ts`).
- A backfill CLI (`pnpm backfill:luma`) and a Phase 1 exit-criteria verifier
  (`pnpm verify:phase-1`).
- A minimal cockpit page at `/` that reads totals and the most recent events
  + top ambassadors directly from Supabase.

Run `pnpm verify:phase-1` to see the current Phase 1 exit-criteria report.

Phase 2 is next: add the remaining six sources (Twitter, GitHub, Reddit,
Hacker News, Cursor Forum, YouTube, LinkedIn), expand Tier 2 heuristics with
cross-platform handles, and turn on Tier 3 embedding-based resolution
(SPEC.md §11 Phase 2).

---

## Quickstart

```bash
# 1. Install
pnpm install

# 2. Set up env vars
cp .env.example .env
# fill in SUPABASE_*, INNGEST_*, ANTHROPIC_API_KEY, source adapter keys, etc.

# 3. Verify the workspace
pnpm typecheck
pnpm lint
pnpm test

# 4. Run the cockpit
pnpm dev
# open http://localhost:3000
```

You should see the Phase 1 demo cockpit with live totals, the 10 most recent events, and the top 10 ambassadors.

To ingest data and verify exit criteria:

```bash
# 5. Backfill from Luma
pnpm backfill:luma

# 6. Verify Phase 1 exit criteria
pnpm verify:phase-1
```

---

## Repository layout

```
atlas/
├── apps/cockpit/                  Next.js 14 App Router operator UI (SPEC §2.1 Layer 5)
├── packages/
│   ├── core/                      Types, constants, errors, Result, logger (SPEC §3, §4, §9.1)
│   ├── db/                        Supabase client + named query helpers (SPEC §3, §7)
│   ├── adapters/                  One source per folder (SPEC §5)
│   ├── intelligence/              Identity resolution, scoring, classification (SPEC §4)
│   ├── workflows/                 Inngest workflows (SPEC §5.3, §8.3)
│   └── api/                       REST, GraphQL, Ask Anything (SPEC §7)
├── infra/migrations/              Postgres migrations (SPEC §3, §11 Phase 1)
└── .github/workflows/             CI
```

See `AGENTS.md` §3 for the full file layout commentary.

---

## Stack (locked in Phase 0)

| Concern | Choice |
|---|---|
| Package manager | pnpm 10.x with workspaces |
| Node | 20 LTS (see `.nvmrc`) |
| Language | TypeScript 5.6, strict mode + `noUncheckedIndexedAccess` |
| Test runner | Vitest 1.x |
| Linter | ESLint 9 flat config + `@typescript-eslint` |
| Formatter | Prettier |
| Logger | Pino, structured JSON (SPEC §9.1) |
| DB | Supabase / Postgres 16 + pgvector (SPEC §2.3) |
| Workflows | Inngest 3.x (SPEC §2.3) |
| Frontend | Next.js 14 App Router + Tailwind + shadcn/ui |
| Map | Mapbox GL JS (declared, install lands in Phase 3) |

Stack rationale: SPEC.md §2.3.

---

## Workspace scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run the cockpit Next.js dev server |
| `pnpm build` | Build every package, then the cockpit |
| `pnpm test` | Run Vitest across the workspace |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm typecheck` | `tsc --noEmit` across every workspace package |
| `pnpm lint` | ESLint 9 flat config |
| `pnpm lint:fix` | ESLint with `--fix` |
| `pnpm format` | Prettier write |
| `pnpm format:check` | Prettier check |
| `pnpm backfill:luma` | One-shot Luma backfill: fetches all `lu.ma/cursorcommunity` events, normalizes, resolves identities, and reports counts |
| `pnpm verify:phase-1` | Reports pass/fail against the SPEC.md §11 Phase 1 exit criteria |

---

## Phase status

| Phase | Status | Goal |
|---|---|---|
| 0 — Pre-build | ✅ Done | Monorepo, type contracts, conventions, CI |
| 1 — Foundation | ✅ Done | Schema migrations + Luma adapter + Tier 1/2 identity resolver (SPEC §11 Phase 1) |
| 2 — Multi-source | ⏳ Next | Twitter, GitHub, HN, Reddit + Tier 2/3 identity resolution (SPEC §11 Phase 2) |
| 3 — Query layer | ⏳ | REST + GraphQL + Ask Anything + cockpit views (SPEC §11 Phase 3) |
| 4 — Scoring | ⏳ | Scoring engines + first workflow (Organizer Activation) (SPEC §11 Phase 4) |
| 5 — Polish | ⏳ | Demo, Loom, send (SPEC §11 Phase 5) |

---

## Next steps (Phase 2)

Phase 2 (SPEC.md §11 Phase 2) adds the remaining sources and the cross-source
identity layer. The next person to pick this up should:

1. **Implement the next adapter.** Follow the recipe in `AGENTS.md` §4 — Twitter,
   GitHub, Hacker News, and Reddit are the highest-signal sources per SPEC.md §5.2.
   Each adapter writes to its own `raw_<source>` table.
2. **Extend identity resolution.** Tier 2 today is heuristic over name + email;
   Phase 2 adds cross-platform handle matching (e.g. GitHub `@alice` ↔ Twitter
   `@alice` ↔ Luma `Alice C.`) and turns on Tier 3 embedding-based resolution
   (`pgvector`) behind a feature flag (SPEC.md §4.3 — §4.5).
3. **Wire each new adapter into the ingest pipeline.** The pattern in
   `luma-ingest-pipeline.ts` is intentionally generic — extract the shared phases
   so the GitHub / Twitter pipelines reuse normalization → resolve → upsert.
4. **Expand the cockpit.** Phase 3 lands the full query layer (REST + GraphQL +
   Ask Anything), but until then the demo page should grow filters for
   source-of-truth, persona, and lifecycle stage.

---

## License

Internal. Not for distribution.
