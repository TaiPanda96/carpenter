/**
 * CLI boundary for the classification evaluator (spec-001, REQ-8).
 *
 * The ONLY IO in the slice: read a JSONL file, JSON-parse each line, hand the
 * raw records to the pure `evaluateClassification`, and print the scorecard.
 * A syntactically bad line is passed through as-is so the domain skips it (and
 * counts it) rather than the boundary crashing.
 *
 *   bun src/bin/evaluate.ts                      # defaults to the fixture
 *   bun src/bin/evaluate.ts -i path.jsonl
 */
import { readFileSync } from 'node:fs'
import {
  type ClassEvalResult,
  LabelUniverseError,
  evaluateClassification,
} from '@/lib/evaluation/domain/evaluate-classification'
import { Command } from 'commander'

const DEFAULT_INPUT = 'docs/specs/classification.jsonl'

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const num = (x: number | null) => (x === null ? '—' : x.toFixed(2))

function printResult(result: ReturnType<typeof evaluateClassification>): void {
  console.log(
    `evaluated=${result.evaluated}  skipped=${result.skippedRecords.length}  classes=${result.labels.length}`,
  )
  console.log(
    `overallAccuracy=${pct(result.overallAccuracy)}  macroF1=${result.macroF1Score.toFixed(2)}  imbalanceTax=${result.imbalanceTax >= 0 ? '+' : ''}${result.imbalanceTax.toFixed(2)}`,
  )
  console.log('\nper-class:')
  for (const label of result.labels) {
    const c: ClassEvalResult = result.perClass[label]
    console.log(
      `  ${label.padEnd(10)} support=${c.support} predicted=${c.predicted} P=${num(c.precision)} R=${num(c.recall)} F1=${num(c.f1)}`,
    )
  }
  const errorClasses = result.labels.filter((l) => result.groupByIncorrectLabels[l].length > 0)
  if (errorClasses.length > 0) {
    console.log('\nmisclassifications by gold class:')
    for (const label of errorClasses) {
      const errs = result.groupByIncorrectLabels[label]
      console.log(
        `  ${label} (${errs.length}): ${errs.map((e) => `${e.id}→${e.predicted}`).join(', ')}`,
      )
    }
  }
}

const program = new Command()

program
  .description('Evaluate classification predictions into a class-aware scorecard')
  .option('-i, --input <path>', 'input JSONL', DEFAULT_INPUT)
  .action((opts: { input: string }) => {
    const records: unknown[] = readFileSync(opts.input, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return line // let the domain skip + count it
        }
      })

    try {
      const result = evaluateClassification(records)
      printResult(result)
    } catch (e) {
      if (e instanceof LabelUniverseError) {
        console.error(`error: ${e.message}`)
        process.exit(1)
      }
      throw e
    }
  })

program.parse(process.argv)
