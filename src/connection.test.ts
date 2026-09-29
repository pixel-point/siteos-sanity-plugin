import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createHostedConnection,
  secretDocumentId,
  siteosOrigin,
  type StoredConnection,
} from "./connection.js";
import type { ContentSnapshot } from "./types.js";
import type { SeoEvidence } from "./seo-types.js";
const connection = {
  id: "studio-installation",
  organizationId: "org",
  projectId: "project",
  environmentId: "staging",
  projectName: "Website",
  environmentName: "Staging",
};
const value: StoredConnection = {
  siteosOrigin: "https://siteos.example.test",
  token: `sos_studio_${"x".repeat(43)}`,
  connection,
};
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
describe("shared Studio connection transport", () => {
  it("sends an explicit SEO check to its own endpoint without launching or polling an AI job", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        version: 1,
        fingerprint: "evidence",
        rulesVersion: "cms-seo-v1",
        sections: ["metadata", "headings", "images", "links", "slug", "duplicates"].map((id) => ({
          id,
          title: id,
          status: "not-configured",
          details: [],
          findings: [],
        })),
      }),
    );
    let current = value;
    const adapter = createHostedConnection({
      siteosUrl: value.siteosOrigin,
      sanityProjectId: "abc123",
      dataset: "production",
      studioOrigin: "https://studio.example.test",
      fetch: fetcher,
      store: { read: async () => current, write: vi.fn() },
    });
    const evidence = { version: 1, fingerprint: "evidence" } as SeoEvidence;
    await adapter.checkSeo!({ connection, evidence, signal: signal() });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      `${value.siteosOrigin}/api/studio/v1/seo-checks`,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        body: JSON.stringify(evidence),
      }),
    );
    current = { ...value, connection: { ...connection, id: "replaced" } };
    await expect(adapter.checkSeo!({ connection, evidence, signal: signal() })).rejects.toThrow(
      "changed",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("restores the team's connection without opening a SiteOS sign-in and never includes browser cookies", async () => {
    const fetcher = vi.fn(async () => Response.json({ connection }));
    const open = vi.fn();
    const adapter = createHostedConnection({
      siteosUrl: value.siteosOrigin,
      sanityProjectId: "abc123",
      dataset: "production",
      studioOrigin: "https://studio.example.test",
      fetch: fetcher,
      open,
      store: { read: async () => value, write: vi.fn() },
    });
    expect(await adapter.load!(signal())).toEqual(connection);
    expect(open).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      `${value.siteosOrigin}/api/studio/v1/connection`,
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        headers: { Authorization: `Bearer ${value.token}` },
      }),
    );
    expect(adapter.current()).toEqual(connection);
  });
  it("keeps the verifier and credential out of the popup URL, and saves only after the proof exchange succeeds", async () => {
    vi.useFakeTimers();
    const popup = { opener: {}, location: { href: "" }, close: vi.fn() };
    const write = vi.fn(async () => undefined);
    let proof: string | undefined;
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      proof = JSON.parse(String(init?.body)).verifier;
      return Response.json({ connection, token: value.token });
    });
    const adapter = createHostedConnection({
      siteosUrl: value.siteosOrigin,
      sanityProjectId: "abc123",
      dataset: "production",
      studioOrigin: "https://studio.example.test",
      fetch: fetcher,
      open: () => popup as unknown as Window,
      store: { read: async () => null, write },
    });
    const pending = adapter.connect(signal());
    await vi.waitFor(() => expect(popup.location.href).toContain("/connect/sanity?"));
    expect(write).not.toHaveBeenCalled();
    expect(popup.opener).toBeNull();
    const query = new URL(popup.location.href).searchParams;
    expect([...query.keys()]).toEqual(["id", "challenge", "origin", "sanityProjectId", "dataset"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual(connection);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(proof)),
    );
    expect(query.get("challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(popup.location.href).not.toContain(proof!);
    expect(popup.location.href).not.toContain(value.token);
    expect(write).toHaveBeenCalledWith(value, expect.any(AbortSignal));
    expect(popup.close).toHaveBeenCalledOnce();
  });
  it("refuses to launch under a connection replaced by another editor", async () => {
    const fetcher = vi.fn();
    const adapter = createHostedConnection({
      siteosUrl: value.siteosOrigin,
      sanityProjectId: "abc123",
      dataset: "production",
      studioOrigin: "https://studio.example.test",
      fetch: fetcher,
      store: {
        read: async () => ({ ...value, connection: { ...connection, id: "replacement" } }),
        write: vi.fn(),
      },
    });
    await expect(
      adapter.check({ connection, snapshot: {} as ContentSnapshot, signal: signal() }),
    ).rejects.toThrow("shared connection changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("separates production, staging and Studio origins and rejects credential-bearing or remote HTTP origins", async () => {
    const prod = await secretDocumentId(value.siteosOrigin, "https://studio.example.test");
    expect(prod).toMatch(/^secrets\.siteos\.[a-f0-9]{64}$/);
    expect(
      await secretDocumentId("https://staging.example.test", "https://studio.example.test"),
    ).not.toBe(prod);
    expect(await secretDocumentId(value.siteosOrigin, "http://localhost:3333")).not.toBe(prod);
    for (const invalid of [
      "http://remote.test",
      "https://user:secret@example.test",
      "https://example.test/path",
    ])
      expect(() => siteosOrigin(invalid)).toThrow();
    expect(siteosOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
});
