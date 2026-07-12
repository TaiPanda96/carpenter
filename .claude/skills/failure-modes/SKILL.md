---
name: failure-modes
description: >
  An adversarial skill that checks a spec for potential failure modes. It does not
  make design decisions, but rather identifies potential issues that could lead to
  failures in implementation. It flags ambiguous requirements, missing context,
  and other potential pitfalls that could cause the spec to be un-implementable or
  lead to unexpected behavior.
disable-model-invocation: true
argument-hint: "[spec-path]"
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash(git:*)
  - Bash(bun run:*)
  - Bash(bunx tsc:*)
---

### Prompt

You are an adversarial skill that checks a spec for potential failure modes. Your job is to identify issues that could lead to failures in implementation, without making design decisions yourself.

Common failure modes to consider include:

### Context Assembly Failures

- Ambiguous requirements that could be interpreted in multiple ways
- Missing context that could lead to incorrect assumptions
- Spec that misses the key problem the system is trying to solve, who the users are, and what the constraints are
- Spec focuses on satisfying a system that cares reliability, but the author has not considered edge cases or failure scenarios
- Spec designed for a single happy path, but does not account for error handling, retries, or idempotency

### Design & Implementation Failures

### Idempotency Failures

For each REQ that involves a write operation (create, update, delete,
insert):

- Verify the REQ specifies behavior on duplicate execution
- Verify the DoD includes a test for the duplicate case
- If neither is present → BLOCKER FM-N

### Time Box / Scope Failures

- Spec that is too ambitious for the time box, leading to incomplete or rushed implementation
- Spec that is too narrow in scope, leading to a system that does not meet the needs of the users or stakeholders

## Output Contract

This skill will mutate the spec file in place, adding comments for any issues found. It will also produce a report of findings in `/tmp` for hand-off to the next stage of the pipeline.

- Add `BLOCKERS` in `[] FM-1` format to the `spec-NNN` file for any issues that must be resolved before implementation can proceed.
- Add `WARNINGS` in `[] FM-2` format to the `spec-NNN` file for any issues that should be resolved, but won't block the agent from proceeding.

Write findings to stdout in this structure in `/tmp` as a stateful hand-off artifact:

# FAILURE MODES REPORT — spec-NNN

BLOCKERS (must resolve before implementation):
[ ] FM-1: [category] [description] [what specifically is missing]

WARNINGS (should resolve, won't block agent):
[ ] FM-2: [category] [description]

PASS: [N checks passed, list them]
