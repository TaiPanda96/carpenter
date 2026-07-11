/**
 * Classification-eval synthesis (Drill 03, Part A).
 *
 * Reads a `{ id, text, gold, predicted }` JSONL of support-ticket predictions
 * and aggregates it into a decision-grade read on classifier quality — written
 * to CASE.md. The point is not a single accuracy number but *where* the
 * classifier fails: per-class precision/recall/F1, a confusion matrix, and the
 * exact misclassified tickets.
 *
 * Why these metrics: accuracy lies under class imbalance and silently rewards a
 * classifier that ignores a rare class. Macro-F1 (unweighted mean over classes)
 * exposes that collapse; the two side by side is the story. Per-class numbers +
 * the confusion matrix say which class bleeds into which.
 *
 *   bun src/bin/script.ts                         # defaults below
 *   bun src/bin/script.ts -i path.jsonl -o OUT.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import { z } from "zod";

const DEFAULT_INPUT = "docs/specs/classification.jsonl";
const DEFAULT_OUTPUT = "docs/specs/CASE.md";

const RowSchema = z.object({
  id: z.string(),
  text: z.string(),
  gold: z.string(),
  predicted: z.string(),
});
type Row = z.infer<typeof RowSchema>;

/** Parse + validate JSONL at the boundary; fail loudly on a bad line. */
function parseRows(raw: string): Row[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return RowSchema.parse(JSON.parse(line));
      } catch (e) {
        throw new Error(`Bad row on line ${i + 1}: ${(e as Error).message}`);
      }
    });
}

interface ClassStat {
  label: string;
  support: number; // # gold instances (how many truly belong here)
  predictedCount: number; // # times the model emitted this label
  tp: number;
  precision: number | null; // null when the label is never predicted (0/0)
  recall: number | null; // null when support is 0
  f1: number | null;
}

interface Report {
  n: number;
  labels: string[];
  accuracy: number;
  macroF1: number; // unweighted mean of per-class F1 (treats rare == common)
  weightedF1: number; // support-weighted mean of per-class F1
  perClass: ClassStat[];
  confusion: Map<string, Map<string, number>>; // gold -> predicted -> count
  errors: Row[]; // every misclassified ticket
}

function f1(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

/**
 * Compute the full eval report. Pure: no IO, deterministic on its input — the
 * business logic worth lifting into /domain later.
 */
function computeReport(rows: Row[]): Report {
  const labels = [
    ...new Set(rows.flatMap((r) => [r.gold, r.predicted])),
  ].sort();

  const confusion = new Map<string, Map<string, number>>();
  for (const g of labels) {
    confusion.set(g, new Map(labels.map((p) => [p, 0])));
  }
  for (const r of rows) {
    const row = confusion.get(r.gold);
    if (row) row.set(r.predicted, (row.get(r.predicted) ?? 0) + 1);
  }

  const perClass: ClassStat[] = labels.map((label) => {
    const support = rows.filter((r) => r.gold === label).length;
    const predictedCount = rows.filter((r) => r.predicted === label).length;
    const tp = rows.filter(
      (r) => r.gold === label && r.predicted === label,
    ).length;
    const precision = predictedCount === 0 ? null : tp / predictedCount;
    const recall = support === 0 ? null : tp / support;
    return {
      label,
      support,
      predictedCount,
      tp,
      precision,
      recall,
      f1: f1(precision, recall),
    };
  });

  const correct = rows.filter((r) => r.gold === r.predicted).length;
  // Undefined F1 (a never-predicted class) counts as 0 — not predicting a real
  // class IS a failure, so it must drag the score down, not be excused.
  const f1s = perClass.map((c) => c.f1 ?? 0);
  const macroF1 = f1s.reduce((a, b) => a + b, 0) / (labels.length || 1);
  const totalSupport = perClass.reduce((a, c) => a + c.support, 0);
  const weightedF1 =
    perClass.reduce((a, c) => a + (c.f1 ?? 0) * c.support, 0) /
    (totalSupport || 1);

  return {
    n: rows.length,
    labels,
    accuracy: rows.length ? correct / rows.length : 0,
    macroF1,
    weightedF1,
    perClass,
    confusion,
    errors: rows.filter((r) => r.gold !== r.predicted),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null) => (x === null ? "—" : x.toFixed(2));

/** Render the report to Markdown. Pure string-building, no IO. */
function renderMarkdown(rep: Report): string {
  const L = rep.labels;

  // --- Findings: derived, ranked by severity ---
  const findings: string[] = [];
  const dead = rep.perClass.filter(
    (c) => c.support > 0 && c.predictedCount === 0,
  );
  for (const c of dead) {
    findings.push(
      `**\`${c.label}\` is invisible to the classifier** — ${c.support} gold tickets, predicted **0** times (recall 0%). Accuracy hides this entirely; macro-F1 is what catches it.`,
    );
  }
  const overPred = rep.perClass
    .filter(
      (c) =>
        c.precision !== null &&
        c.precision < 0.6 &&
        c.predictedCount > c.support,
    )
    .sort((a, b) => (a.precision ?? 0) - (b.precision ?? 0));
  for (const c of overPred) {
    findings.push(
      `**\`${c.label}\` is the dumping bucket** — predicted ${c.predictedCount}× but only ${c.support} are truly \`${c.label}\` (precision ${num(c.precision)}). Wrong-class tickets fall here by default.`,
    );
  }
  findings.push(
    `**Headline accuracy overstates quality**: accuracy ${pct(rep.accuracy)} vs macro-F1 ${num(rep.macroF1)}. The ${((rep.accuracy - rep.macroF1) * 100).toFixed(0)}-pt gap is the imbalance tax — common classes carry the average.`,
  );

  const out: string[] = [];
  out.push("# CASE — Classifier Quality (Drill 03, Part A)");
  out.push("");
  out.push(
    `> Generated by \`src/bin/script.ts\` from \`${DEFAULT_INPUT}\`. Static synthesis for the spec stage — **not** the deliverable.`,
  );
  out.push("");

  out.push("## TL;DR — the decision read");
  out.push("");
  out.push(
    `- **n = ${rep.n} tickets** across **${L.length} classes** — small sample; each ticket is ~${(100 / rep.n).toFixed(1)} pts, so treat every number as directional, not precise.`,
  );
  out.push(`- **Accuracy ${pct(rep.accuracy)}** — the vanity number.`);
  out.push(
    `- **Macro-F1 ${num(rep.macroF1)}** — the honest number (weights every class equally). **This is the one to trust.**`,
  );
  out.push(
    `- **Weighted-F1 ${num(rep.weightedF1)}** — support-weighted, sits between the two.`,
  );
  out.push("");

  out.push("## Key findings (ranked)");
  out.push("");
  findings.forEach((f, i) => out.push(`${i + 1}. ${f}`));
  out.push("");

  out.push("## Per-class scorecard");
  out.push("");
  out.push("| class | support | predicted | precision | recall | F1 |");
  out.push("|---|---:|---:|---:|---:|---:|");
  for (const c of [...rep.perClass].sort(
    (a, b) => (b.f1 ?? -1) - (a.f1 ?? -1),
  )) {
    out.push(
      `| \`${c.label}\` | ${c.support} | ${c.predictedCount} | ${num(c.precision)} | ${num(c.recall)} | ${num(c.f1)} |`,
    );
  }
  out.push("");
  out.push(
    "_Sorted by F1, worst last — reading down the F1 column *is* the “where does it fail” answer. `—` precision = class never predicted (0/0 undefined)._",
  );
  out.push("");

  out.push("## Confusion matrix");
  out.push("");
  out.push("Rows = gold (truth), columns = predicted. Diagonal = correct.");
  out.push("");
  out.push(
    `| gold ↓ \\ pred → | ${L.map((l) => `\`${l}\``).join(" | ")} | recall |`,
  );
  out.push(`|---|${L.map(() => "---:").join("|")}|---:|`);
  for (const g of L) {
    const row = rep.confusion.get(g);
    const stat = rep.perClass.find((c) => c.label === g);
    const cells = L.map((p) => {
      const v = row?.get(p) ?? 0;
      if (v === 0) return "·";
      return g === p ? `**${v}**` : String(v);
    });
    out.push(
      `| \`${g}\` | ${cells.join(" | ")} | ${num(stat?.recall ?? null)} |`,
    );
  }
  out.push("");

  out.push(`## Every misclassification (${rep.errors.length})`);
  out.push("");
  out.push("| id | gold → predicted | text |");
  out.push("|---|---|---|");
  for (const e of [...rep.errors].sort((a, b) =>
    a.gold.localeCompare(b.gold),
  )) {
    out.push(`| ${e.id} | \`${e.gold}\` → \`${e.predicted}\` | ${e.text} |`);
  }
  out.push("");

  out.push("## Metric traps this data would spring on a naive read");
  out.push("");
  out.push(
    "- **Accuracy under imbalance** — 61% sounds passing; it's carried by `billing`/`technical`. Macro-F1 is the guard.",
  );
  out.push(
    "- **A never-predicted class → precision 0/0** — undefined, not 0. Coding it as 0 silently, or dropping the class, would erase the single most important finding (`feedback` collapse). Shown as `—` and called out explicitly.",
  );
  out.push(
    "- **Tiny n** — 3–6 tickets/class. One flipped label swings a class F1 by ~0.2. Directions are trustworthy; decimals are not. Collect more before trusting any per-class number.",
  );
  out.push("");
  return out.join("\n");
}

const program = new Command();

program
  .description(
    "Aggregate classification.jsonl into a CASE.md quality synthesis",
  )
  .option("-i, --input <path>", "input JSONL", DEFAULT_INPUT)
  .option("-o, --output <path>", "output markdown", DEFAULT_OUTPUT)
  .action((opts: { input: string; output: string }) => {
    const rows = parseRows(readFileSync(opts.input, "utf8"));
    const report = computeReport(rows);
    writeFileSync(opts.output, renderMarkdown(report));

    // Console echo so the run is legible without opening the file.
    console.log(`Read ${report.n} rows from ${opts.input}`);
    console.log(
      `accuracy=${pct(report.accuracy)}  macro-F1=${num(report.macroF1)}  weighted-F1=${num(report.weightedF1)}`,
    );
    for (const c of report.perClass) {
      console.log(
        `  ${c.label.padEnd(10)} P=${num(c.precision)} R=${num(c.recall)} F1=${num(c.f1)} (support ${c.support})`,
      );
    }
    console.log(`→ wrote ${opts.output}`);
  });

program.parse(process.argv);
