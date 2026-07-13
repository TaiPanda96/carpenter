# carpenter

A pre-verified **walking-skeleton** template for AI-assisted coding challenges.
Bring-your-own-tools: at `t=0` you clone, install, and start building features —
not plumbing.

Stack: TypeScript · Bun · Next.js (App Router) · React 19 · Prisma (SQLite) ·
Zod · Biome. Centralized `ctx` dependency injection. One working `items`
vertical slice (route → server action → ctx → prisma → db → UI) with tests.

## First run

```bash
cp .env.example .env    # .env is gitignored; add real secrets here
bun install
bun run db:migrate      # creates dev.db + runs the initial migration
bun run db:seed         # optional sample rows
bun test                # should be green
bun run dev             # http://localhost:3000
```

## The move on challenge day

1. `git clone` this repo, `bun install`, `bun run db:migrate`, `bun run dev`.
   Confirm the Items page loads. All integration risk is now pre-paid.
2. Paste the kickoff prompt below into the agent with the real challenge.
3. The agent renames/replaces the `items` slice with the real entity, mirroring
   its shape. `CLAUDE.md` holds every frozen decision so nothing is re-litigated.

### Kickoff prompt (paste-ready)

> Read CLAUDE.md. The `items` slice (`src/lib/items/**` + `src/app/page.tsx`) is
> the reference pattern — mirror its shape for all new work. Here is the
> challenge: [PASTE PROMPT]. Give me a 3-line plan, then implement the first
> vertical slice: one entity end-to-end through `ctx` (validate → transactional
> write), a `bun:test` on the domain function, rendered in the UI. Then stop for
> review.

## What's the reference pattern

- `src/lib/items/domain/validate-item-input.ts` — pure Zod validation (+ test)
- `src/lib/items/domain/create-item.ts` — `ContextWith<'prisma'>`, validate then
  transactional write (+ test using `createMockContext`)
- `src/lib/items/domain/list-items.ts` — ctx-injected read
- `src/lib/items/actions/create-item-action.ts` — thin server-action boundary
- `src/lib/common/io/context/create-context.ts` — the `ctx` factory + types
- `src/lib/common/test/mocks/mock-context.ts` — test mirror

## The LLM seam

If the challenge involves a model call, the layer is already built and already argued:
**[`src/lib/common/llm/README.md`](src/lib/common/llm/README.md)** is its decision record —
every choice with the alternative it rejected and what breaks if it's wrong, plus the
questions you'll get asked and the gaps to name before someone finds them. Review it ahead
of time; on the day, you spend the decision, not the typing.

## Rehearse before the real thing

Run 2–3 timed mock challenges (URL shortener, small inventory app) starting from
this template. The value is entirely gated on using it being automatic.
