import type { LlmOutcome } from './contract/outcome'

/**
 * Unwrap an outcome, throwing on any failure route.
 *
 * BOUNDARY ONLY. biome.json bans importing THIS FILE from `src/lib/**\/domain/**`
 * — it is a lint failure, not a convention you have to remember at 2am.
 *
 * It lives in its own file precisely so that ban can be surgical: domain code
 * still imports the `LlmOutcome` TYPE from `llm-outcome.ts` (it must — that is
 * what it returns), and only the unwrap is out of reach.
 *
 * WHY: unwrapping is lossy, and a domain function that unwraps becomes
 * un-composable. Nobody downstream can retry it, chunk it, batch it, or account for
 * its token cost, because the information needed to do any of that was destroyed
 * inside it. Values compose; exceptions do not. Fan fifty documents through a
 * domain function that returns outcomes and you can group them by route and
 * batch-retry the 429s. Fan them through one that throws, and `Promise.allSettled`
 * has already flattened your union into `{status, reason}` — with the usage on
 * every FAILED call gone, so your cost accounting silently under-reports every
 * truncation and refusal.
 *
 * It exists because the outermost leaf — a server action, a route handler, a
 * script — genuinely has nowhere to park a job, and there linear code is the
 * honest shape. The thrown `LlmError` still carries `route`, `reason` and
 * `signals`, so even a `catch` block can triage if it wants to.
 */
export function expectComplete<T>(outcome: LlmOutcome<T>): T {
  if (outcome.route === 'complete') return outcome.value
  throw outcome.error
}
