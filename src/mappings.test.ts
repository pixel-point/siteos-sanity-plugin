import { describe, expect, it } from "vitest";
import { collectSnapshot } from "./snapshot.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import {
  localizedArrayPath,
  reviewLocale,
  resolveDocumentMapping,
  validateMappings,
} from "./mappings.js";
import { prepareCorrection } from "./corrections.js";
import {
  createReviewSessionCache,
  reviewLocaleSessionKey,
  verifyReviewFreshness,
} from "./review-session.js";
import type { DocumentMapping, DocumentValue } from "./types.js";

const languages = {
  options: [
    { id: "en", title: "English" },
    { id: "es", title: "Spanish" },
  ],
  default: "en",
};
const author: DocumentValue = {
  _id: "author",
  _type: "author",
  _rev: "r1",
  name: "Writer",
  jobTitle: [
    { _key: "en", value: "English editor" },
    { _key: "es", value: "Editora" },
  ],
  description: [
    { _key: "es", value: "" },
    { _key: "en", value: "An exmple biography" },
    { _key: "ko", value: "Unused translation" },
  ],
};
const shared: DocumentMapping = {
  fields: [{ path: ["name"], role: "heading" }],
  reviewLocales: languages,
  resolve: ({ document, locale }) => ({
    fields: [
      { path: ["name"], role: "heading" },
      ...["jobTitle", "description"].map((field) => ({
        path: localizedArrayPath(document, [field], {
          locale,
          fallbackLocale: "en",
          fallbackToFirst: true,
        }),
        role: "body" as const,
      })),
    ],
  }),
};
const input = { sanityProjectId: "test", dataset: "test", readDocuments: async () => [author] };

it("inherits the article language across references and selects fallback per field", async () => {
  const page = {
    _id: "page",
    _type: "page",
    _rev: "p1",
    language: "es",
    title: "Artículo",
    author: { _ref: "author", _type: "reference" },
  };
  const snapshot = await collectSnapshot({
    ...input,
    document: page,
    mappings: {
      page: {
        fields: [{ path: ["title"], role: "heading" }],
        references: [["author"]],
        locale: ["language"],
      },
      author: shared,
    },
  });
  expect(snapshot.locale).toBe("es");
  expect(snapshot.sources.map((item) => item.text)).toEqual([
    "Artículo",
    "Writer",
    "Editora",
    "An exmple biography",
  ]);
  expect(snapshot.sources.at(-1)).toMatchObject({
    documentId: "author",
    path: ["description", { _key: "en" }, "value"],
    editable: false,
  });
});

it("keeps fallback source paths for correction and invalidates when a translation becomes available", async () => {
  const document = { ...author, _id: "drafts.author" };
  const collect = (doc: DocumentValue = document) =>
    collectSnapshot({ ...input, document: doc, mappings: { author: shared }, locale: "es" });
  const snapshot = await collect();
  const source = snapshot.sources.find((item) => item.text === "An exmple biography")!;
  const finding = {
    id: "f1",
    sourceId: source.id,
    kind: "spelling" as const,
    quote: "exmple",
    replacement: "example",
    explanation: "Typo",
    action: "replace" as const,
  };
  const patch = prepareCorrection({
    snapshot,
    current: document,
    finding,
    result: { fingerprint: snapshot.fingerprint, findings: [finding], limitations: [] },
  });
  expect(patch.set).toEqual({ 'description[_key=="en"].value': "An example biography" });
  // Even if _rev hasn't advanced, a new Spanish value changes the selected source.
  const updated = await collect({
    ...document,
    description: [
      { _key: "es", value: "Biografía" },
      { _key: "en", value: "An exmple biography" },
    ],
  });
  expect(updated.fingerprint).not.toBe(snapshot.fingerprint);
  expect(updated.sources.at(-1)?.path).toEqual(["description", { _key: "es" }, "value"]);
});

it("uses shared-document selection without overriding a page's own language", () => {
  expect(reviewLocale(author, shared)).toBe("en");
  expect(reviewLocale(author, shared, "es")).toBe("es");
  expect(reviewLocale(author, shared, "removed-language")).toBe("en");
  expect(
    reviewLocale({ ...author, language: "es" }, { ...shared, locale: ["language"] }, "en"),
  ).toBe("es");
  expect(() =>
    resolveDocumentMapping(shared, { document: author, rootDocument: author, locale: null }),
  ).toThrow(/language/);
});

it("makes first-available fallback explicit and rejects ambiguous selected keys", () => {
  const doc = { ...author, description: [{ _key: "ko", value: "Only translation" }] };
  expect(
    localizedArrayPath(doc, ["description"], {
      locale: "es",
      fallbackLocale: "en",
      fallbackToFirst: true,
    }),
  ).toEqual(["description", { _key: "ko" }, "value"]);
  expect(localizedArrayPath(doc, ["description"], { locale: "es", fallbackLocale: "en" })).toEqual([
    "description",
    { _key: "es" },
    "value",
  ]);
  expect(() =>
    localizedArrayPath(
      {
        ...doc,
        description: [
          { _key: "es", value: "One" },
          { _key: "es", value: "Two" },
        ],
      },
      ["description"],
      { locale: "es" },
    ),
  ).toThrow(/unique/);
});

it("resolves SEO fields and duplicate queries to the selected language", async () => {
  const queries: string[] = [];
  const mapping: DocumentMapping = {
    ...shared,
    resolve: ({ document, locale }) => ({
      seo: {
        title: localizedArrayPath(document, ["jobTitle"], {
          locale,
          fallbackLocale: "en",
        }),
        notApplicable: { slug: "Shared fixed route" },
      },
    }),
  };
  const evidence = await collectSeoEvidence({
    document: author,
    mapping,
    locale: "es",
    sanityProjectId: "test",
    dataset: "test",
    signal: new AbortController().signal,
    query: async (query) => {
      queries.push(query);
      return [];
    },
  });
  expect(evidence.fields.title).toEqual({
    path: ["jobTitle", { _key: "es" }, "value"],
    value: "Editora",
  });
  expect(queries[0]).toContain('jobTitle[_key=="es"].value == $value');
  const english = await collectSeoEvidence({
    document: author,
    mapping,
    locale: "en",
    sanityProjectId: "test",
    dataset: "test",
    signal: new AbortController().signal,
    query: async () => [],
  });
  expect(english.fields.title?.value).toBe("English editor");
  expect(english.fingerprint).not.toBe(evidence.fingerprint);
});

it("marks changed resolver output stale even when selected text happens to be equal", async () => {
  const document = {
    ...author,
    jobTitle: [
      { _key: "en", value: "Editor" },
      { _key: "es", value: "Editor" },
    ],
  };
  const before = await collectSnapshot({
    ...input,
    document,
    mappings: { author: shared },
    locale: "es",
  });
  const changed: DocumentMapping = {
    ...shared,
    resolve: () => ({ fields: [{ path: ["jobTitle", { _key: "en" }, "value"], role: "body" }] }),
  };
  expect(
    await verifyReviewFreshness(
      { input: before, documentStamp: "same" },
      "same",
      async () =>
        (await collectSnapshot({ ...input, document, mappings: { author: changed }, locale: "es" }))
          .fingerprint,
      new AbortController().signal,
    ),
  ).toBe("stale");
});

it("keeps language preference and results independent across cache reloads", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const cache = createReviewSessionCache(() => storage);
  const en = reviewLocaleSessionKey("author", "en");
  const es = reviewLocaleSessionKey("author", "es");
  cache.update("author", (review) => ({ ...review, preferredLocale: "es" }));
  cache.update(en, (review) => ({ ...review, section: "text" }));
  const restored = createReviewSessionCache(() => storage);
  expect(restored.get("author").review.preferredLocale).toBe("es");
  expect(restored.get(en).review.section).toBe("text");
  expect(restored.get(es).review.section).toBe("seo");
  expect(reviewLocaleSessionKey("legacy", null)).toBe("legacy");
});

describe("resolver boundary", () => {
  it("validates returned fields and cannot mutate the source document", () => {
    const mapping: DocumentMapping = {
      ...shared,
      resolve: ({ document }) => {
        document.name = "Changed";
        return { fields: [{ path: ["name"], role: "body" }] };
      },
    };
    resolveDocumentMapping(mapping, { document: author, rootDocument: author, locale: "en" });
    expect(author.name).toBe("Writer");
    expect(() =>
      resolveDocumentMapping(
        { ...shared, resolve: () => ({ fields: [{ path: ["constructor"], role: "body" }] }) },
        { document: author, rootDocument: author, locale: "en" },
      ),
    ).toThrow(/path/);
    expect(() =>
      validateMappings({ author: { ...shared, reviewLocales: { ...languages, default: "fr" } } }),
    ).toThrow(/default/);
  });
});
