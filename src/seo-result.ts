import { assertPath } from "./paths.js";
import type { SeoCheckResult, SeoEvidence } from "./seo-types.js";

export function validateSeoResult(result: SeoCheckResult, evidence: SeoEvidence): SeoCheckResult {
  const fail = () => {
    throw new Error("The SEO check returned an invalid or outdated result.");
  };
  const sections = [
    "metadata",
    "headings",
    "images",
    "links",
    "slug",
    "duplicates",
    ...(evidence.version === 2 ? ["canonical", "indexing", "social", "keyword"] : []),
  ];
  if (
    !result ||
    result.version !== evidence.version ||
    result.fingerprint !== evidence.fingerprint ||
    typeof result.rulesVersion !== "string" ||
    result.rulesVersion.length > 100 ||
    !Array.isArray(result.sections) ||
    result.sections.length !== sections.length
  )
    return fail();
  const seen = new Set<string>();
  const validText = (s: unknown) => typeof s === "string" && s.length <= 6000;
  for (const section of result.sections) {
    if (
      !section ||
      !sections.includes(section.id) ||
      seen.has(section.id) ||
      !validText(section.title) ||
      !["passed", "attention", "partial", "not-configured"].includes(section.status) ||
      !Array.isArray(section.details) ||
      section.details.some((s) => !validText(s)) ||
      !Array.isArray(section.findings)
    )
      return fail();
    seen.add(section.id);
    const findingIds = new Set<string>();
    for (const finding of section.findings) {
      if (
        !finding ||
        !validText(finding.id) ||
        findingIds.has(finding.id) ||
        !validText(finding.title) ||
        !validText(finding.message) ||
        !["warning", "notice"].includes(finding.severity)
      )
        return fail();
      findingIds.add(finding.id);
      assertPath(finding.path);
      if (
        finding.relatedDocument &&
        !evidence.duplicates?.some((d) =>
          d.matches.some(
            (m) =>
              m.documentId === finding.relatedDocument!.id &&
              m.documentType === finding.relatedDocument!.type,
          ),
        )
      )
        return fail();
    }
  }
  return result;
}
