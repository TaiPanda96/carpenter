# CLAUDE.md — Session Invariants
The mental model for how to build in this repo, and what the author cares about.
Load at session start. The goal of the invariants is to spend less time on setup cost and more time solving real engineering problems. This is the "carpenters bring their tools" philosophy.

# Reference Pattern
The `items` slice is the REFERENCE PATTERN. To add a feature, mirror it; don't
invent a new shape.

## Operating Mode (timed build)
Priority order when time-constrained:
1. Working vertical slice end-to-end  >  breadth of features
2. Correct domain logic  >  test coverage
3. Tests ONLY for domain logic that encodes business rules
4. Skip tests for glue / framework wiring / UI unless asked

Rules of engagement:
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
- Domain functions
never import a client (prisma, fetch, an SDK) directly — they receive `ctx` and
declare the exact slice they need. This is the DI seam AND the test seam.

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

## Non-negotiable (for domain logic)
- Every external input validated with Zod at the boundary before use.
- Every DB write wrapped in `ctx.prisma.$transaction(...)` for atomicity.
- Domain logic is pure/ctx-injected and unit-tested with `bun:test`.
- Errors: throw from domain (ZodError etc.); let the boundary catch. Keep
  boundary code thin.

## Mental model to keep
`Context` = everything that touches the outside world.
`ContextWith<K>` = a function honestly declaring what it touches.
`createMockContext` = the same shape with the outside world swapped for fakes.


### Workflow Mental Model To Keep
This is the optimal co-pilot workflow
```text
/spec → /failure-modes → [author + Claude Code, interactive] → /qa
```