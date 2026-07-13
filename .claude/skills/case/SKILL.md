---
name: case
description: >
  Stage -1. Turns a fixture into `docs/CASE.md` — what the data is, what it forces,
  and what the author must decide. EXECUTES every claim the data makes about itself,
  because reading is not computing and a model that reads an invoice concludes
  "invoice." Names the decisions; does not make them.
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
  - Bash(ls:*)
---

### Prompt

The author has fixture data and ~8 minutes before committing to a design. Your job
is to make those minutes count.

## Role boundary

Evidence layer, not design layer.

- Do NOT decide what to build — not the schema, not the algorithm, not the threshold.
- Do NOT resolve an ambiguity. Name it, count it, leave it standing. The author
  decides; `/spec` records the answer.
- Do NOT state a number you did not compute. Estimating a statistic to justify a
  design is how you get caught.

_"`email` is 94% unique; 6 rows collide"_ is evidence. _"So merge on `email`"_ is
the author's call.

## The failure mode this skill exists to prevent

A model that READS a document pattern-matches its shape and moves on. It sees a
totals block, columns that line up, a tax line — and concludes the document is
fine. It will read a transposed total (`3.634,26` stated, `3.643,26` due) and not
notice, because both numbers look like totals.

Reading is not computing. No amount of careful reading turns into computing. That
is why Step 3 is a script and not a paragraph. **Cite no number you did not
execute.**

## Step 1 — Read every fixture IN FULL

No sampling. No skimming. No "the rest follow the same pattern." If there are four
files, read four files, start to end. The whole reason a fixture set exists is that
the cases DIFFER, and the difference is usually in the part you would have skipped.

## Step 2 — Presence matrix

A table: fixture × field. Every cell is exactly one of:

- `PRESENT` — stated outright in the document
- `ABSENT` — not there at all
- `DERIVABLE` — not stated, but computable from what is. **State the rule.**
  (e.g. *"due date: not stated; 'Payment due within 30 days' + the billing date"*)

`DERIVABLE` is the most important column, and it is the one a careless pass
collapses into `PRESENT`. Every `DERIVABLE` cell is a decision the author owes an
answer to — *does a derived value count as present, or as missing?* — and if you
mislabel it, the author never gets asked.

## Step 3 — EXECUTE every claim the data makes about itself

Write a throwaway script. Run it inline (`bun -e '...'`, or a file in the scratchpad
directory). **Do NOT persist it into `src/` — the repo is not a notebook.**

Compute, and print `expected` / `actual` / `delta` for each:

1. **Every arithmetic relation the document asserts.** Whatever the domain's
   invariants are: `line = qty × price`, `Σ lines = subtotal`, `subtotal + tax =
   total`, `debits = credits`, `parts = whole`.

2. **Every quantity asserted TWICE.** A document that states the same value in two
   places — `TOTAL` and `Amount Due`, a header count and a row count, a summary and
   its detail — is asserting an invariant. When the two disagree, that is a
   CONTRADICTION, and contradictions are the highest-value finding in any fixture
   set. They are invisible to reading, because each value looks perfectly fine on
   its own.

3. **Anything that would silently corrupt on parse.** Locale-ambiguous numbers
   (`1.180,00` vs `4,500.00`), dates with no stated format, encodings, units. Show
   the naive parse next to the correct one. A 1000× error and a correct number are
   the same shape on the page.

A relation you cannot compute because a field is absent is a SKIPPED check — report
it as a finding, not as a gap.

## Step 4 — Adversarial pass: what does the obvious implementation get wrong?

For each fixture, name the trap. Assume a competent engineer writes the first thing
that comes to mind. Where does the data punish them?

- A literal keyword match the data defeats? (An OCR'd `Invnice` is not `Invoice`.)
- A heuristic that fires on the wrong case? (A `Fwd:` subject prefix on a document
  that IS valid.)
- A case that looks like the others but isn't?

Fixtures are chosen, not sampled. Each one is usually there to break one specific
naive assumption. Find the assumption each was built to break — that is the fixture
set's design intent, and it is the closest thing to an answer key you will get.

## Step 5 — Write `docs/CASE.md`

TABLES, not prose. The author will scan this and then make decisions.

- **Input** — what the data is; how many files / rows / fields; notable characteristics.
- **Presence matrix** — Step 2's table, verbatim.
- **Computed invariants** — Step 3's table: relation, expected, actual, delta, verdict.
  Every number here is one you executed.
- **Traps** — Step 4: fixture → the naive implementation → what it gets wrong.
- **Decisions the data forces** — a numbered list of QUESTIONS ONLY. No answers, no
  recommendations, no "I suggest." Each question names the fixture that forces it.

Close with nothing. No summary, no design sketch, no next steps. The author reads
the evidence and decides. That is the whole contract.
