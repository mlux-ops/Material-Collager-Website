import type { NodeRun } from "./types";

// Immutable edit of one text candidate inside an existing run. The paid
// request signature stays unchanged so editing generated copy never re-bills
// the producer; the new runId is what invalidates downstream signatures.
export function replaceTextOutput(
  run: NodeRun,
  outputIndex: number,
  candidateIndex: number,
  text: string,
  runId: string,
  at = Date.now(),
): NodeRun {
  const candidate = run.values[outputIndex]?.[candidateIndex];
  if (!candidate || candidate.kind !== "text") return run;

  const values = run.values.map((output, index) =>
    index === outputIndex
      ? output.map((value, valueIndex) =>
          valueIndex === candidateIndex && value.kind === "text" ? { ...value, text } : value,
        )
      : output,
  );
  return { ...run, runId, at, values };
}
