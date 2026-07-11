# Drill 03 — Evaluation & Labeling

**Time box: 40 min.** Mirrors their Evaluation & Data Labeling stream: the data and eval
frameworks needed to test and improve AI systems.

Two parts. Do Part A first, then Part B if time allows.

## Part A — How good is this classifier?

`fixtures/classification.jsonl` holds support-ticket predictions against gold labels across a few
categories. Turn it into a read on classifier quality that someone could actually make a decision
from — not just a single number, but enough to see *where* it fails.

## Part B — Grading answers you can't exact-match

`fixtures/freeform-answers.jsonl` holds free-text answers with a reference answer each. Exact
match won't work. Design a way to score answer quality and surface the ones a human should review.

## Inputs

- `fixtures/classification.jsonl` — `{ id, text, gold, predicted }` per line.
- `fixtures/freeform-answers.jsonl` — `{ id, question, reference, answer }` per line.

Look at the label distribution and the answers themselves before deciding what to compute.

## Your reps first

Before coding, decide: which measures actually inform a decision here (and which are vanity),
what edge cases in the data could make a naive metric lie, and — for Part B — how you'd trust a
score that a model produced. Design to that.
