import { describe, expect, it, vi } from "vitest";
import { collectSeoEvidence } from "./seo-snapshot.js";
import type { DocumentMapping, DocumentValue } from "./types.js";

const document: DocumentValue = {
  _id: "drafts.page",
  _type: "page",
  _rev: "r1",
  title: "Page",
  description: "Summary",
  locale: "es",
  slug: { current: "page" },
  body: [
    {
      _key: "heading",
      _type: "block",
      style: "h3",
      children: [{ _type: "span", text: "Details" }],
    },
    { _key: "image", _type: "image", asset: { _ref: "image-asset" }, alt: "", decorative: true },
    {
      _key: "link",
      _type: "block",
      style: "normal",
      children: [{ _type: "span", text: "Related page", marks: ["internal"] }],
      markDefs: [{ _key: "internal", _type: "internalLink", reference: { _ref: "child" } }],
    },
  ],
};
const mapping: DocumentMapping = {
  fields: [
    { path: ["title"], role: "title" },
    { path: ["description"], role: "description" },
    { path: ["body"], role: "body", format: "portableText" },
  ],
  locale: ["locale"],
  seo: { slug: ["slug", "current"], primaryHeading: ["title"] },
};
const collect = (overrides: Partial<Parameters<typeof collectSeoEvidence>[0]> = {}) =>
  collectSeoEvidence({
    document,
    mapping,
    sanityProjectId: "project",
    dataset: "test",
    signal: new AbortController().signal,
    query: async () => [],
    ...overrides,
  });

describe("Sanity SEO evidence adapter", () => {
  it("retains keyed paths, decorative intent and heading levels, resolving references in the selected perspective", async () => {
    const query = vi.fn(async (_query: string, params: Record<string, unknown>) =>
      params.ids ? [{ _id: "child" }] : [],
    );
    const result = await collect({ query });
    expect(result.headings?.map((h) => h.level)).toEqual([1, 3]);
    expect(result.images).toEqual([
      { path: ["body", { _key: "image" }], alt: "", decorative: true, hasAsset: true },
    ]);
    expect(result.links?.[0]).toEqual({
      path: ["body", { _key: "link" }, "markDefs", { _key: "internal" }],
      href: null,
      text: "Related page",
      reference: { id: "child", exists: true },
    });
    expect(query.mock.calls[0]?.[1]).toEqual({ ids: ["child"] });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("_id in $ids"),
      expect.anything(),
      expect.any(AbortSignal),
      "drafts",
    );
  });
  it("compares exact values in same-type and locale scope and excludes both current document versions", async () => {
    const query = vi.fn(async (_q: string, params: Record<string, unknown>) =>
      params.value === "Page" ? [{ _id: "drafts.other", _type: "page" }] : [],
    );
    const result = await collect({ query });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("locale == $locale"),
      {
        type: "page",
        self: ["drafts.page", "page", "drafts.page"],
        value: "Page",
        locale: "es",
        after: "",
      },
      expect.any(AbortSignal),
      "drafts",
    );
    expect(result.duplicates?.[0]?.matches).toEqual([
      { documentId: "other", documentType: "page" },
    ]);
    const publishedQuery = vi.fn(async () => []);
    await collect({ document: { ...document, _id: "page" }, query: publishedQuery });
    expect(publishedQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(AbortSignal),
      "published",
    );
  });
  it("does not turn unavailable reads or unmapped fields into clean evidence", async () => {
    const result = await collect({
      mapping: { ...mapping, seo: {} },
      query: async () => {
        throw new Error("permission denied");
      },
    });
    expect(result.fields.slug).toBeNull();
    expect(result.primaryHeadingMapped).toBe(false);
    expect(result.links?.[0]?.reference?.exists).toBeNull();
    expect(result.limitations.map((l) => l.section)).toContain("links");
    expect(result.limitations.map((l) => l.section)).toContain("duplicates");
  });
  it("retains duplicate matches and distinguishes absent fields from invalid collections", async () => {
    const matches = Array.from({ length: 11 }, (_, n) => ({ _id: `page-${n}`, _type: "page" }));
    const result = await collect({
      document: { ...document, body: "not Portable Text" },
      query: async () => matches,
    });
    expect(result.duplicates?.[0]?.matches).toHaveLength(11);
    expect(result.duplicates?.[0]?.more).toBe(false);
    expect(result.limitations.map((l) => l.section)).toEqual(
      expect.arrayContaining(["headings", "images", "links"]),
    );
    const missing = await collect({
      document: { ...document, title: undefined, description: undefined, slug: undefined },
    });
    expect(missing.fields.title).toEqual({ path: ["title"], value: null });
  });
  it("keeps cancellation and unsafe field paths from becoming successful checks", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect({ signal: controller.signal })).rejects.toThrow();
    await expect(
      collect({ mapping: { ...mapping, seo: { title: ["title] | *[_type"] } } }),
    ).rejects.toThrow("field names");
    await expect(
      collect({ mapping: { ...mapping, seo: { notApplicable: { slug: " " } } } }),
    ).rejects.toThrow("reason");
    await expect(
      collect({ mapping: { ...mapping, seo: { notApplicable: { slugs: "typo" } } as never } }),
    ).rejects.toThrow("section ID");
  });
  it("skips explicitly disabled duplicate reads while retaining structured image and link evidence", async () => {
    const query = vi.fn(async () => []);
    const result = await collect({
      query,
      mapping: {
        ...mapping,
        seo: { notApplicable: { slug: "Fixed route.", duplicates: "Singleton page." } },
      },
    });
    expect(result.duplicates).toBeNull();
    expect(result.images).toHaveLength(1);
    expect(result.links).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("_id in $ids"),
      { ids: ["child"] },
      expect.any(AbortSignal),
      "drafts",
    );
    expect(result).not.toHaveProperty("notApplicable");
  });
  it("reads duplicate pages beyond the first 100 matches using a stable cursor", async () => {
    const matches = Array.from({ length: 105 }, (_, n) => ({
      _id: `other-${String(n).padStart(3, "0")}`,
      _type: "page",
    }));
    const query = vi.fn(async (_q: string, params: Record<string, unknown>) =>
      params.value === "Page"
        ? matches.filter((row) => row._id > String(params.after)).slice(0, 100)
        : [],
    );
    const result = await collect({ query });
    expect(result.duplicates?.[0]?.matches).toHaveLength(105);
    expect(result.duplicates?.[0]?.matches.at(-1)?.documentId).toBe("other-104");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("order(_id asc)"),
      expect.objectContaining({ after: "other-099" }),
      expect.any(AbortSignal),
      "drafts",
    );
  });
});
