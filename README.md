# Cursor Community Atlas

Keystone data layer that converts ambient community signal across public and internal Cursor surfaces into a queryable graph of people, companies, events, communications, artifacts, programs, and signals.

- **Canonical spec:** [`SPEC.md`](./SPEC.md) — every architectural decision and schema field traces back to a section here. Do not modify.
- **Operating manual for agents:** [`AGENTS.md`](./AGENTS.md) — required reading before touching this repo.
- **Mechanical conventions:** [`.cursor/rules`](./.cursor/rules).

This is a Phase 0 scaffold. The monorepo is wired up, type contracts are locked, and every adapter / intelligence service / workflow / API package is a typed empty shell ready for Phase 1 onward.

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

You should see `Cursor Community Atlas — Phase 0 scaffold complete` on the home page.

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

---

## Phase status

| Phase | Status | Goal |
|---|---|---|
| 0 — Pre-build | ✅ Done (this scaffold) | Monorepo, type contracts, conventions, CI |
| 1 — Foundation | ⏳ Next | Schema migrations + Luma adapter (SPEC §11 Phase 1) |
| 2 — Multi-source | ⏳ | Twitter, GitHub, HN, Reddit + Tier 2/3 identity resolution (SPEC §11 Phase 2) |
| 3 — Query layer | ⏳ | REST + GraphQL + Ask Anything + cockpit views (SPEC §11 Phase 3) |
| 4 — Scoring | ⏳ | Scoring engines + first workflow (Organizer Activation) (SPEC §11 Phase 4) |
| 5 — Polish | ⏳ | Demo, Loom, send (SPEC §11 Phase 5) |

---

## Next steps (Phase 1)

The next person to pick this up should:

1. **Stand up Supabase.** Create a project, enable `pgvector`, capture URL + keys into `.env`.
2. **Land the first real migration.** Replace `infra/migrations/0000_init.sql` with the full schema from SPEC.md §3 (entities, edges, raw tables, audit, event log). Apply via Supabase SQL editor or `supabase db push`.
3. **Implement the Luma adapter** in `packages/adapters/luma/`. Follow the recipe in `AGENTS.md` §4 and the source spec in SPEC.md §5.2.1.
4. **Implement the Tier 1 + Tier 2 identity resolver** in `packages/intelligence/identity-resolution/`. SPEC.md §4.2.
5. **Fill in the named query helpers** in `packages/db/src/queries/*` — they are typed stubs today; replace with real Supabase calls behind the same `Result<T, AtlasError>` contract.

Exit criteria for Phase 1 (from SPEC.md §11): a SQL query like `SELECT COUNT(*) FROM person WHERE location_country = 'Brazil';` returns a sensible number; `resolution_decision` has entries; no raw records stuck in `pending`.

---

## License

Internal. Not for distribution.
