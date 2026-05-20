# @atlas/adapter-github

GitHub source adapter. See `SPEC.md` §5.2.2 for the source contract and §5.1 for the `SourceAdapter` interface.

This package ships **two** adapter modes against the same external source:

- **`GithubProfileAdapter`** — weekly refresh of known ambassador profiles. Reads `person_platform_identity` rows where `platform = 'github'` via an injected `AmbassadorSource`, pulls each user's public profile + top repos, and emits a `Person` normalized record.
- **`GithubRepoSearchAdapter`** — daily search for Cursor-related repositories. Runs `search/repositories` plus an optional `search/code` pass, hydrates each repo's README, scores its Cursor relevance, and emits `Artifact` + `Person` (+ optional `Communication`) normalized records.

Both adapters share a single `GithubClient` (a thin `@octokit/rest` wrapper) so we authenticate once per process.

## Environment

The adapter reads `GITHUB_TOKEN` from the environment. If it is missing, the CLI and the workflows log a clear error and exit cleanly (exit code 0) without making any API calls.

## CLI

```sh
pnpm --filter @atlas/adapter-github cli -- \
  --logins=alicechen,brunot \
  --repo-query='cursor in:name,description,topics' \
  --limit-repos=10
```

Flags:

| Flag | Description |
|---|---|
| `--logins=a,b,c` | Comma-separated list of ambassador GitHub logins |
| `--repo-query=<q>` | Override the `search/repositories` query |
| `--code-query=<q>` | Override the `search/code` query (set to `''` to disable code search) |
| `--limit-repos=<n>` | Stop after N repo matches (smoke test) |
| `--skip-profile` | Skip the profile-refresh pass |
| `--skip-repo-search` | Skip the repo-search pass |
| `--json` | Emit the full `NormalizedRecord[]` as JSON on stdout |

## Storage boundary

Per the Phase 2 task brief, this PR only ships in-memory raw stores
(`InMemoryRawGithubProfileStore`, `InMemoryRawGithubRepoStore`). Supabase-backed stores arrive once `packages/db/queries/github.ts` exposes the corresponding helpers.

## Test scenarios

`*.test.ts` files exercise the canonical scenarios from the task brief:

1. Profile fetch (`profile-adapter.test.ts`)
2. Repo with Cursor in README (`repo-search-adapter.test.ts`, high relevance)
3. Repo with Cursor in code only (`repo-search-adapter.test.ts`, low relevance)
4. Private repo (`repo-search-adapter.test.ts`, skipped)
5. User with no public activity (`profile-adapter.test.ts`, still emits a `Person`)

Plus idempotency, missing-README tolerance, code-search-403 tolerance, and rate-limit-header observation.
