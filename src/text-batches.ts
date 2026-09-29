import { snapshotFingerprint } from "./snapshot.js";
import { validateCheckResult } from "./corrections.js";
import type { CheckResult, ContentSnapshot, Source } from "./types.js";

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Lossless UTF-16 splitting, preferring a word boundary without dropping whitespace. */
export function splitText(text: string, size = 10000): string[] {
  if (!Number.isInteger(size) || size < 2)
    throw new Error("Text part size must be at least two characters.");
  const parts: string[] = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + size / 2) end = space + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
export async function textBatches(snapshot: ContentSnapshot) {
  const root = snapshot.documents.find((doc) => doc.id === snapshot.documentId);
  if (!root) throw new Error("The source document is unavailable.");
  const originals = new Map<string, string>();
  const pieces = snapshot.sources.flatMap((source) =>
    splitText(source.text)
      .filter((text) => text.trim())
      .map((text, index) => {
        const id = `${source.id}:part-${index}`;
        originals.set(id, source.id);
        return { ...source, id, text };
      }),
  );
  const batches: ContentSnapshot[] = [];
  const make = (sources: Source[]): Omit<ContentSnapshot, "fingerprint"> => {
    const ids = new Set([snapshot.documentId, ...sources.map((source) => source.documentId)]);
    return {
      version: 1,
      sanityProjectId: snapshot.sanityProjectId,
      dataset: snapshot.dataset,
      documentId: snapshot.documentId,
      perspective: snapshot.perspective,
      locale: snapshot.locale,
      documents: snapshot.documents.filter((doc) => ids.has(doc.id)),
      sources,
      issues: [],
    };
  };
  let selected: Source[] = [];
  const flush = async () => {
    if (!selected.length) return;
    const value = make(selected);
    batches.push({ ...value, fingerprint: await snapshotFingerprint(value) });
    selected = [];
  };
  for (const piece of pieces) {
    const candidate = make([...selected, piece]);
    if (
      candidate.sources.length > 100 ||
      candidate.documents.length > 20 ||
      candidate.sources.reduce((sum, source) => sum + source.text.length, 0) > 24000 ||
      byteLength(candidate) > 120000
    )
      await flush();
    selected.push(piece);
    if (byteLength(make(selected)) > 120000)
      throw new Error("A field path cannot fit in a review request. Review its schema mapping.");
  }
  await flush();
  if (!batches.length) throw new Error("No text is available in the selected content.");
  return { batches, originals };
}
export async function checkTextBatches(input: {
  snapshot: ContentSnapshot;
  signal: AbortSignal;
  check(batch: ContentSnapshot): Promise<CheckResult>;
  onProgress?(value: { completed: number; total: number; result: CheckResult }): void;
}): Promise<CheckResult> {
  const { batches, originals } = await textBatches(input.snapshot);
  const findings: CheckResult["findings"] = [],
    limitations = new Set(input.snapshot.issues.map((issue) => issue.message));
  const seen = new Set<string>();
  let completed = 0;
  const result = (): CheckResult => ({
    fingerprint: input.snapshot.fingerprint,
    findings: [...findings],
    limitations: [...limitations],
    coverage: { completed, total: batches.length },
  });
  input.onProgress?.({ completed, total: batches.length, result: result() });
  for (const [index, batch] of batches.entries()) {
    input.signal.throwIfAborted();
    const checked = validateCheckResult(await input.check(batch), batch);
    input.signal.throwIfAborted();
    for (const finding of checked.findings) {
      const sourceId = originals.get(finding.sourceId)!;
      const key = JSON.stringify([
        sourceId,
        finding.kind,
        finding.quote,
        finding.replacement,
        finding.action,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ...finding, id: `batch-${index}:${finding.id}`, sourceId });
    }
    for (const note of checked.limitations) limitations.add(note);
    if (checked.complete !== false) completed++;
    input.onProgress?.({ completed, total: batches.length, result: result() });
  }
  return result();
}
