import { formatPath, readPath } from "./paths.js";
import type { CheckResult, ContentSnapshot, DocumentValue, Finding } from "./types.js";

export function validateCheckResult(value: CheckResult, snapshot: ContentSnapshot): CheckResult {
  if (
    !value ||
    value.fingerprint !== snapshot.fingerprint ||
    !Array.isArray(value.findings) ||
    value.findings.length > 100 ||
    !Array.isArray(value.limitations) ||
    value.limitations.length > 50 ||
    value.limitations.some((item) => typeof item !== "string" || item.length > 2000)
  )
    throw new Error("The check returned an invalid or outdated result.");
  const ids = new Set<string>();
  for (const finding of value.findings) {
    const source = snapshot.sources.find((item) => item.id === finding?.sourceId);
    if (
      !source ||
      typeof finding.id !== "string" ||
      !finding.id ||
      ids.has(finding.id) ||
      typeof finding.quote !== "string" ||
      !finding.quote ||
      !source.text.includes(finding.quote) ||
      typeof finding.replacement !== "string" ||
      finding.replacement.length > 6000 ||
      typeof finding.explanation !== "string" ||
      finding.explanation.length > 2000 ||
      !["metadata", "heading", "placeholder", "spelling", "grammar"].includes(finding.kind) ||
      !["replace", "remove"].includes(finding.action)
    )
      throw new Error("A finding does not match the reviewed content.");
    if (
      finding.action === "remove" &&
      (finding.kind !== "placeholder" || source.role !== "body" || finding.replacement !== "")
    )
      throw new Error("Only explicit body placeholders can be removed.");
    if (finding.action === "replace" && !finding.replacement.trim())
      throw new Error("A replacement cannot be empty.");
    ids.add(finding.id);
  }
  return value;
}

export function prepareCorrection(input: {
  snapshot: ContentSnapshot;
  result: CheckResult;
  finding: Finding;
  current: DocumentValue;
}) {
  validateCheckResult(input.result, input.snapshot);
  const finding = input.result.findings.find((item) => item.id === input.finding.id);
  if (!finding) throw new Error("The finding is not part of this check.");
  const source = input.snapshot.sources.find((item) => item.id === finding.sourceId)!;
  const current = input.current;
  if (
    !source.editable ||
    source.documentId !== input.snapshot.documentId ||
    !current._id.startsWith("drafts.") ||
    current._id !== source.documentId
  )
    throw new Error(
      "Open the source draft to edit this field. Rich-text corrections must be applied manually.",
    );
  if (current._rev !== source.revision || readPath(current, source.path) !== source.text)
    throw new Error("The document changed. Run a new check before applying this correction.");
  const offset = source.text.indexOf(finding.quote);
  if (offset < 0 || source.text.indexOf(finding.quote, offset + 1) !== -1)
    throw new Error("This quote occurs more than once. Edit the field manually.");
  const value =
    source.text.slice(0, offset) +
    finding.replacement +
    source.text.slice(offset + finding.quote.length);
  return {
    documentId: current._id,
    revision: source.revision,
    set: { [formatPath(source.path)]: value },
  };
}
