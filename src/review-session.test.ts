import { expect, it, vi } from "vitest";
import { collectSnapshot, snapshotFingerprint } from "./snapshot.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import {
  createReviewSessionCache,
  reviewSessionKey,
  verifyReviewFreshness,
} from "./review-session.js";
import type { ReviewSession } from "./review-session.js";
import type { SeoCheckResult } from "./seo-types.js";

const identity = {
  sanityProjectId: "sanity",
  dataset: "test",
  userId: "editor",
  documentId: "drafts.page",
  documentType: "page",
  siteosOrigin: "https://app.siteos.sh",
  connection: {
    id: "installation",
    organizationId: "org",
    projectId: "project",
    environmentId: "test",
    projectName: "Project",
    environmentName: "Test",
  },
};
const key = reviewSessionKey(identity);
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
async function fixture(): Promise<ReviewSession> {
  const document = { _id: "drafts.page", _type: "page", _rev: "r1", title: "An exmple page" };
  const mapping = {
    fields: [{ path: ["title"], role: "title" as const }],
    seo: { duplicates: false },
  };
  const input = {
    document,
    sanityProjectId: "sanity",
    dataset: "test",
    signal: new AbortController().signal,
  };
  const snapshot = await collectSnapshot({
    ...input,
    mappings: { page: mapping },
    readDocuments: async () => [],
  });
  const evidence = await collectSeoEvidence({ ...input, mapping, query: async () => [] });
  const documentStamp = await snapshotFingerprint({ document, mapping });
  const checkedAt = "2026-09-30T09:00:00.000Z";
  const result: SeoCheckResult = {
    version: 2,
    fingerprint: evidence.fingerprint,
    rulesVersion: "test",
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
    ).map((id) => ({ id, title: id, status: "passed", details: [], findings: [] })),
  };
  return {
    section: "text",
    seo: {
      input: evidence,
      result,
      checkedAt,
      documentStamp,
      notApplicable: { slug: "Fixed /events route." },
    },
    text: {
      input: snapshot,
      documentStamp,
      checkedAt,
      result: {
        fingerprint: snapshot.fingerprint,
        findings: [
          {
            id: "finding",
            sourceId: snapshot.sources[0].id,
            kind: "spelling",
            quote: "exmple",
            replacement: "example",
            explanation: "Spelling",
            action: "replace",
          },
        ],
        limitations: [],
        coverage: { completed: 1, total: 2 },
        complete: false,
      },
    },
  };
}

it("restores both reviews, partial findings, timestamps and the selected tab after unmount and reload", async () => {
  const port = storage(),
    cache = createReviewSessionCache(() => port),
    review = await fixture();
  const listener = vi.fn(),
    unsubscribe = cache.subscribe(key, listener);
  cache.update(key, () => review);
  unsubscribe();
  expect(listener).toHaveBeenCalledOnce();
  expect(cache.get(key).review).toEqual(review);
  const reloaded = createReviewSessionCache(() => port);
  expect(reloaded.get(key).review).toEqual(review);
  reloaded.update(key, (saved) => ({ ...saved, section: "seo" }));
  expect(reloaded.get(key).review.text).toEqual(review.text);
});

it("isolates users, documents, Sanity datasets and SiteOS installations while retaining published-to-draft history", async () => {
  const port = storage(),
    cache = createReviewSessionCache(() => port),
    review = await fixture();
  cache.update(key, () => review);
  function different(input: Parameters<typeof reviewSessionKey>[0]) {
    expect(cache.get(reviewSessionKey(input)).review.text).toBeNull();
  }
  different({ ...identity, userId: "other" });
  different({ ...identity, sanityProjectId: "other" });
  different({ ...identity, dataset: "production" });
  different({ ...identity, documentId: "other" });
  different({ ...identity, siteosOrigin: "https://other.siteos.sh" });
  different({ ...identity, connection: { ...identity.connection, id: "new-installation" } });
  different({ ...identity, connection: { ...identity.connection, environmentId: "production" } });
  expect(reviewSessionKey({ ...identity, documentId: "page" })).toBe(key);
  expect(cache.get(key).review).toEqual(review);
});

it("discards corrupted and mismatched cached results without preventing a new check", async () => {
  const port = storage();
  port.setItem(key, "{broken");
  expect(createReviewSessionCache(() => port).get(key).review.text).toBeNull();
  const cache = createReviewSessionCache(() => port),
    review = await fixture();
  cache.update(key, () => review);
  const value = JSON.parse(port.getItem(key)!);
  value.review.text.result.fingerprint = "wrong";
  port.setItem(key, JSON.stringify(value));
  expect(createReviewSessionCache(() => port).get(key).review.text).toBeNull();
  cache.remove(key);
  expect(cache.get(key).review.text).toBeNull();
  expect(port.getItem(key)).toBeNull();
});

it("keeps the complete result in memory and reports persistence failure when browser storage is full", async () => {
  const port = storage(),
    review = await fixture(),
    cache = createReviewSessionCache(() => port);
  cache.update(key, () => review);
  port.setItem = () => {
    throw new Error("Quota exceeded");
  };
  cache.update(key, (saved) => ({ ...saved, section: "seo" }));
  expect(cache.get(key).persisted).toBe(false);
  expect(cache.get(key).review.text).toEqual(review.text);
  expect(port.getItem(key)).toBeNull();
});

it("detects local form/configuration changes and changed related evidence without executing another check", async () => {
  const saved = (await fixture()).text!,
    signal = new AbortController().signal;
  const collect = vi.fn(async () => saved.input.fingerprint);
  expect(await verifyReviewFreshness(saved, "edited-unsaved-form", collect, signal)).toBe("stale");
  expect(collect).not.toHaveBeenCalled();
  expect(await verifyReviewFreshness(saved, saved.documentStamp, collect, signal)).toBe("current");
  collect.mockResolvedValue("changed-related-document");
  expect(await verifyReviewFreshness(saved, saved.documentStamp, collect, signal)).toBe("stale");
  collect.mockRejectedValue(new Error("Offline"));
  expect(await verifyReviewFreshness(saved, saved.documentStamp, collect, signal)).toBe("unknown");
});

it("does not treat an aborted freshness read as an authoritative status", async () => {
  const saved = (await fixture()).seo!,
    controller = new AbortController();
  let resolve!: (fingerprint: string) => void;
  const collecting = new Promise<string>((done) => {
    resolve = done;
  });
  const checked = verifyReviewFreshness(
    saved,
    saved.documentStamp,
    () => collecting,
    controller.signal,
  );
  controller.abort();
  resolve(saved.input.fingerprint);
  await expect(checked).rejects.toThrow();
});
