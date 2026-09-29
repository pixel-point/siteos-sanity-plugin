import { describe, expect, it } from "vitest";
import { collectSnapshot } from "./snapshot.js";
import { prepareCorrection, validateCheckResult } from "./corrections.js";
import { formatPath } from "./paths.js";
import type { CheckResult, DocumentValue, Finding } from "./types.js";

async function setup(text = "A wrng word.") {
  const current: DocumentValue = { _id: "drafts.page", _type: "page", _rev: "r1", title: text };
  const snapshot = await collectSnapshot({
    document: current,
    mappings: { page: { fields: [{ path: ["title"], role: "title" }] } },
    sanityProjectId: "p",
    dataset: "d",
    readDocuments: async () => [],
  });
  const finding: Finding = {
    id: "f1",
    sourceId: snapshot.sources[0].id,
    kind: "spelling",
    quote: "wrng",
    replacement: "wrong",
    explanation: "Correct the spelling.",
    action: "replace",
  };
  const result: CheckResult = {
    fingerprint: snapshot.fingerprint,
    findings: [finding],
    limitations: [],
  };
  return { current, snapshot, finding, result };
}
describe("draft correction safety", () => {
  it("returns a revision-fenced patch of the exact selected quote", async () => {
    expect(prepareCorrection(await setup())).toEqual({
      documentId: "drafts.page",
      revision: "r1",
      set: { title: "A wrong word." },
    });
  });
  it("rejects remote edits and unsaved local edits", async () => {
    const input = await setup();
    expect(() =>
      prepareCorrection({ ...input, current: { ...input.current, _rev: "r2" } }),
    ).toThrow("document changed");
    expect(() =>
      prepareCorrection({ ...input, current: { ...input.current, title: "Unsaved edits" } }),
    ).toThrow("document changed");
  });
  it("does not guess which repeated quote to replace", async () => {
    const input = await setup("wrng and wrng");
    expect(() => prepareCorrection(input)).toThrow("more than once");
  });
  it("rejects mismatched check identity, source paths and destructive metadata replacements", async () => {
    const input = await setup();
    expect(() =>
      validateCheckResult({ ...input.result, fingerprint: "other" }, input.snapshot),
    ).toThrow("outdated");
    expect(() =>
      validateCheckResult(
        { ...input.result, findings: [{ ...input.finding, sourceId: "other" }] },
        input.snapshot,
      ),
    ).toThrow("does not match");
    expect(() =>
      validateCheckResult(
        {
          ...input.result,
          findings: [{ ...input.finding, action: "remove", kind: "placeholder", replacement: "" }],
        },
        input.snapshot,
      ),
    ).toThrow("body placeholders");
  });
  it("never patches a published document or a related document", async () => {
    const input = await setup();
    expect(() =>
      prepareCorrection({ ...input, current: { ...input.current, _id: "page" } }),
    ).toThrow("source draft");
    input.snapshot.sources[0].documentId = "drafts.related";
    expect(() => prepareCorrection(input)).toThrow("source draft");
  });
  it("uses keyed selectors and rejects path injection", () => {
    expect(formatPath(["sections", { _key: "a-b" }, "title"])).toBe('sections[_key=="a-b"].title');
    expect(() => formatPath(["title]", { _key: "key" }])).toThrow();
    expect(() => formatPath(["__proto__"])).toThrow();
  });
});
