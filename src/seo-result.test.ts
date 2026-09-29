import { expect, it } from "vitest";
import { validateSeoResult } from "./seo-result.js";
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
