# CLAUDE.md — Session Invariants
The mental model for how to build in this repo, and what the author cares about.
Load at session start. The goal of the invariants is to spend less time on setup cost and more time solving real engineering problems. This is the "carpenters bring their tools" philosophy.

# Reference Pattern
The `items` slice is the REFERENCE PATTERN. To add a feature, mirror it; don't
invent a new shape.

## Operating Mode
Priority order when time-constrained:
1. Working vertical slice end-to-end  >  breadth of features
2. Correct domain logic  >  test coverage
3. Tests ONLY for domain logic that encodes business rules
4. Skip tests for glue / framework wiring / UI unless asked

Rules of Engagement:
- Show a 3-line plan before starting a new slice.
- Prefer editing existing files over creating new ones.
- Commit per working vertical slice.
- Never gold-plate: no auth, no extra deps, no abstraction until a SECOND
  concrete use case exists. Ask before adding scope.

Definition of done: `bun run typecheck` clean, `bun run lint` clean,
`bun test` green, the happy path runs in the browser.

## Commands

```bash
bun run dev          # Next dev server
bun test             # bun:test unit tests
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun run format       # biome format --write
bun run db:migrate   # prisma migrate dev
bun run db:reset     # drop, migrate, reseed
```

## Stack (all decisions frozen — do not re-litigate)

- TypeScript. Bun = package manager + script runner + test runner (`bun:test`).
- Next.js App Router, React 19. Server Components for reads, Server Actions
  for mutations. The Next server runs on Node, not the Bun runtime.
- Prisma + SQLite (swap provider to postgres only if the task demands it).
- Zod for runtime validation at every boundary.
- Biome for format + lint (one tool).
- Path alias: `@/*` → `src/*`.

## Repository Layout & Folder Preferences
- `src/lib/**/domain/`   core business logic — pure where possible, ctx-injected
- `src/lib/**/actions/`  server actions (thin boundary)
- `src/lib/common/`      shared: prisma, config, the ctx factory, test mocks
- `src/app/`             Next routes + UI

Files: kebab-case. One primary export per file. IO-touching modules get an
`*.io.ts` suffix. JSDoc on exported functions saying what + why.

## Centralized Context (`ctx`) — the core pattern

- All IO / external dependencies live behind a single `Context`. 
- Domain functions never import a client (prisma, fetch, an SDK) directly — they receive `ctx` and
declare the exact slice they need. This is the DI seam AND the test seam.

## `ContextWith` pattern enables external dependencies to be explicitly modelled.
Three load-bearing types in `src/lib/common/io/context/create-context.ts`:
- `Context` — registry of every dependency, all optional.
- `ContextWith<K> = Pick<Required<Context>, K>` — a function asks for exactly
  the slice it needs, gets it as required. *Its IO surface is visible in its type.*
- `createContext(withKeys, overrides?)` — lazily hydrates only requested keys;
  `overrides` is the injection seam.

Rules:
- Type params as the slice, never the whole thing:
  `async function createItem(ctx: ContextWith<'prisma'>, input: ItemInput)`.
- Boundaries (server actions, route handlers) build ctx and delegate to /domain.
- Tests use `createMockContext({ prisma: fake })` — never real IO. See
  `create-item.test.ts` for the reference.
- Add a new dependency = add one optional field to `Context` + one line in
  `createContext`.

## Mental Model To Keep
`Context` = everything that touches the outside world.
`ContextWith<K>` = a function honestly declaring what it touches.
`createMockContext` = the same shape with the outside world swapped for fakes.

## Non-negotiable (for domain logic)
- External input validated with Zod at the boundary — see Trust Boundaries below
  for the calibration (it is NOT "validate everything").
- Every DB write wrapped in `ctx.prisma.$transaction(...)` for atomicity.
- Domain logic is pure/ctx-injected and unit-tested with `bun:test`.
- Errors: throw from domain (ZodError etc.); let the boundary catch. Keep
  boundary code thin.

## Trust Boundaries & Runtime Validation (Zod)
WHY Zod at all: a TypeScript type is erased at runtime — a compile-time promise
about data, not a guarantee. Zod is that promise ENFORCED, at the seam where
untrusted data enters deterministic code.

A boundary = where data crosses from a source you DON'T control (network/API
responses, user input, env, files, LLM output) into domain code. Validate THERE.

Calibration (this is the part people get wrong):
- Validate untrusted input ONCE, at the boundary. Never re-validate data your own
  deterministic code just constructed — parsing your own output is a smell.
- Validate a PROJECTION: only the fields you consume, not an exhaustive mirror.
- ONE schema is the source of truth for a shape; derive the type via `z.infer`.
  Never hand-maintain a parallel `interface` for the same shape.
- LLM-specific: strictly validate model-GENERATED CONTENT (non-deterministic);
  validate transport ENVELOPES (stop_reason, usage) with a light projection.
- Normalize provider signals (stop/finish reason, errors) for the domain, but
  RETAIN the raw signal alongside for observability.
- Own retries in ONE layer. If the app orchestrates retries, disable the SDK's.


### Workflow Mental Model To Keep
The author drives a DAG. Each stage is a skill with a hard ROLE BOUNDARY: none of
them decide anything. Decisions are the author's — that is the whole point.

```text
[read_author_brief] -> /case → /spec → /failure-modes → [build] → /qa
                                         ╰─ /grill-me and /enforcing-trust-boundaries
                                            are on-demand, not on the critical path
```

## Skills — Index By Indirection
This is a mapping table of skills that can be invoked.

| Stage | Skill | Input → Output | Role boundary (what it will NOT do) |
|---|---|---|---|
| -1 | `/case` | fixtures → `docs/CASE.md` | Evidence only. Counts come from a throwaway `src/bin/` script fitted to the fixture, never from a model's estimate. Names the decisions the data forces; does not make them. |
| 0 | `/spec` | draft → `docs/specs/spec-NNN.md` | Fidelity only. Formalizes decisions already made; flags a BLOCKER rather than inventing a REQ. |
| 1 | `/failure-modes` | spec → BLOCKERS + WARNINGS | Adversarial. Finds holes; does not fill them. |
| — | `/grill-me` | spec or code → shared understanding | Interviews the author one question at a time. Recommends; never decides. |
| — | `/enforcing-trust-boundaries` | LLM adapter → audit report | Read-only. Surfaces violations of the Trust Boundaries rules above; does not fix them. |
| 3 | `/qa` | spec + code → REQ-by-REQ attestation | Verifies. Documents a failure and stops; does not repair. |
