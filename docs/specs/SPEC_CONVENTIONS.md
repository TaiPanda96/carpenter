---
id: spec-001
type: backend
scope: standard
---

## Goal
[One sentence. Imperative. Concrete.]

## Requirements (file: `src/lib` action `Add/Modify/Delete`)
- REQ-1: [specific, observable, atomic]
- REQ-2: ...

## Constraints
- Prefer functions over classes in domain & io functions
- Zod for all external input validation
    - use the `.safeParse()`
    - on validation failure, capture the `zodIssues` as part of the logging meta-data
- Typed errors, no throwing strings

## Ascii Diagram of Solution
```ascii

```
## Acceptance Criteria
- Requirements implemented, with decisions on open questions resolved by the user

## Definition of Done
- [ ] `bun run typecheck` passes
- [ ] Core happy path + one error case tested
- [ ] `bun run test` passes
- [ ] If defined, a script that runs the end to end integration point.