import { expect, it } from "vitest";
import { createSchema } from "sanity";
import { fieldLabel } from "./field-label.js";
import { textReviewCoverage } from "./text-review.js";
import type { CheckResult, ContentSnapshot, FieldPath } from "./types.js";

it("uses actual Studio field titles and the keyed block type without changing the navigation path", () => {
  const schema = createSchema({
    name: "labels",
    types: [
      {
        name: "page",
        type: "document",
        fields: [
          {
            name: "content",
            title: "Page content",
            type: "array",
            of: [
              {
                name: "chapterIndex",
                title: "Chapter Index",
                type: "object",
                fields: [
                  {
                    name: "subcategory",
                    title: "Handbook",
                    type: "reference",
                    to: [{ type: "page" }],
                  },
                ],
              },
              {
                name: "prose",
                title: "Prose",
                type: "object",
                fields: [{ name: "title", type: "string" }],
              },
            ],
          },
        ],
      },
    ],
  });
  const document = {
    content: [
      { _type: "prose", _key: "first" },
      { _type: "chapterIndex", _key: "opaque-key" },
    ],
  };
  const path: FieldPath = ["content", { _key: "opaque-key" }, "subcategory"];
  expect(fieldLabel(schema.get("page"), document, path)).toBe(
    "Page content › Chapter Index (2) › Handbook",
  );
  expect(path).toEqual(["content", { _key: "opaque-key" }, "subcategory"]);
  expect(fieldLabel(undefined, undefined, path)).toBe("Content › Item › Subcategory");
});

const snapshot: Pick<ContentSnapshot, "issues"> = {
  issues: [
    {
      code: "unsupported-reference",
      message: "Related type is not mapped.",
      documentId: "page",
      documentType: "page",
      path: ["related"],
    },
  ],
};
const result: CheckResult = {
  fingerprint: "test",
  findings: [],
  limitations: [snapshot.issues[0].message, "Provider note", "Provider note"],
  coverage: { completed: 1, total: 1 },
};

it("keeps collection gaps distinct from empty findings and deduplicates coverage explanations", () => {
  const coverage = textReviewCoverage(snapshot, result);
  expect(coverage).toMatchObject({ partial: true, unfinished: false, notes: ["Provider note"] });
  expect(coverage.groups).toEqual([[snapshot.issues[0].message, snapshot.issues]]);
  expect(coverage.emptyMessage).toContain("checked text");
  expect(textReviewCoverage(snapshot, null).partial).toBe(true);
});

it("retains incomplete execution even when collection succeeded, without claiming a clean check", () => {
  const completeSnapshot = { ...snapshot, issues: [] };
  expect(
    textReviewCoverage(completeSnapshot, { ...result, coverage: { completed: 0, total: 2 } }),
  ).toMatchObject({
    partial: true,
    unfinished: true,
    emptyMessage: "No corrections confirmed in this partial check",
  });
  expect(
    textReviewCoverage(completeSnapshot, { ...result, complete: false, coverage: undefined })
      .partial,
  ).toBe(true);
  expect(textReviewCoverage(completeSnapshot, { ...result, limitations: [] }).partial).toBe(false);
});
