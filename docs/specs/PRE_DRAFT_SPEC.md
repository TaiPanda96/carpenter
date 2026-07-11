### CLASSIFICATION EVALUATOR

### Brief
Build a classification evaluator that takes `classification.jsonl` as an input to produce
a class-aware (class distribution aware) scorecard as a typed object with clear diagnostic signals that a downstream consumer can use for decision/dispatch.

### Context
`CASE_INVESTIGATIONS.md` tells you exactly what the key findings are. This is how we build the basis of our solution.

## Key Findings (ranked)
1. **`feedback` is invisible to the classifier** — 3 gold tickets, predicted **0** times (recall 0%). Accuracy hides this entirely; macro-F1 is what catches it.
2. **`billing` is the dumping bucket** — predicted 7× but only 6 are truly `billing` (precision 0.57). Wrong-class tickets fall here by default.
3. **Headline accuracy overstates quality**: accuracy 61.1% vs macro-F1 0.50. The 11-pt gap is the imbalance tax — common classes carry the average.

### Goals
- The evaluator function needs a scoring criteria that covers the following

## Output Class Aware Recall Matrix
 - Per Class Accuracy based on Gold Label Set
   - This is a matrix that observes for each given gold set label
    - What is the recall % across each category? 
    - What is the observed "proportion" of this class prediction?
 - False Positive Category Matrix
   - This is a matrix that observes which classes vs. false positives, in descending order

## Output Classification Accuracy Under Class Imbalance (Aggregate View)
  - Output the implied imbalance tax, if any
   - accuracy (vanity) 
   - macro-F1

## Output into a structured, typed object that answers the following question
- `how good is classifier at specific labels`? 
- `which label categories does this classifier perform the worst in`? 
- `How does the average accuracy on commonly seen classifier groups vs. imbalanced outliers`?
- `What were the cases where this classification was wrong`?
  - Grouped by Class Label

## Non Goals
- This evaluator stays "pure", it has no side-effects or opinions on how routing or downstream consumers will output this object.
- No working assumptions made on throughput or performance

### Input Contract (Schema Details To Be Fleshed Out in Spec)

## Classification Input Type
- An input interface to represent a given classifier output
<!-- {"id": "t01", "text": "I was charged twice for my subscription this month, please refund the duplicate.", "gold": "billing", "predicted": "billing"} -->

## Classification Label Universe (Optional Config with Default UNION behavior)
- An optional `config` representing the universe of gold labels can be passed to the evaluator
- If no config present, fallback to an explicit input representing the UNION of `gold label` and predicted, de-duplicated

### Output Contract (Schema Details to be Fleshed Out in Spec`ing Phase)

## Accuracy as a Record (Per Class Shape)
The per class evaluation should capture the following computed properties

## Class Eval Result as a Type
<!-- (support/predicted/tp/precision|null/recall|null/f1) -->
 - Supported
 - Predicted
 - tp
 - precision
 - recall
 - f1

```typescript
    interface ClassifierEvaluationResult { 
        perClassRecallResults: Record<ClassificationLabel, ClassEvalResult[]> // A a record that aggregates the per class recall
        // Aggregates
        averageAccuracy: number
        macroF1Score: number // mac-F1 score 
        imbalanceTax: number // signed accuracy − macroF1 (direction matters)
        // Debugging Purposes
        groupByIncorrectLabels: Record<ClassificationLabel, ClassificationInput>
    }
```


### High Level Solution
```ascii
    evaluator(input: jsonl)
     -> normalize(input)
        - validate / safeParse to ensure all inputs exist. 
        - Malformed, null/undefined records need to be handled
          - SKIP
        - pure function with a unit test

     -> makeClassAwareEvaluationResult(input)
       - create the groupBy
       - aggregate per class results

       - Pure functions, with unit test each
        - compute precision
        - compute recall
        - compute tp
        - compute micro accuracy
        - compute macro-F1 Score
        - compute imbalance tax
```

### DoD
- A script that can run this evaluator under `src/bin/scripts` and ingest any `classification.jsonl` as an input.
- Unit tests on pure functions added
- Normalization handles edge cases we expect from `classification.jsonl`
