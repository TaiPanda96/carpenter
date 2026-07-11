### Evaluation of Multi Classification Outputs (Grader)

### Brief
Build a classification evaluator that takes `classification.jsonl` as an input to produce
a class-aware (class distribution aware) scorecard as a typed object with clear diagnostic signals that a downstream consumer can use for decision/dispatch.

### Context
`CASE_INVESTIGATIONS.md` tells you exactly what the key findings are. This is how we build the basis of our solution.

### Goals
There are two goals, separated by `hot_path` decision
 (1) Design a deterministic evaluator that scores the `classification.jsonl` on aggregated up to Precision, Recall, Confusion Matrix, and F1-Score metrics at the population level to clearly highlight the issues this classifier has on under represented categories. This has no LLM Cost.

 (2) Compute a grading output that is diagnostic on the FAILED classifications only. And there's two purposes for that
    - We want to map diagnostic signals to the expected vs. gold label classification.
    - Grading the Gold Label - itself; key findings suggest the taxonomy on gold labels isn't clear enough and the classifier may be "stuffing" things to "billing".

## An Evaluation Run Aggregates Grading Outputs into a Structured, Typed Object That Answers
- `how good is classifier at specific labels`? 
- `which label categories does this classifier perform the worst in`? 
- `How does the average accuracy on commonly seen classifier groups vs. imbalanced outliers`?
- `What were the cases where this classification was wrong`?

## Non Goals
- This evaluator stays "pure", it has no side-effects or opinions on how routing or downstream consumers will output this object.
- No working assumptions made on throughput or performance

### Input Contract (Schema Details To Be Fleshed Out in Spec)

## Classification Label Universe (Optional Config with Default UNION behavior)
- An optional `goldLabelConfig` representing the universe of gold labels can be passed to the evaluator
- If no config present, fallback to an explicit input representing the UNION of `gold label` and predicted, de-duplicated

## Failure Taxonomy Label Universe (`failureTaxonomyConfig`) For the GradingOutput
- A mandatory config that outputs the "type of classification error" that can occur. This is helpful to see if an individual class is prone to a certain type of error, such as:
 - `HALLUCINATED_LABEL`
 - `INJECTED_HALLUCINATED_CONTEXT`
 - `OVER_INDEXING_ON_KEY_WORD`
 - `MISSED_CUSTOMER_FEEDBACK`
 - `FALL_BACK_CLASS_LABEL`

### EvaluationInput as a Typed Interface
- An input interface to represent a given classifier output
<!-- {"id": "t01", "text": "I was charged twice for my subscription this month, please refund the duplicate.", "gold": "billing", "predicted": "billing"} -->

### BaseGradingOutput
Create a `BaseGradingOutput` captures the invariant telemetry needed for evals
  - evaluation_run_id 
  - graded_at
  - rubric_id 
  - operational_verdict
  - grading_cost
   - telemetry on input & cache tokens

### ClassificationGradingOutput extends BaseGradingOutput
  Create a `ClassificationGradingOutput` that extends the base interface to capture eval properties for multi-class classification problems
    - should tell you how the object was evaluated
      - evaluation_type (`LLM`, `CODE`, `HUMAN`)
    - dispatch verdict
        - should tell you how this graded output should be treated
    - closest_top_alternative_gold_label
        - should tell you what the second best alternative is chosen, if this were an LLM graded output
    - failure_taxonomy
       - What category of failure is this? 

### Output Contract (Schema Details to be Fleshed Out in Spec`ing Phase)
## Output Classification Accuracy Under Class Imbalance (Population Aggregated Outputs)
- ClassificationScoreCard
  - Class Counts
  - Per Class Confusion Matrix 
     - TP
     - TN
     - FP
     - FN
  - Micro F1 -> weighted F1 on proportion of classes
  - Macro F1 -> F1 assuming all classes should be considered equally
  - Precision 
    - Worst performing precision class
    - Best performing precision class
  - Recall 
    - Worst recall class

## GradedOutputs[], as a diagnostic array on MISSED Classifications


### EvaluationRunOutput
```typescript
    interface EvaluationRunOutput { 
        classificationScoreCard: ClassificationScoreCard
        gradingOnErrors: GradedOutput[]
    }
```

### Processing Model Flow
A single AI Evaluation Run Will Produce Two Outputs
 - 
```ascii
HOT PATH - Deterministic
input (jsonl record)
  |
Deterministic Population Scorecard (Recall, Precision, Micro & Macro F1, Accuracy)
  | 
```

LLM's core focus is diagnostic, so it never mutates the inputs
```ascii
MISSED_CLASSIFICATIONS - LLM Assisted Grading
input (classification_error_inputs)
  | 
  Batched LLM Grading -> Grading Output Schema

  Aggregate Population 
   - Gold Label Audit 
   - Error Taxonomy 
   - Cost (of the LLM grading for a given evaluation run)
   - Latency (avg m/s latency per grade)
  | 
```

### DoD
- A script that can run this evaluator under `src/bin/eval` and ingest any `classification.jsonl` as an input.
- Normalization handles edge cases we expect from `classification.jsonl`
- Unit tests on pure functions added
