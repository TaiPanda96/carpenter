---
name: case
description: >
  Stage -1. Turns a fixture into `docs/CASE.md` — what the data is, what it forces,
  and what the author must decide. Writes a throwaway script to count things, because
  a number you cite must be one you can defend. Names the decisions; does not make them.
disable-model-invocation: true
argument-hint: "[fixture-path...]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash(bun:*)
  - Bash(head:*)
  - Bash(wc:*)
---

### Prompt

The author has fixture data and ~10 minutes before committing to a design. Your job
is to make those minutes count.

## Role boundary

Evidence layer, not design layer.

- Do NOT decide what to build — not the schema, not the algorithm, not the threshold.
- Do NOT resolve an ambiguity. Name it, count it, leave it standing. `/spec` records
  the author's answer.
- Do NOT state a number you did not compute. Estimating a statistic to justify a
  design is how you get caught.

_"`email` is 94% unique; 6 rows collide"_ is evidence. _"So merge on `email`"_ is
the author's call.

## Step 1 — Read the raw rows first

`head` the fixture. Look at actual rows before you count anything. You are looking
for the texture a script cannot see: a field whose meaning depends on another field,
a composite value that wants splitting, an id buried in a string, rows that are
plainly a different kind of thing from their neighbours.

This is also how you decide what is worth counting — which is the next step.

## Step 2 — Write a throwaway profiler

Write `src/bin/profile-fixture.ts` following the `src/bin/script.ts` convention
(Commander, one description, one action, JSDoc showing the invocation). Run it with
`bun`.

It is **fitted to this fixture and disposable**. Do not build a general profiler —
a script that handles every fixture shape you might ever meet is a script that
tells you nothing about the one in front of you. Compute what Step 1 told you to
compute, and nothing else.

What it exists to answer — four questions, in priority order:

**1. Contract.** What is a row in? What is a row out? Field names, types, one real
example each. If the output shape is not in the data, say so — that is the first
thing the author has to decide.

**2. Normalization.** Only the fields that force a decision at the boundary:
missing / null / empty-sentinel (`"N/A"`, `"-"`, `""`) rates, the same value under
multiple spellings, mixed types in one column, more than one date format. A field
that is clean does not need a line.

**3. Invariants.** The facts a design would break on. Is the field the author's
instinct reaches for actually a key, or only nearly one — and if nearly, how many
rows collide? Do two files share a value space, and what fraction of rows have no
partner? Uniqueness that holds at 94% is not uniqueness; it is a fuzzy problem
wearing a deterministic costume.

**4. If it is a classification problem** — and the fixture carries labels, it is:

- How many classes, and the count in each. Imbalance is the whole story.
- **Majority-class baseline**: accuracy if you always guess the biggest class.
  Every number you report later is measured against this, not against zero.
  If the baseline is 0.71, a model at 0.78 has bought you very little.
- **Minority classes**: which classes have so few rows that recall moves in
  whole fractions. A class with n=3 cannot be evaluated, let alone learned.
- Therefore: which metric is honest here (accuracy is a lie under imbalance;
  macro-F1 is not), and which classes will decide the score.

Once predictions exist, the same script grows a `--pred` flag and becomes the
evaluation loop: per-class precision/recall, the worst confusions, and whether
the classifier is **dumping** — collapsing a hard minority class into the
majority one to buy accuracy. That is the failure the baseline number exists to
expose. Do not build this at Stage -1; build the read that makes it necessary.

## Step 3 — Write `docs/CASE.md`

```markdown
# CASE — [fixture]

## Shape

One paragraph, prose. What are these files, what is a row, how do they relate.
Written for an engineer who has not seen the data.

## Contract

In: [row shape]. Out: [row shape, or: NOT DETERMINED BY THE DATA — see Q1].

## Facts

The script's stdout, verbatim.

## The Read

The 3–6 facts that are load-bearing — a fact is load-bearing only if a design
decision changes depending on it. Each: the claim as a sentence, the number that
supports it, one line on what it rules out. Never what to build.

## Decisions the data forces

Open questions, as questions. Each names the fact that raises it and the
alternatives it sits between. Do NOT answer them.

- [ ] Q1: ...

## What the fixture cannot tell you

Volume in production. Whether this sample is representative. What the consumer
does with the output. The unstated assumption is the one that fails.
```

## Step 4 — Hand off

Print the path written, the load-bearing facts one line each, and the numbered
questions. Then stop. Do not spec. Do not build.

## The failure this prevents

Under time pressure the instinct is to collapse an ambiguous problem into a clean
deterministic key — and to find out at the demo that the data never supported one.
`CASE.md` makes that collapse a choice made against evidence, in the open, rather
than an assumption made in silence at minute four.
