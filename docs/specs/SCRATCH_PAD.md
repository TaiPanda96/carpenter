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


### Design Considerations (Soft Lock)
- Population level metrics can be graded deterministically, but failure cases themselves need to surface 
- Support tickets have semantic nuances and sentiment that `code-based` grading would struggle with, therefore, a flexible robust choice is LLM based grading.
- Based on this evidence below: 
  - `"Love the new dashboard, but a dark mode would be amazing."` -> predicts `technical` instead of `feedback`
  - `"Great support last week — just wanted to say thanks!`"
    - The case investigation clearly showed poor performance on `feedback`, an under represented class in this imbalanced multi-class classification output.
    - The gold label `billing` can be revisited in the future by the AI evaluation team. This is a dumping bucket!
- These are support tickets, so the relative cost of a `false-positive` vs. a `false-negative` is routing efficiency
  - Customers commit to a `sunk-cost` of support.
  - Incorrect classifications mis-routing is an operational efficiency problem that impacts SLA.
  - For simplicity, we can consider Recall & Precision Equally.