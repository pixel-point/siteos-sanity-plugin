import { expect, it } from "vitest";
import { validateSeoResult } from "./seo-result.js";
import { seoNotApplicable, seoReportSections } from "./seo-report.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import type { SeoCheckResult, SeoEvidence } from "./seo-types.js";

it("rejects stale responses, omitted coverage and navigation to unknown related documents", () => {
  const evidence = {
    version: 1,
    fingerprint: "snapshot",
    duplicates: [],
  } as unknown as SeoEvidence;
  const result: SeoCheckResult = {
    version: 1,
    fingerprint: "snapshot",
    rulesVersion: "cms-seo-v1",
    sections: (["metadata", "headings", "images", "links", "slug", "duplicates"] as const).map(
      (id) => ({ id, title: id, status: "not-configured", details: [], findings: [] }),
    ),
  };
  expect(validateSeoResult(result, evidence)).toBe(result);
  expect(() => validateSeoResult({ ...result, fingerprint: "old" }, evidence)).toThrow("outdated");
  expect(() => validateSeoResult({ ...result, sections: [] }, evidence)).toThrow("invalid");
  result.sections[0]!.findings.push({
    id: "f",
    severity: "warning",
    title: "Duplicate",
    message: "Review",
    path: ["title"],
    relatedDocument: { id: "unknown", type: "page" },
  });
  expect(() => validateSeoResult(result, evidence)).toThrow("invalid");
});

async function emptyReport() {
  const evidence = await collectSeoEvidence({
    document: { _id: "listing", _type: "listing", _rev: "r1" },
    mapping: {
      fields: [{ path: ["seo", "title"], role: "title" }],
      seo: { titleFallback: "Events & webinars" },
    },
    sanityProjectId: "project",
    dataset: "test",
    query: async () => [],
    signal: new AbortController().signal,
  });
  const result: SeoCheckResult = {
    version: 2,
    rulesVersion: "cms-seo-v2",
    fingerprint: evidence.fingerprint,
    sections: (
      [
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
      ] as const
    ).map((id) => ({
      id,
      title: id,
      status: id === "duplicates" ? "partial" : "not-configured",
      details: [],
      findings: [],
    })),
  };
  return { evidence, result };
}

it("only marks explicitly excluded sections as not applicable and preserves unmapped coverage", async () => {
  const { evidence, result } = await emptyReport();
  const original = structuredClone(result);
  const sections = seoReportSections(
    result,
    evidence,
    seoNotApplicable({
      notApplicable: { slug: "Fixed /events route." },
    }),
  );
  expect(sections.find((s) => s.id === "slug")).toMatchObject({
    status: "not-applicable",
    details: ["Fixed /events route."],
    findings: [],
  });
  expect(sections.find((s) => s.id === "images")?.status).toBe("not-configured");
  expect(sections.find((s) => s.id === "links")?.status).toBe("not-configured");
  expect(result).toEqual(original);
  expect(validateSeoResult(result, evidence)).toBe(result);
  expect(seoNotApplicable({ duplicates: false }).duplicates).toBeTruthy();
});

it("shows neutral duplicate availability only for empty or fallback values, never failed or missing evidence", async () => {
  const { evidence, result } = await emptyReport();
  const status = (input: SeoEvidence) =>
    seoReportSections(result, input).find((s) => s.id === "duplicates")?.status;
  expect(status(evidence)).toBe("no-values");
  expect(
    status({ ...evidence, fields: { ...evidence.fields, title: { path: ["title"], value: "" } } }),
  ).toBe("no-values");
  for (const section of ["duplicates", "metadata", "slug"] as const)
    expect(
      status({ ...evidence, limitations: [{ section, message: "Read or value unavailable" }] }),
    ).toBe("partial");
  expect(
    status({
      ...evidence,
      fields: { ...evidence.fields, title: { path: ["title"], value: "An actual title" } },
    }),
  ).toBe("partial");
  expect(status({ ...evidence, duplicates: null })).toBe("partial");
  expect(
    status({
      ...evidence,
      batch: {
        index: 1,
        total: 2,
        previousHeadingLevel: 0,
        primaryHeadingsBefore: 0,
        counts: { headings: 0, images: 0, links: 0, duplicates: 1 },
      },
    }),
  ).toBe("partial");
});
