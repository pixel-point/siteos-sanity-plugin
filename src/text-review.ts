import type { CheckResult, ContentSnapshot, SourceIssue } from "./types.js";

/** Collection gaps and execution gaps are independent of whether corrections were found. */
export function textReviewCoverage(
  snapshot: Pick<ContentSnapshot, "issues">,
  result: CheckResult | null,
) {
  const groups = new Map<string, SourceIssue[]>();
  for (const issue of snapshot.issues)
    groups.set(issue.message, [...(groups.get(issue.message) ?? []), issue]);
  const unfinished =
    !!result &&
    (result.complete === false ||
      !!(result.coverage && result.coverage.completed < result.coverage.total));
  const notes = [...new Set(result?.limitations ?? [])].filter((note) => !groups.has(note));
  return {
    groups: [...groups.entries()],
    notes,
    unfinished,
    partial: snapshot.issues.length > 0 || unfinished,
    emptyMessage: unfinished
      ? "No corrections confirmed in this partial check"
      : "No corrections found in checked text",
  };
}
