# The LLM seam — a decision record

This is the layer that stands between the domain and a non-deterministic, rate-limited,
occasionally-refusing external service. It exists to answer exactly one question, in
exactly one place:

> **Something came back from the model. What do I do with this job?**

Read this before a build. It is written to be *defended*, not just used: every decision
below names the alternative it rejected and what breaks if the decision is wrong.

---

## The thesis, in 90 seconds

An LLM call has far more outcomes than `try { ... } catch { ... }` can express. A 429, a
529, a refusal, a truncated answer, a prompt that never fit, and a model that ignored a
forced tool are **six different problems with six different remedies** — and a `catch`
block flattens them into one. So does a `retryable: boolean`.

Three moves follow from that:

1. **Operational failures are VALUES, not exceptions.** They were all planned for, so
   they are modelled. `LlmOutcome` is a discriminated union whose `route` **is** the
   triage decision. Exceptions are reserved for things nobody planned for (a missing API
   key at construction).

2. **The translation happens once, in the adapter.** The adapter is the only place that
   sees both the raw provider signals (`stop_reason`, HTTP status, SDK error class,
   `retry-after`) and the domain that must act on them. Nothing downstream re-derives
   "is this retryable" — if it did, the two copies would drift.

3. **The normalization is lossy, so we keep the receipt.** `LlmSignals` carries the
   untouched `stop_reason`, HTTP status, provider code and request id alongside every
   outcome. When a route looks wrong in production, that receipt is the only thing that
   can tell you whether the provider changed or we mis-mapped it.

Everything else in this document is a consequence of those three.

---

## The map

### The call

```
 complete(req) / generateObject(req)
   │
   ├─ PRE-FLIGHT ─────────► decompose/input_too_large   (free — no paid request)
   │   count_tokens, but only when a free local estimate says we're near the limit
   │
   ├─ sdk.messages.create(...)
   │   └─ throws? ────────► routeThrownError(e)      [error tree below]
   │
   ├─ TRUST BOUNDARY: safeParse the wire response (a PROJECTION, not a mirror)
   │   └─ fails? ─────────► alert/provider_response_invalid   (our map is stale — page)
   │
   ├─ routeNonTerminalStop(stop)                     [stop tree below]
   │
   └─ generateObject only:
       ├─ TRUST BOUNDARY: safeParse the model's tool_use input against the caller's schema
       │   └─ fails? ─────► dead_letter/invalid_output   (wrong SHAPE — a human reads it)
       └─ no tool block? ─► retry/model_noncompliant     (it wrote prose — resample)
```

### stop_reason → route

```
 end_turn / stop_sequence ────────────► complete

 max_tokens ──────────────────────────► decompose / output_truncated
                                        OUTPUT side. The input fit; generation was cut
                                        at the cap. Remedy: BIGGER BUDGET.

 model_context_window_exceeded ───────► decompose / input_too_large
                                        INPUT side. The prompt never fit.
                                        Remedy: CHUNK THE INPUT.
                                        ── same queue, opposite remedy ──

 refusal ─────────────────────────────► dead_letter / refusal
                                        a 200 OK whose content must NOT be used

 anything unrecognized ───────────────► alert
                                        don't guess; a human reads signals.rawStopReason
```

### HTTP / SDK error → route

```
 APIUserAbortError ───────────► cancelled          (caller left; nothing to page)
 APIConnectionTimeoutError ───► retry / timeout    ⚠ may already have run — see DOUBLE-BILL
 APIConnectionError ──────────► retry / network    ⚠ ditto  (must come AFTER the timeout
                                                     check — timeout EXTENDS connection)
 413 ─────────────────────────► decompose / input_too_large   (SDK has no class for it)
 429  RateLimitError ─────────► retry / rate_limit  + retry-after
 5xx  InternalServerError ────► 529 ? retry/overloaded   (capacity)
                                    : retry/server_error (breakage)
 401/403 ─────────────────────► dead_letter / auth        (alerting rule keys on this)
 404  NotFoundError ──────────► dead_letter / not_found   (bad model id — our bug)
 400  BadRequestError ────────► oversized-prompt prose? decompose : dead_letter
                                (a BACKSTOP only — the pre-flight is the real guard)
 422 ─────────────────────────► dead_letter / invalid_request
 409 ─────────────────────────► retry / server_error
 unmapped status ─────────────► alert
```

### The retry loop — four budgets, not one

```
 ROUTE / reason               REMEDY                        BUDGET (default)
 ─────────────────────────────────────────────────────────────────────────────
 complete                     emit the value                —
 retry / rate_limit   (429)   sleep(delay), same payload    transient     (4)
 retry / overloaded   (529)   sleep(delay), same payload    transient     (4)
 retry / server_error (5xx)   sleep(delay), same payload    transient     (4)
 retry / timeout              RESEND — may double-bill      unconfirmed   (1)
 retry / network              RESEND — may double-bill      unconfirmed   (1)
 retry / model_noncompliant   resample, NO sleep            resample      (1)
 decompose/output_truncated   grow budget, NO sleep         doubling      (2)
 decompose/input_too_large    -> caller: chunk the INPUT    none
 dead_letter                  -> caller: human review       none
 cancelled                    -> caller: nobody to page     none
 alert                        -> caller: page someone       none
```

Four counters, because a backoff costs **time**, a budget-doubling costs **exponential
money**, and a resend after a timeout may cost **the same generation twice**. Under one
shared counter, `truncate → 429 → truncate` exhausts a job having doubled the budget once
and backed off once — it did neither remedy properly. Separate counters, and each remedy
gets its full allowance.

---


## The questions you'll get asked

**"Isn't this over-engineered for a 90-minute challenge?"**
It isn't *written* in 90 minutes — it's **brought**. That's the whole premise of the repo:
carpenters bring their tools. What you spend on challenge day is the *decision*, not the
typing. And the decision is cheap to defend because the alternative is not "simpler code",
it's "a `catch` block that silently retries a refusal, chunks a document that fit fine, and
under-reports the bill." Those aren't hypotheticals — they are what a naive
`if (retryable) retry()` actually does with these six failure modes.

**"Why not just retry on 5xx and 429?"**
Because three of the six things that go wrong here don't come back as an HTTP error at all.
A refusal is a **200 OK**. A truncation is a **200 OK**. A model ignoring a forced tool is a
**200 OK**. Status-code triage is blind to exactly the failures that are unique to an LLM.

**"Why Zod if you already have TypeScript?"**
A TS type is erased at runtime. It is a *compile-time promise about data*, not a guarantee.
At the seam where a vendor's JSON becomes our types, the promise is unenforced — Zod is that
promise **enforced**, at the one place data crosses from a source we don't control. That's
also why we *don't* validate everywhere: re-parsing our own deterministic output is a smell.

**"Why is `usage` nullable on some routes and not others?"**
Because a 429 never produced a usage record and reporting zeros would make a **rejected call
look free**, while a truncation *did* produce one and you want it for cost. The type says
which is which, so nobody has to remember.

**"Isn't `alert` just a fancy way of swallowing unknowns?"**
It's the opposite. `alert` is the route that refuses to guess. An unrecognized `stop_reason`
or an unmapped status means *our map is out of date*, and the honest answer is "a human must
look at `signals.rawStopReason`" — not a coin-flip on retryability that will look like it
works right up until it doesn't.

**"You have a regex parsing a vendor's error message. Isn't that fragile?"**
Yes, deliberately — and it's a **backstop**, not the primary path. The `count_tokens`
pre-flight is the real guard, and it's free-ish and deterministic. The regex only catches
what slips past it, and it fails toward the **DLQ** (safe, a human looks) rather than toward
the **chunk queue** (expensive, loops). Fragile code is acceptable exactly when its failure
mode is the safe one.

---

## Deliberately NOT built

Scope discipline is part of the argument. None of these exist, and that's a decision:

- **No agentic tool loop.** No `continue` route, no `tool_use` mid-flight state. Add it in
  the same commit as the loop that needs it — see decision #22.
- **No streaming.** The budget ceiling is 16k tokens precisely so we never need it. Above
  that, the honest answer is "this wants streaming", not "tune the timeout".
- **No provider #2.** The seam (`LlmClient`) is what makes a second provider *possible*;
  building one now would be abstraction without a second concrete use case.
- **No circuit breaker, no request coalescing, no cost budget enforcement.** All real, none
  earned yet.

## Known gaps (say these before they're found)

Being able to name your own holes is most of what "defensible" means.

1. **`signals.requestId` means two different things.** On success it's `response.id` (the
   *message* id, `msg_…`); on failure it's `error.requestID` (the *request* id, `req_…`).
   They aren't comparable, so success-path correlation against provider logs doesn't work.
   The fix is to capture the SDK's `response._request_id`.
2. **The `cancelled` route is unreachable.** Nothing in `LlmRequest` exposes an
   `AbortSignal`, so no abort can ever be produced. Either plumb a `signal` or delete the
   route.
3. **An empty completion ships as success.** If the content array holds no text blocks,
   `complete()` returns `route: 'complete'` with `text: ''`. Everywhere else we're rigorous
   about never handing a consumer unusable content as an answer; here an empty string sails
   through.
4. **`cancelled` drops accumulated spend.** Its `usage` is typed `null`, so a cancel after a
   paid retry loses that cost. Correct-by-type, wrong-by-accounting. (Moot until gap #2.)
5. **The `CONTEXT_WINDOW` table is hardcoded.** It's verified against the live Models API in
   CI (`model-limits.test.ts`) rather than at boot — deliberate, so the seam stays testable
   without IO. But CI must actually run for that to be true.

## Where it lives

```
llm-disposition.ts   the taxonomy — routes and reasons. A pure leaf; imports nothing.
llm-outcome.ts       LlmOutcome<T> — the discriminated union everything switches on.
llm-errors.ts        LlmError — carries the route, not a second private taxonomy.
llm-client.ts        the REQUEST contract + the LlmClient interface. The provider seam.
llm-response.ts      the RESULT contract — what the model SAID and what it COST.
llm-object.ts        the structured-output seam. ONE schema drives the ask and the check.
llm-retry.ts         the loop. Four budgets. Owns backoff, jitter, budget growth.
anthropic/           the ONLY file that knows the vendor exists.
  anthropic-adapter.ts   raw signals -> LlmOutcome. The lossy translation, done once.
  model-limits.ts        context windows + the free estimator gating the paid pre-flight.
```

Tests sit on the two things that are business rules: **the classification table**
(`anthropic-adapter.test.ts` — pure functions over provider signals, no network, no mocked
SDK) and **the remedy budgets** (`llm-retry.test.ts` — fake `sleep`, fake `random`, no real
waiting). Nothing tests the glue.



## Decision record

Each row: what we did, what we rejected, and **what breaks if the decision is wrong.**

| # | Decision | Rejected alternative | Why | If we're wrong |
|---|---|---|---|---|
| 1 | Failures are **values** (`LlmOutcome`), not exceptions | `throw` on every non-2xx | Six failures, six remedies. A `catch` block flattens them into one and the caller re-derives the difference from a message string | Every call site invents its own triage, and they drift |
| 2 | **Discriminated union**, not a bag of nullable fields | `{ ok, error?, retryAfter? }` | `{ok: true, error: 'refused'}` must not be *representable*. `switch (route)` is exhaustive with no `default:` to hide in — adding a route breaks every consumer at compile time | Illegal states typecheck; every consumer defensively re-checks what the type should have guaranteed |
| 3 | **Route (treatment) ≠ reason (diagnosis)** | one `retryable: boolean` | A 529 and a truncated output are both "retryable", and need *opposite* remedies (wait vs. spend more budget). The boolean cannot say that | The retry loop waits politely for a truncation that will truncate identically, forever |
| 4 | **One taxonomy.** No `LlmError.kind` beside `route` | a private error enum | The old `kind` distinguished 401 from 403 but collapsed 500 into 529; the routes did exactly the opposite. Neither contained the other, so they were *guaranteed* to drift. The fine detail lives in `LlmSignals` — a receipt, not a second set of names | Two sources of truth for one decision. This one actually happened; both are deleted |
| 5 | **Retries owned in exactly one layer** (`maxRetries: 0` on the SDK) | leave the SDK's 2 retries on | 2 SDK retries × N app retries = silent retry multiplication, and the SDK's retries are invisible to our budgets and our cost accounting | You back off 8× when you asked for 4×, and the bill doesn't explain itself |
| 6 | **`input_too_large` ≠ `output_truncated`** | one `payload_too_large` | Chunking a document that fit fine will still truncate. Raising the budget on a prompt that never fit will still fail. **Same queue, opposite remedy** | The most expensive silent failure here: an infinite chunk-queue loop, or an infinite budget-doubling loop |
| 7 | **`count_tokens` pre-flight** for oversized prompts | regex the 400's prose | Anthropic reports an over-long prompt as a plain `invalid_request_error` whose only tell is its wording. Reacting to that means (a) paying for a request to learn something computable, and (b) betting the chunk queue on a vendor not rewording a string. The regex survives as a **backstop**, and fails toward the DLQ (safe) | Vendor rewords the error → the chunk queue silently goes to zero |
| 8 | Pre-flight is **gated behind a free local estimate** | always call `count_tokens` | It's cheap but not free — a real round trip. Most traffic is nowhere near the limit and never pays for it | A round trip on every call, for a check that almost never fires |
| 9 | The estimator **over-counts** (`chars/3`, not `chars/4`) | the familiar `chars/4` | `chars/4` is OpenAI's tokenizer; it *under*-counts Claude by 15–20% (worse on code). **An under-counting guard is a guard that silently stops guarding.** Over-counting costs one extra `count_tokens`; under-counting costs a failed paid request | The guard waves through prompts that don't fit, and we pay to find out |
| 10 | **Zod at the boundary only**, and a **projection** | validate everything / mirror the whole SDK type | A TS type is erased at runtime — a promise, not a guarantee. Validate untrusted input **once**, where it enters, and only the fields we consume. Parsing our own deterministic output is a smell | Either a runtime blind spot, or a schema that breaks every time the vendor adds a field we don't read |
| 11 | Strictly validate **model-generated content**; lightly validate the **envelope** | same rigour for both | The generated object is non-deterministic and is the thing that can lie. `stop_reason`/`usage` are transport | An LLM hallucination reaches the domain typed as valid |
| 12 | Keep **`raw`** beside the parsed object | just return the parsed value | When a downstream grounding check says the model lied, `raw` is the only evidence of what it actually said | The DLQ reviewer has the verdict but not the exhibit |
| 13 | Cache tokens are **nullable, not zero** | `?? 0` | `null` = the provider didn't report it. `0` = a genuine cache miss. Collapsing them makes a provider that **stopped reporting** look identical to a cache that **stopped working** | A cost dashboard that is quietly, confidently wrong |
| 14 | **Four retry budgets** | one counter | See above: `truncate → 429 → truncate` exhausts a shared counter having done neither remedy properly | Jobs die with allowance unspent, and you can't tell which remedy starved |
| 15 | **Timeout scales with the token budget** | fixed 30s | A timeout is a bet on how long generation takes, and doubling `maxTokens` doubles it. A fixed timeout means the **fix for a truncation manufactures a timeout** — which then routes as `retry` and hides the real cause | Truncation degrades into timeout, deterministically, and the signal points at the wrong thing |
| 16 | **Park**, don't block, when `retry-after` > `maxBackoffMs` | `sleep(retryAfterMs)` | `retry-after: 3600` is a real thing to receive. Sleeping it in-process pins a request and a Node process for an hour. The outcome carries the number — hand it back and let a **queue** park the job at zero cost | A one-hour hang that looks like a deadlock |
| 17 | **Jitter**, via a `ctx.random` seam | plain exponential backoff | A fleet rate-limited *together* backs off together and stampedes together — the retry storm recreates the overload. Spreading them out **is** the point of the delay. Equal jitter (half guaranteed, half random), so we still genuinely back off | Thundering herd; your retries cause the next 429 |
| 18 | Jitter goes **on top of** `retry-after`, never subtracted | jitter around it | Waiting *less* than the provider told you just burns a call. But every rate-limited client got the **same** number, so obeying it exactly re-synchronizes the fleet it was meant to spread | Either a wasted call or a synchronized herd |
| 19 | **Usage is summed across attempts** | return the last attempt's usage | A retried call costs the sum of every attempt. The adapter deliberately keeps `usage` on a truncation *because a paid-for failure must not look free* — returning only the survivor throws that away one layer up | The cost dashboard under-reports exactly the failures the design set out to make visible |
| 20 | **Timeout/network get their own tiny budget** | treat them like a 429 | The Messages API has **no idempotency key**, so a resend can't be deduped. A 429 is a *response* — the server refused, nothing was generated or billed. A timeout is not: the request may have run, generated, and **billed**, and we just stopped listening | You pay twice, generate twice, and nothing in the system says so |
| 21 | **529 ≠ 500** | one `5xx` bucket | The SDK lumps them into `InternalServerError`. 529 is *capacity* (back off harder, don't page); 500 is *breakage* (an incident) | You page on-call for a busy provider, or you fail to page for a broken one |
| 22 | `tool_use` is **not a route** | model it now, for the future loop | `complete()` sends no tools, and in `generateObject()` a forced `tool_use` **is** the terminal answer. A `continue` route today would be a type with no implementation and no way to fire. It gets added in the same commit as the loop that needs it — at which point the compiler forces every switch to handle it, loudly | Dead code that looks like a feature |
| 23 | Everything reachable through **`ctx` / `ContextWith<K>`** | import clients directly | A function's signature declares the exact IO it touches. It is the DI seam **and** the test seam — the same shape, with the outside world swapped for fakes | You can't unit-test the retry loop without a network and a real clock |
| 24 | The retry loop declares `ContextWith<'sleep' \| 'random'>` — **not `'llm'`** | include `'llm'` | It reaches the model through a `call` closure; it never touches `ctx.llm`. `ContextWith` exists precisely so a signature **cannot lie** about its IO | The type says it does network IO when it doesn't. The seam stops being trustworthy |

---