import { describe, expect, it, vi } from "vitest";
import { createSchema } from "sanity";
import { collectSnapshot } from "./snapshot.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import { checkTextBatches, splitText, textBatches } from "./text-batches.js";
import { seoBatches, checkSeoBatches } from "./seo-batches.js";
import type { CheckResult, DocumentMapping, DocumentValue } from "./types.js";
import type { SeoCheckResult } from "./seo-types.js";

const signal = () => new AbortController().signal;
const mapping: DocumentMapping = {
  fields: [{ path: ["content"], role: "body", format: "content" }],
  seo: { duplicates: false },
};
const block = (_key: string, text: string, style = "normal") => ({
  _key,
  _type: "block",
  style,
  children: [{ _type: "span", _key: "span", text }],
});
const doc = (content: unknown): DocumentValue => ({
  _id: "drafts.page",
  _type: "page",
  _rev: "r1",
  content,
});
const collect = (document: DocumentValue) =>
  collectSnapshot({
    document,
    mappings: { page: mapping },
    sanityProjectId: "project",
    dataset: "test",
    readDocuments: async () => [],
  });

describe("complete structured content", () => {
  it("uses the compiled schema to inspect callouts and table cells while excluding enums and code", async () => {
    const schema = createSchema({
      name: "test",
      types: [
        {
          name: "page",
          type: "document",
          fields: [
            {
              name: "content",
              type: "array",
              of: [
                {
                  name: "callout",
                  type: "object",
                  fields: [
                    { name: "tone", type: "string", options: { list: ["note", "warning"] } },
                    { name: "title", type: "string" },
                    { name: "body", type: "array", of: [{ type: "block" }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const document = doc([
      {
        _key: "callout",
        _type: "callout",
        title: "Useful note",
        tone: "warning",
        body: [block("copy", "Nested prose.")],
        code: { _type: "code", code: "const misspeling = true" },
      },
      {
        _key: "table",
        _type: "table",
        rows: [{ _key: "row", cells: [{ _key: "cell", content: [block("text", "Table cell.")] }] }],
      },
    ]);
    const snapshot = await collectSnapshot({
      document,
      schema,
      mappings: { page: mapping },
      sanityProjectId: "project",
      dataset: "test",
      readDocuments: async () => [],
    });
    expect(snapshot.sources.map((source) => source.text)).toEqual([
      "Useful note",
      "Nested prose.",
      "Table cell.",
    ]);
    expect(snapshot.sources.at(-1)?.path).toEqual([
      "content",
      { _key: "table" },
      "rows",
      { _key: "row" },
      "cells",
      { _key: "cell" },
      "content",
      { _key: "text" },
    ]);
    expect(snapshot.issues).toEqual([]);
  });
  it("keeps more than 100 sections, huge Unicode paragraphs, and findings from every batch", async () => {
    const long = "漢😀".repeat(10000);
    expect(splitText(long).join("")).toBe(long);
    const snapshot = await collect(
      doc([
        ...Array.from({ length: 230 }, (_, n) => block(`b${n}`, `Section ${n}: eror.`)),
        block("long", long),
      ]),
    );
    expect(snapshot.sources).toHaveLength(231);
    const { batches, originals } = await textBatches(snapshot);
    expect(batches.length).toBeGreaterThan(3);
    for (const batch of batches) {
      expect(batch.sources.length).toBeLessThanOrEqual(100);
      expect(
        batch.sources.reduce((sum, source) => sum + source.text.length, 0),
      ).toBeLessThanOrEqual(24000);
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThan(131072);
    }
    for (const source of snapshot.sources)
      expect(
        batches
          .flatMap((batch) => batch.sources)
          .filter((piece) => originals.get(piece.id) === source.id)
          .map((piece) => piece.text)
          .join(""),
      ).toBe(source.text);
    const progress = vi.fn();
    const result = await checkTextBatches({
      snapshot,
      signal: signal(),
      onProgress: progress,
      check: async (batch) => ({
        fingerprint: batch.fingerprint,
        limitations: [],
        findings: batch.sources
          .filter((source) => source.text.includes("eror"))
          .map((source) => ({
            id: source.id,
            sourceId: source.id,
            kind: "spelling",
            quote: "eror",
            replacement: "error",
            explanation: "Spelling",
            action: "replace",
          })),
      }),
    });
    expect(result.findings).toHaveLength(230);
    expect(result.findings.at(-1)?.sourceId).toBe(snapshot.sources[229].id);
    expect(result.coverage).toEqual({ completed: batches.length, total: batches.length });
    expect(result.fingerprint).toBe(snapshot.fingerprint);
  });
  it("exposes completed results if a later request fails or the user cancels", async () => {
    const snapshot = await collect(
      doc(Array.from({ length: 220 }, (_, n) => block(`b${n}`, "Text."))),
    );
    let latest: CheckResult | undefined;
    const controller = new AbortController();
    const check = vi.fn(async (batch: typeof snapshot) => ({
      fingerprint: batch.fingerprint,
      findings: [],
      limitations: [],
    }));
    await expect(
      checkTextBatches({
        snapshot,
        signal: controller.signal,
        check,
        onProgress: (progress) => {
          latest = progress.result;
          if (progress.completed === 1) controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(check).toHaveBeenCalledOnce();
    expect(latest?.coverage).toEqual({ completed: 1, total: 3 });
    check
      .mockImplementationOnce(async (batch) => ({
        fingerprint: batch.fingerprint,
        findings: [],
        limitations: [],
      }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(
      checkTextBatches({
        snapshot,
        signal: signal(),
        check,
        onProgress: (progress) => {
          latest = progress.result;
        },
      }),
    ).rejects.toThrow("offline");
    expect(latest?.coverage).toEqual({ completed: 1, total: 3 });
  });
  it("keeps failed provider parts incomplete while continuing the remaining batches", async () => {
    const snapshot = await collect(
      doc(Array.from({ length: 120 }, (_, n) => block(`b${n}`, "Text."))),
    );
    let calls = 0;
    const result = await checkTextBatches({
      snapshot,
      signal: signal(),
      check: async (batch) => ({
        fingerprint: batch.fingerprint,
        findings: [],
        limitations: calls++ === 0 ? ["A provider task could not be completed."] : [],
        complete: calls !== 1,
      }),
    });
    expect(calls).toBe(2);
    expect(result.coverage).toEqual({ completed: 1, total: 2 });
    expect(result.limitations).toContain("A provider task could not be completed.");
  });
  it("follows deep related-document chains without dropping documents or revisiting cycles", async () => {
    const snapshot = await collectSnapshot({
      document: { ...doc([]), related: { _ref: "p1" } },
      mappings: {
        page: { fields: [{ path: ["title"], role: "title" }], references: [["related"]] },
      },
      sanityProjectId: "project",
      dataset: "test",
      readDocuments: async (ids) => {
        const n = Number(ids[1].slice(1));
        return [
          {
            _id: ids[0],
            _type: "page",
            _rev: "rev",
            title: `Page ${n}`,
            related: { _ref: n < 30 ? `p${n + 1}` : "page" },
          },
        ];
      },
    });
    expect(snapshot.documents).toHaveLength(31);
    expect(snapshot.sources).toHaveLength(30);
    expect(
      (await textBatches(snapshot)).batches.every((batch) => batch.documents.length <= 20),
    ).toBe(true);
  });
  it("retains nested SEO evidence, all duplicate pages and heading continuity in bounded requests", async () => {
    const document = doc(
      Array.from({ length: 210 }, (_, n) => ({
        _key: `wrapper${n}`,
        _type: "callout",
        body: [
          block(`h${n}`, `Heading ${n}`, n === 0 ? "h1" : n === 100 ? "h4" : "h2"),
          {
            _key: `image${n}`,
            _type: "image",
            asset: { _ref: "image-test-1200x630-png" },
            alt: "Photo",
          },
        ],
      })),
    );
    const evidence = await collectSeoEvidence({
      document,
      mapping,
      sanityProjectId: "project",
      dataset: "test",
      query: async () => [],
      signal: signal(),
    });
    expect(evidence.headings).toHaveLength(210);
    expect(evidence.images).toHaveLength(210);
    expect(evidence.limitations).toEqual([]);
    evidence.duplicates = [
      {
        field: "title",
        path: ["title"],
        matches: Array.from({ length: 37 }, (_, n) => ({
          documentId: `other${n}`,
          documentType: "page",
        })),
        more: false,
      },
    ];
    const batches = await seoBatches(evidence);
    expect(batches[1].batch?.previousHeadingLevel).toBe(2);
    expect(batches[1].batch?.primaryHeadingsBefore).toBe(1);
    expect(batches[1].headings?.[0].level).toBe(4);
    expect(
      batches.flatMap((batch) => batch.duplicates ?? []).flatMap((item) => item.matches),
    ).toHaveLength(37);
    expect(batches.flatMap((batch) => batch.headings ?? [])).toEqual(evidence.headings);
    expect(
      batches.every(
        (batch) =>
          batch.images!.length <= 100 &&
          new TextEncoder().encode(JSON.stringify(batch)).length < 131072,
      ),
    ).toBe(true);
    const result = await checkSeoBatches({
      evidence,
      signal: signal(),
      check: async (batch): Promise<SeoCheckResult> => ({
        version: 2,
        fingerprint: batch.fingerprint,
        rulesVersion: "rules",
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
          status: "passed",
          details: ["Same detail"],
          findings:
            id === "images"
              ? (batch.images ?? []).map((item, i) => ({
                  id: String(i),
                  path: item.path,
                  severity: "warning",
                  title: "Image",
                  message: "Inspect",
                }))
              : [],
        })),
      }),
    });
    expect(result.sections.find((section) => section.id === "images")?.findings).toHaveLength(210);
    expect(result.sections[0].details).toEqual(["Same detail"]);
  });
});
