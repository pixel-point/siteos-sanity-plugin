import { validateCheckResult } from "./corrections.js";
import { publishedId } from "./paths.js";
import { validateSeoResult } from "./seo-result.js";
import type { CheckResult, Connection, ContentSnapshot } from "./types.js";
import type { SeoCheckResult, SeoEvidence, SeoNotApplicable } from "./seo-types.js";
import { validateSeoNotApplicable } from "./seo-report.js";

export type SavedReview<T, R> = {
  input: T;
  result: R | null;
  documentStamp: string;
  checkedAt: string | null;
  invalidated?: boolean;
};
export type ReviewSession = {
  section: "seo" | "text";
  text: SavedReview<ContentSnapshot, CheckResult> | null;
  seo: (SavedReview<SeoEvidence, SeoCheckResult> & { notApplicable?: SeoNotApplicable }) | null;
};
export type SessionState = { review: ReviewSession; persisted: boolean };
export const emptySession: SessionState = {
  review: { section: "seo", text: null, seo: null },
  persisted: true,
};

/** Neither the installation token nor a SiteOS/Sanity browser credential is part of this key. */
export function reviewSessionKey(input: {
  sanityProjectId: string;
  dataset: string;
  userId: string;
  documentId: string;
  documentType: string;
  siteosOrigin: string;
  connection: Connection;
}) {
  return `siteos.sanity.review.v1:${JSON.stringify([
    input.sanityProjectId,
    input.dataset,
    input.userId,
    publishedId(input.documentId),
    input.documentType,
    input.siteosOrigin,
    input.connection.id ?? null,
    input.connection.organizationId,
    input.connection.projectId,
    input.connection.environmentId,
  ])}`;
}

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function readSaved(value: string, key: string): ReviewSession {
  const envelope = JSON.parse(value);
  if (envelope.version !== 1 || envelope.key !== key) throw new Error("Invalid saved review.");
  const review = envelope.review as ReviewSession;
  if (!review || !["seo", "text"].includes(review.section))
    throw new Error("Invalid saved review.");
  for (const saved of [review.text, review.seo]) {
    if (saved === null) continue;
    if (
      !saved?.input ||
      typeof saved.input.fingerprint !== "string" ||
      typeof saved.documentStamp !== "string" ||
      (saved.checkedAt !== null && !Number.isFinite(Date.parse(saved.checkedAt))) ||
      (saved.invalidated !== undefined && typeof saved.invalidated !== "boolean")
    )
      throw new Error("Invalid saved review.");
  }
  if (review.text) {
    const snapshot = review.text.input;
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.documents) ||
      !Array.isArray(snapshot.issues) ||
      !Array.isArray(snapshot.sources) ||
      snapshot.sources.some(
        (source) => typeof source.text !== "string" || !Array.isArray(source.path),
      )
    )
      throw new Error("Invalid saved snapshot.");
    if (review.text.result) validateCheckResult(review.text.result, snapshot);
  }
  if (review.seo) {
    validateSeoNotApplicable(review.seo.notApplicable);
    if (review.seo.result) validateSeoResult(review.seo.result, review.seo.input);
  }
  return review;
}

/** A tab-scoped cache survives React unmounts and, where available, page reloads. */
export function createReviewSessionCache(storage: () => StoragePort | undefined) {
  const records = new Map<string, SessionState>();
  const listeners = new Map<string, Set<() => void>>();
  const get = (key: string | null): SessionState => {
    if (!key) return emptySession;
    const cached = records.get(key);
    if (cached) return cached;
    let next = emptySession;
    try {
      const serialized = storage()?.getItem(key);
      if (serialized) next = { review: readSaved(serialized, key), persisted: true };
    } catch {
      // Invalid or unavailable browser storage must never prevent opening the document.
    }
    records.set(key, next);
    return next;
  };
  return {
    get,
    subscribe(key: string | null, listener: () => void) {
      if (!key) return () => undefined;
      const subscriptions = listeners.get(key) ?? new Set();
      subscriptions.add(listener);
      listeners.set(key, subscriptions);
      return () => {
        subscriptions.delete(listener);
        if (!subscriptions.size) listeners.delete(key);
      };
    },
    update(key: string | null, update: (review: ReviewSession) => ReviewSession) {
      if (!key) return;
      const review = update(get(key).review);
      let persisted = false;
      try {
        const target = storage();
        target?.setItem(key, JSON.stringify({ version: 1, key, review }));
        persisted = !!target;
      } catch {
        // Keep complete results in memory even when storage is disabled or its quota is full.
        try {
          storage()?.removeItem(key);
        } catch {
          /* Storage may itself be unavailable. */
        }
      }
      records.set(key, { review, persisted });
      listeners.get(key)?.forEach((listener) => listener());
    },
    remove(key: string | null) {
      if (!key) return;
      records.set(key, emptySession);
      try {
        storage()?.removeItem(key);
      } catch {
        /* Keep disconnect available. */
      }
      listeners.get(key)?.forEach((listener) => listener());
    },
  };
}

export const reviewSessionCache = createReviewSessionCache(() =>
  typeof window === "undefined" ? undefined : window.sessionStorage,
);

export type Freshness = "none" | "checking" | "current" | "stale" | "unknown";

export async function verifyReviewFreshness(
  saved: { input: { fingerprint: string }; documentStamp: string; invalidated?: boolean },
  documentStamp: string,
  collectFingerprint: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<Freshness> {
  if (saved.invalidated || saved.documentStamp !== documentStamp) return "stale";
  try {
    const fingerprint = await collectFingerprint(signal);
    signal.throwIfAborted();
    return fingerprint === saved.input.fingerprint ? "current" : "stale";
  } catch (error) {
    if (signal.aborted) throw error;
    return "unknown";
  }
}
