import { describe, expect, it, vi } from "vitest";
import { collectSnapshot } from "./snapshot.js";
import type { DocumentMapping, DocumentValue, ReadDocuments } from "./types.js";

const mapping: Record<string, DocumentMapping> = {
  page: {
    fields: [
      { path: ["title"], role: "title", required: true },
      { path: ["body"], role: "body", format: "portableText" },
    ],
    references: [["related"]],
  },
};
const doc = (id = "drafts.page", values = {}): DocumentValue => ({
  _id: id,
  _type: "page",
  _rev: "r1",
  title: "A title",
  ...values,
});
const collect = (document: DocumentValue, readDocuments: ReadDocuments = vi.fn(async () => [])) =>
  collectSnapshot({
    document,
    readDocuments,
    mappings: mapping,
    sanityProjectId: "project",
    dataset: "production",
  });

describe("Sanity source snapshots", () => {
  it("preserves text across inline spans and stable block paths without making rich text directly patchable", async () => {
    const snapshot = await collect(
      doc(undefined, {
        body: [
          {
            _key: "block1",
            _type: "block",
            style: "normal",
            children: [
              { _type: "span", text: "Site" },
              { _type: "span", text: "OS works" },
            ],
          },
        ],
      }),
    );
    expect(snapshot.sources[1]).toMatchObject({
      text: "SiteOS works",
      path: ["body", { _key: "block1" }],
      editable: false,
    });
    expect(snapshot.sources[0].editable).toBe(true);
  });
  it("prefers draft references and terminates a cycle", async () => {
    const root = doc(undefined, { related: { _ref: "child" } });
    const read = vi.fn<ReadDocuments>(async () => [
      doc("child", { title: "Published" }),
      doc("drafts.child", { title: "Draft", related: { _ref: "page" } }),
    ]);
    const snapshot = await collect(root, read);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toEqual(["drafts.child", "child"]);
    expect(snapshot.sources.map((source) => source.text)).toEqual(["A title", "Draft"]);
    expect(snapshot.sources[1].editable).toBe(false);
  });
  it("never reads drafts for a published review", async () => {
    const read = vi.fn<ReadDocuments>(async () => [
      doc("drafts.child", { title: "Private draft" }),
      doc("child", { title: "Published" }),
    ]);
    const snapshot = await collect(doc("page", { related: { _ref: "child" } }), read);
    expect(read.mock.calls[0]?.[0]).toEqual(["child"]);
    expect(snapshot.sources.map((source) => source.text)).toEqual(["A title", "Published"]);
    expect(snapshot.sources.every((source) => !source.editable)).toBe(true);
  });
  it("changes the fingerprint when a referenced revision changes even with identical text", async () => {
    const root = doc(undefined, { related: { _ref: "child" } });
    const first = await collect(
      root,
      vi.fn(async () => [doc("child")]),
    );
    const second = await collect(
      root,
      vi.fn(async () => [doc("child", { _rev: "r2" })]),
    );
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });
  it("reports unavailable context and missing required fields instead of a clean result", async () => {
    const snapshot = await collect(doc(undefined, { title: "", related: { _ref: "missing" } }));
    expect(snapshot.issues.map((issue) => issue.code)).toEqual([
      "missing-field",
      "unavailable-reference",
    ]);
    expect(snapshot.sources).toEqual([]);
  });
  it("reports failed reference lookups and does not follow cross-dataset references", async () => {
    const read = vi.fn(async (): Promise<DocumentValue[]> => []);
    const related = [
      { _ref: "external", _dataset: "secret" },
      ...Array.from({ length: 200 }, (_, i) => ({ _ref: `missing${i}` })),
    ];
    const snapshot = await collect(doc(undefined, { related }), read);
    expect(read.mock.calls.length).toBe(200);
    expect(read.mock.calls.flat(2)).not.toContain("external");
    expect(snapshot.issues.some((issue) => issue.code === "unsupported-reference")).toBe(true);
    expect(snapshot.issues.some((issue) => issue.code === "limit")).toBe(false);
  });
  it("retains long fields for batched checks", async () => {
    const snapshot = await collect(doc(undefined, { title: "a".repeat(24_001) }));
    expect(snapshot.sources[0].text).toHaveLength(24_001);
    expect(snapshot.issues).toEqual([]);
  });
  it("does not mask cancelled or failed Sanity reads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectSnapshot({
        document: doc(),
        mappings: mapping,
        readDocuments: vi.fn(),
        sanityProjectId: "p",
        dataset: "d",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(
      collect(
        doc(undefined, { related: { _ref: "child" } }),
        vi.fn(async () => {
          throw new Error("offline");
        }),
      ),
    ).rejects.toThrow("offline");
  });
});
