---
id: spec-001
type: backend
scope: standard
---

## Goal
[One sentence. Imperative. Concrete.]

## Context Discovery
- Use indirection as the main form of efficient context assembly
 - `src/lib` - domain logic lives here
 - `src/lib/common/io` - IO logic lives here.
 - `src/lib/common/io/context/create-context.ts` - context instantiation for the repository. Each external dependency is declared explicitly here.
 - `src/lib/items` - this is an example implementation of `domain` and `actions` (server-actions)

## Requirements
- REQ-1: [specific, observable, atomic]
- REQ-2: ...

## File Mapping
| File | Action |
|------|--------|
| `src/lib/newModule.ts` | Create |
| `src/types.ts` | Modify — add X type |

## Constraints
- Prefer functions over classes in domain & io functions
- Zod for all external input validation
    - use the `.safeParse()`
    - on validation failure, capture the `zodIssues` as part of the logging meta-data
- Typed errors, no throwing strings

## Definition of Done
- [ ] `bun run typecheck` passes
- [ ] Core happy path + one error case tested
- [ ] `bun run test` passes
- [ ] If defined, a script that runs the end to end integration point.