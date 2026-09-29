import { snapshotFingerprint } from "./snapshot.js";
import { validateSeoResult } from "./seo-result.js";
import type { SeoEvidence, SeoCheckResult } from "./seo-types.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Keep requests bounded while retaining every observation and heading sequence. */
export async function seoBatches(evidence: SeoEvidence): Promise<SeoEvidence[]> {
  if (evidence.version === 1) return [evidence];
  const duplicateParts =
    evidence.duplicates?.flatMap((item) => {
      if (!item.matches.length) return [item];
      const parts: typeof evidence.duplicates = [];
      for (let at = 0; at < item.matches.length; at += 10)
        parts.push({ ...item, matches: item.matches.slice(at, at + 10) });
      return parts;
    }) ?? [];
  const remaining = {
    headings: evidence.headings ?? [],
    images: evidence.images ?? [],
    links: evidence.links ?? [],
    duplicates: duplicateParts,
    limitations: evidence.limitations,
  };
  const at = { headings: 0, images: 0, links: 0, duplicates: 0, limitations: 0 };
  const limits = { headings: 100, images: 100, links: 100, duplicates: 3, limitations: 30 };
  const batches: SeoEvidence[] = [];
  let previousHeadingLevel = 0,
    primaryHeadingsBefore = 0;
  do {
    const batch: SeoEvidence = {
      ...evidence,
      headings: evidence.headings === null ? null : [],
      images: evidence.images === null ? null : [],
      links: evidence.links === null ? null : [],
      duplicates: evidence.duplicates === null ? null : [],
      limitations: [],
      batch: {
        index: batches.length,
        total: 1,
        previousHeadingLevel,
        primaryHeadingsBefore,
        counts: {
          headings: remaining.headings.length,
          images: remaining.images.length,
          links: remaining.links.length,
          duplicates: evidence.duplicates?.length ?? 0,
        },
      },
      fingerprint: "0".repeat(64),
    };
    if (bytes(batch) > 120000)
      throw new Error("Mapped SEO metadata cannot fit in one request. Review the field mappings.");
    let added = 0;
    for (const key of ["headings", "images", "links", "duplicates", "limitations"] as const) {
      const target = batch[key] as unknown[] | null;
      if (!target) continue;
      while (at[key] < remaining[key].length && target.length < limits[key]) {
        target.push(remaining[key][at[key]]);
        if (bytes(batch) > 120000) {
          target.pop();
          break;
        }
        at[key]++;
        added++;
      }
    }
    if (
      !added &&
      Object.keys(at).some(
        (key) => at[key as keyof typeof at] < remaining[key as keyof typeof at].length,
      )
    )
      throw new Error("An SEO observation cannot fit in one request. Review its mapping.");
    for (const heading of batch.headings ?? []) {
      previousHeadingLevel = heading.level;
      if (heading.level === 1) primaryHeadingsBefore++;
    }
    batches.push(batch);
  } while (
    Object.keys(at).some(
      (key) => at[key as keyof typeof at] < remaining[key as keyof typeof at].length,
    )
  );
  for (const batch of batches) {
    batch.batch!.total = batches.length;
    const { fingerprint: _fingerprint, ...value } = batch;
    batch.fingerprint = await snapshotFingerprint(value);
  }
  return batches;
}
export async function checkSeoBatches(input: {
  evidence: SeoEvidence;
  signal: AbortSignal;
  check(batch: SeoEvidence): Promise<SeoCheckResult>;
}): Promise<SeoCheckResult> {
  const batches = await seoBatches(input.evidence);
  let result: SeoCheckResult | null = null;
  const seen = new Map<string, Set<string>>();
  const priority = { "not-configured": 0, passed: 1, attention: 2, partial: 3 };
  for (const [index, batch] of batches.entries()) {
    input.signal.throwIfAborted();
    const checked = validateSeoResult(await input.check(batch), batch);
    input.signal.throwIfAborted();
    if (!result)
      result = {
        ...checked,
        fingerprint: input.evidence.fingerprint,
        sections: checked.sections.map((section) => ({ ...section, details: [], findings: [] })),
      };
    if (checked.rulesVersion !== result.rulesVersion)
      throw new Error("SEO rules changed during this check. Run it again.");
    for (const section of checked.sections) {
      const target = result.sections.find((item) => item.id === section.id)!;
      if (priority[section.status] > priority[target.status]) target.status = section.status;
      target.details = [...new Set([...target.details, ...section.details])];
      const keys = seen.get(section.id) ?? new Set<string>();
      seen.set(section.id, keys);
      for (const finding of section.findings) {
        const key = JSON.stringify([
          finding.title,
          finding.message,
          finding.path,
          finding.relatedDocument,
        ]);
        if (keys.has(key)) continue;
        keys.add(key);
        target.findings.push({ ...finding, id: `${index}:${finding.id}` });
      }
    }
  }
  return validateSeoResult(result!, input.evidence);
}
