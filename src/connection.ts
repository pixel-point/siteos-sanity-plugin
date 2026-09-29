import type { Connection, SiteosConnectionAdapter, CheckResult } from "./types.js";
import type { SeoCheckResult } from "./seo-types.js";
export type StoredConnection = { token: string; connection: Connection; siteosOrigin: string };
export type ConnectionStore = {
  read(signal: AbortSignal): Promise<StoredConnection | null>;
  write(value: StoredConnection, signal: AbortSignal): Promise<void>;
};
export function siteosOrigin(value = "https://app.siteos.sh") {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("SiteOS URL must be an HTTPS origin, or localhost for development.");
  return url.origin;
}
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function secretDocumentId(apiOrigin: string, studioOrigin: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${apiOrigin}\n${studioOrigin}`),
  );
  return `secrets.siteos.${[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
async function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** The SiteOS cookie stays on its origin. Only a dataset-scoped installation credential is shared. */
export function createHostedConnection(input: {
  siteosUrl?: string;
  sanityProjectId: string;
  dataset: string;
  studioOrigin: string;
  store: ConnectionStore;
  fetch?: typeof fetch;
  open?: () => Window | null;
}): SiteosConnectionAdapter {
  const origin = siteosOrigin(input.siteosUrl),
    fetcher = input.fetch ?? globalThis.fetch;
  let stored: StoredConnection | null = null;
  function validate(value: StoredConnection) {
    if (
      value.siteosOrigin !== origin ||
      !/^sos_studio_[A-Za-z0-9_-]{43}$/.test(value.token) ||
      !value.connection?.id
    )
      throw new Error("The saved SiteOS connection is invalid. Connect again.");
  }
  async function api<T>(path: string, signal: AbortSignal, value?: unknown, token?: string) {
    const response = await fetcher(`${origin}/api/studio/v1${path}`, {
      method: value === undefined ? "GET" : "POST",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        ...(value === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error?.message ?? "SiteOS could not complete this request.");
    return result as T;
  }
  return {
    manageUrl: `${origin}/connect/sanity`,
    current: () => stored?.connection ?? null,
    async load(signal) {
      const value = await input.store.read(signal);
      if (!value) {
        stored = null;
        return null;
      }
      validate(value);
      const result = await api<{ connection: Connection }>(
        "/connection",
        signal,
        undefined,
        value.token,
      );
      signal.throwIfAborted();
      stored = { ...value, connection: result.connection };
      return result.connection;
    },
    async connect(signal) {
      const popup = (
        input.open ?? (() => window.open("about:blank", "_blank", "popup,width=820,height=900"))
      )();
      if (!popup) throw new Error("Allow pop-ups to connect SiteOS.");
      popup.opener = null;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
      try {
        const id = crypto.randomUUID(),
          verifier = base64(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
        );
        const url = new URL("/connect/sanity", origin);
        url.search = new URLSearchParams({
          id,
          challenge,
          origin: input.studioOrigin,
          sanityProjectId: input.sanityProjectId,
          dataset: input.dataset,
        }).toString();
        popup.location.href = url.toString();
        for (;;) {
          await wait(bounded, 1500);
          const response = await api<{
            state?: "pending";
            token?: string;
            connection?: Connection;
          }>("/exchange", bounded, { id, verifier });
          if (response.state === "pending") continue;
          if (!response.token || !response.connection)
            throw new Error("SiteOS returned an invalid connection.");
          const value = {
            siteosOrigin: origin,
            token: response.token,
            connection: response.connection,
          };
          validate(value);
          await input.store.write(value, bounded);
          bounded.throwIfAborted();
          stored = value;
          return value.connection;
        }
      } finally {
        popup.close();
      }
    },
    disconnect() {
      stored = null;
    },
    async checkSeo({ connection, evidence, signal }) {
      const value = await input.store.read(signal);
      if (
        !value ||
        value.siteosOrigin !== origin ||
        !connection.id ||
        value.connection?.id !== connection.id
      )
        throw new Error("The shared connection changed. Close and reopen this review.");
      validate(value);
      return api<SeoCheckResult>(
        "/seo-checks",
        AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        evidence,
        value.token,
      );
    },
    async check({ connection, snapshot, signal }) {
      const value = await input.store.read(signal);
      if (
        !value ||
        value.siteosOrigin !== origin ||
        !connection.id ||
        value.connection?.id !== connection.id
      )
        throw new Error("The shared connection changed. Close and reopen this review.");
      validate(value);
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(1200000)]);
      const job = await api<{ id: string }>("/checks", bounded, snapshot, value.token);
      let first = true;
      for (;;) {
        const state = await api<{
          state: string;
          result: CheckResult | null;
          reason: string | null;
        }>(`/checks/${encodeURIComponent(job.id)}`, bounded, undefined, value.token);
        if (state.result) return state.result;
        if (state.state === "paused") {
          if (first) {
            await api(`/checks/${encodeURIComponent(job.id)}/continue`, bounded, {}, value.token);
            first = false;
            await wait(bounded, 1500);
            continue;
          }
          throw new Error(
            "This check is paused. Check your organization’s SEO credits, then select Check with SiteOS to continue.",
          );
        }
        first = false;
        await wait(bounded, 1500);
      }
    },
  };
}
