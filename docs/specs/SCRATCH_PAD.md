### Evaluation Labeling Scratch Pad
- A freeform file to organize my thought process that doesn't belong in a PRE_SPEC

### Brief
`fixtures/classification.jsonl` holds support-ticket predictions against gold labels across a few
categories. Turn it into a read on classifier quality that someone could actually make a decision
from — not just a single number, but enough to see *where* it fails.

### Problem Decomposition (To Be Verified)
- [ ] C-1 - produce an output that measures classifier quality 
- [ ] C-2 - The output needs to quantify or explain process to answer *where* the classification produces a label that mismatches the expected gold labels.
       - What does *where* mean?
        - It means `at what reasoning step` does this classification fail on.
        - signals then need to be evidence that contributes to this trace.

### INVESTIGATION TASK

## Output Cases, Decomposed for Invariants
- Approach
 - Create a `src/bin/script.ts` that groups the correct labels vs. incorrect labels on a per `gold-label` basis.
  - Output the unique set of `gold-labels` present in the classification
  - Out of each label, what is the descending order of correctness? Can we display that in a table?
- Produce a STATIC case breakdown in markdown synthesizing the summary