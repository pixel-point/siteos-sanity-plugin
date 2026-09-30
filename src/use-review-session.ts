import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { snapshotFingerprint } from "./snapshot.js";
import {
  emptySession,
  reviewSessionCache,
  verifyReviewFreshness,
  type Freshness,
} from "./review-session.js";

export function useReviewSession(key: string | null) {
  const store = useMemo(
    () => ({
      subscribe: (listener: () => void) => reviewSessionCache.subscribe(key, listener),
      get: () => reviewSessionCache.get(key),
    }),
    [key],
  );
  return useSyncExternalStore(store.subscribe, store.get, () => emptySession);
}

/** Hash the local form too: _rev alone does not detect unsaved edits. */
export function useDocumentStamp(serialized: string) {
  const [stamp, setStamp] = useState<{ serialized: string; value: string } | null>(null);
  useEffect(() => {
    let active = true;
    void snapshotFingerprint({ serialized })
      .then((value) => {
        if (active) setStamp({ serialized, value });
      })
      .catch(() => {
        if (active) setStamp(null);
      });
    return () => {
      active = false;
    };
  }, [serialized]);
  return stamp?.serialized === serialized ? stamp.value : null;
}

export function useReviewFreshness(
  scope: string | null,
  saved: Parameters<typeof verifyReviewFreshness>[0] | null,
  documentStamp: string | null,
  collectFingerprint: (signal: AbortSignal) => Promise<string>,
) {
  const current = useRef({ saved, collectFingerprint });
  current.current = { saved, collectFingerprint };
  const identity = JSON.stringify([
    scope,
    saved?.input.fingerprint,
    saved?.documentStamp,
    documentStamp,
    saved?.invalidated,
  ]);
  const [verified, setVerified] = useState<{ identity: string; status: Freshness } | null>(null);
  useEffect(() => {
    if (!scope || !current.current.saved || !documentStamp) return;
    let controller: AbortController | null = null;
    const verify = () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const { saved: review, collectFingerprint: collect } = current.current;
      if (!review) return;
      setVerified({ identity, status: "checking" });
      void verifyReviewFreshness(review, documentStamp, collect, signal)
        .then((status) => {
          if (!signal.aborted) setVerified({ identity, status });
        })
        .catch(() => {
          /* An obsolete freshness read was cancelled. */
        });
    };
    verify();
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", verify);
    return () => {
      controller?.abort();
      window.removeEventListener("focus", verify);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [scope, identity, documentStamp]);
  if (!saved) return "none";
  if (saved.invalidated || (documentStamp && saved.documentStamp !== documentStamp)) return "stale";
  return verified?.identity === identity ? verified.status : "checking";
}
