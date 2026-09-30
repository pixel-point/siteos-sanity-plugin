import type { SeoCheckResult, SeoEvidence, SeoMapping, SeoNotApplicable } from "./seo-types.js";

const sectionIds = new Set([
  "metadata",
  "headings",
  "images",
  "links",
  "slug",
  "duplicates",
  "canonical",
  "indexing",
  "social",
  "keyword",
]);

export function validateSeoNotApplicable(value: SeoNotApplicable | undefined) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SEO notApplicable must map section IDs to reasons.");
  for (const [id, reason] of Object.entries(value))
    if (!sectionIds.has(id) || typeof reason !== "string" || !reason.trim() || reason.length > 500)
      throw new Error(
        "Each SEO notApplicable entry needs a known section ID and a reason of 1–500 characters.",
      );
}

/** Capture scope with the result so later configuration edits cannot relabel an old audit. */
export function seoNotApplicable(mapping: SeoMapping | undefined): SeoNotApplicable {
  validateSeoNotApplicable(mapping?.notApplicable);
  return {
    ...(mapping?.duplicates === false
      ? { duplicates: "Duplicate comparison is disabled for this document type." }
      : {}),
    ...mapping?.notApplicable,
  };
}

type ReportSection = Omit<SeoCheckResult["sections"][number], "status"> & {
  status: SeoCheckResult["sections"][number]["status"] | "not-applicable" | "no-values";
};

/** Presentation of audit scope/data availability; the server's rule verdicts remain unchanged. */
export function seoReportSections(
  result: SeoCheckResult,
  evidence: SeoEvidence,
  notApplicable: SeoNotApplicable = {},
): ReportSection[] {
  return result.sections.map((section) => {
    const reason = notApplicable[section.id];
    if (reason) return { ...section, status: "not-applicable", details: [reason], findings: [] };
    if (
      section.id === "duplicates" &&
      (section.status === "partial" || section.status === "passed") &&
      !section.findings.length &&
      evidence.duplicates?.length === 0 &&
      !(evidence.batch?.counts.duplicates ?? 0) &&
      !evidence.limitations.some((item) =>
        ["duplicates", "metadata", "slug"].includes(item.section),
      ) &&
      [evidence.fields.title, evidence.fields.description, evidence.fields.slug].every(
        (field) => !field?.value?.trim() || field.fallback,
      )
    )
      return {
        ...section,
        status: "no-values",
        details: [
          "No non-empty source values to compare. Empty fields and website defaults are excluded from duplicate comparison.",
        ],
      };
    return section;
  });
}
