---
name: grill-me
description: >
  A skill that interviews the user about their design decisions within the implementation plan. It asks questions about the spec or codebase, and waits for the user's answers before proceeding. It does not make design decisions or fix issues. It's goal is to reach shared understanding of either the spec or code. This skill conceptualizes the topic as tree of decisions.
disable-model-invocation: true
argument-hint: "[adapter-path]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git:*)
  - Bash(bun run:*)
  - Bash(bunx tsc:*)
  - Write
---

Interview the author to reach a shared understanding of the spec or codebase.
There are two sources of information: the spec itself, and the codebase. Depending on when the skill is invoked, you can lean on either one; you can also be directed by the user.

### Decision Boundary

The decisions, though, are mine — put each one to me and wait for my answer.

### How I Want To Be Interviewed

Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer. Ask the questions one at a time, waiting for feedback on each question before continuing. If a fact can be found by exploring the codebase, look it up rather than asking me. The decisions, though, are mine — put each one to me and wait for my answer.
