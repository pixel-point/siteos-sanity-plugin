import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Heading,
  Spinner,
  Stack,
  Text,
  Tab,
  TabList,
  TabPanel,
} from "@sanity/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  useClient,
  useCurrentUser,
  useDataset,
  useProjectId,
  useDocumentSyncState,
  useSchema,
} from "sanity";
import { useRouter } from "sanity/router";
import { FindingCard } from "./finding-card.js";
import { fieldLabel } from "./field-label.js";
import { TextCoverage } from "./text-coverage.js";
import { textReviewCoverage } from "./text-review.js";
import { prepareCorrection, validateCheckResult } from "./corrections.js";
import { formatPath, publishedId } from "./paths.js";
import { collectSnapshot, snapshotFingerprint } from "./snapshot.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import { validateSeoResult } from "./seo-result.js";
import { SeoPanel } from "./seo-panel.js";
import { seoNotApplicable } from "./seo-report.js";
import { useSiteosConnection } from "./use-connection.js";
import { siteosOrigin } from "./connection.js";
import { reviewSessionCache, reviewSessionKey } from "./review-session.js";
import { useDocumentStamp, useReviewFreshness, useReviewSession } from "./use-review-session.js";
import type {
  Connection,
  DocumentValue,
  Finding,
  SiteosPluginOptions,
  SourceIssue,
} from "./types.js";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "The operation could not be completed. Try again.";

export function ReviewPanel({
  document,
  options,
  onNavigate,
  formViewId,
}: {
  document: DocumentValue | null;
  options: SiteosPluginOptions;
  onNavigate?(): void;
  formViewId?: string;
}) {
  const adapter = useSiteosConnection(options);
  const schema = useSchema();
  const client = useClient({ apiVersion: "2025-02-19" }).withConfig({
    useCdn: false,
    perspective: "raw",
  });
  const sanityProjectId = useProjectId();
  const dataset = useDataset();
  const user = useCurrentUser();
  const router = useRouter();
  const syncState = useDocumentSyncState(publishedId(document?._id ?? ""), document?._type ?? "");
  const latestSync = useRef(syncState);
  latestSync.current = syncState;
  const tabsId = useId();
  const [connection, setConnection] = useState<Connection | null>(() => adapter?.current() ?? null);
  const scope =
    document && user
      ? reviewSessionKey({
          sanityProjectId,
          dataset,
          userId: user.id,
          documentId: document._id,
          documentType: document._type,
          siteosOrigin: siteosOrigin(options.siteosUrl),
          connection: connection ?? {
            organizationId: "",
            projectId: "",
            environmentId: "",
            projectName: "",
            environmentName: "",
          },
        })
      : null;
  const session = useReviewSession(scope);
  const { section, text: textReview, seo: seoReview } = session.review;
  const snapshot = textReview?.input ?? null;
  const result = textReview?.result ?? null;
  const seoEvidence = seoReview?.input ?? null;
  const seoResult = seoReview?.result ?? null;
  const setSection = (section: "seo" | "text") =>
    reviewSessionCache.update(scope, (review) => ({ ...review, section }));
  const [busy, setBusy] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [visibleSources, setVisibleSources] = useState(50);
  const [visibleFindings, setVisibleFindings] = useState(50);
  const sourceById = useMemo(
    () => new Map(snapshot?.sources.map((source) => [source.id, source]) ?? []),
    [snapshot],
  );
  const sourceLabel = (source: Pick<SourceIssue, "documentId" | "documentType" | "path">) =>
    fieldLabel(
      schema.get(source.documentType),
      source.documentId === document?._id ? document : undefined,
      source.path,
    );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const latest = useRef(document);
  latest.current = document;
  const serialized = JSON.stringify({ document, mappings: options.documentTypes });
  const latestSerialized = useRef(serialized);
  latestSerialized.current = serialized;
  const documentStamp = useDocumentStamp(serialized);
  const textFreshness = useReviewFreshness(
    scope,
    textReview,
    documentStamp,
    async (signal) => (await collect(signal)).fingerprint,
  );
  const seoFreshness = useReviewFreshness(
    scope,
    seoReview,
    documentStamp,
    async (signal) => (await collectSeo(signal, true)).fingerprint,
  );
  const stale = textFreshness === "stale";
  const seoStale = seoFreshness === "stale";
  const freshness = section === "seo" ? seoFreshness : textFreshness;
  const checkedAt = (section === "seo" ? seoReview : textReview)?.checkedAt;

  useEffect(() => {
    if (!adapter?.load) return;
    const controller = new AbortController();
    setBusy("Loading shared connection");
    void adapter
      .load(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setConnection(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setConnection(null);
          setError(message(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [adapter]);

  useEffect(
    () => () => {
      operation.current?.abort();
    },
    [adapter, scope],
  );

  async function collect(signal: AbortSignal) {
    const current = latest.current;
    if (!current) throw new Error("Save a document before reviewing its content.");
    return collectSnapshot({
      document: current,
      mappings: options.documentTypes,
      schema,
      sanityProjectId,
      dataset,
      signal,
      readDocuments: async (ids, readSignal) =>
        client.fetch<DocumentValue[]>("*[_id in $ids]", { ids }, { signal: readSignal }),
    });
  }
  async function collectSeo(signal: AbortSignal, requireAvailableReads = false) {
    const current = latest.current;
    if (!current) throw new Error("Save a document before reviewing its content.");
    let unavailable = false;
    const evidence = await collectSeoEvidence({
      document: current,
      mapping: options.documentTypes[current._type],
      schema,
      sanityProjectId,
      dataset,
      signal,
      query: (query, params, querySignal, perspective) =>
        client
          .withConfig({ useCdn: false, perspective })
          .fetch(query, params, { signal: querySignal })
          .catch((error: unknown) => {
            unavailable = true;
            throw error;
          }),
    });
    if (requireAvailableReads && unavailable)
      throw new Error("Current SEO evidence is unavailable.");
    return evidence;
  }
  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(null);
      }
    }
  }
  const navigate = (
    documentId: string,
    documentType: string,
    path: Parameters<typeof formatPath>[0],
  ) => {
    router.navigateIntent("edit", {
      id: publishedId(documentId),
      type: documentType,
      path: formatPath(path),
      ...(formViewId && publishedId(documentId) === publishedId(latest.current?._id ?? "")
        ? { view: formViewId }
        : {}),
    });
    onNavigate?.();
  };
  const prepare = () =>
    run("Preparing content", async (signal) => {
      const before = latestSerialized.current;
      const next = await collect(signal);
      const stamp = await snapshotFingerprint({ serialized: before });
      signal.throwIfAborted();
      if (before !== latestSerialized.current)
        throw new Error("The document changed while preparing. Try again.");
      reviewSessionCache.update(scope, (review) => ({
        ...review,
        text: {
          input: next,
          result: null,
          documentStamp: stamp,
          checkedAt: null,
        },
      }));
      setPreviewOpen(true);
    });
  const check = () =>
    run("Checking content", async (signal) => {
      if (!connection || !adapter) return;
      const before = latestSerialized.current;
      const fresh = await collect(signal);
      const stamp = await snapshotFingerprint({ serialized: before });
      signal.throwIfAborted();
      if (before !== latestSerialized.current)
        throw new Error("The document changed while preparing. Try again.");
      setVisibleSources(50);
      setVisibleFindings(50);
      const checked = validateCheckResult(
        await adapter.check({
          connection,
          snapshot: fresh,
          signal,
          onProgress: ({ completed, total, result }) => {
            if (signal.aborted) return;
            setBusy(`Checking content: ${completed} of ${total} parts complete`);
            reviewSessionCache.update(scope, (review) => ({
              ...review,
              text: {
                input: fresh,
                result: validateCheckResult(result, fresh),
                documentStamp: stamp,
                checkedAt: new Date().toISOString(),
              },
            }));
          },
        }),
        fresh,
      );
      signal.throwIfAborted();
      reviewSessionCache.update(scope, (review) => ({
        ...review,
        text: {
          input: fresh,
          result: checked,
          documentStamp: stamp,
          checkedAt: new Date().toISOString(),
        },
      }));
    });
  const checkSeo = () =>
    run("Checking SEO", async (signal) => {
      if (!connection || !adapter?.checkSeo || !latest.current)
        throw new Error("SEO checks are not available in this connection adapter.");
      const before = latestSerialized.current;
      const notApplicable = seoNotApplicable(options.documentTypes[latest.current._type]?.seo);
      const evidence = await collectSeo(signal);
      const stamp = await snapshotFingerprint({ serialized: before });
      signal.throwIfAborted();
      if (before !== latestSerialized.current)
        throw new Error("The document changed while preparing SEO evidence. Try again.");
      const checked = validateSeoResult(
        await adapter.checkSeo({ connection, evidence, signal }),
        evidence,
      );
      signal.throwIfAborted();
      reviewSessionCache.update(scope, (review) => ({
        ...review,
        seo: {
          input: evidence,
          notApplicable,
          result: checked,
          documentStamp: stamp,
          checkedAt: new Date().toISOString(),
        },
      }));
    });
  const apply = (finding: Finding) =>
    run("Applying correction", async (signal) => {
      if (!snapshot || !result || !latest.current) return;
      if (latestSync.current !== "synced")
        throw new Error(
          "Wait for Sanity to finish saving this draft before applying a correction.",
        );
      const fresh = await collect(signal);
      if (fresh.fingerprint !== snapshot.fingerprint)
        throw new Error("The document or related content changed. Run a new check.");
      const patch = prepareCorrection({ snapshot, result, finding, current: latest.current });
      // Server-side compare-and-swap protects edits arriving after the local freshness check.
      const persisted = await client.getDocument<DocumentValue>(patch.documentId);
      signal.throwIfAborted();
      if (!persisted) throw new Error("The draft is no longer available.");
      prepareCorrection({ snapshot, result, finding, current: persisted });
      if (latestSync.current !== "synced" || !latest.current)
        throw new Error("The draft is still saving. Try again when it is synced.");
      prepareCorrection({ snapshot, result, finding, current: latest.current });
      await client.patch(patch.documentId).ifRevisionId(patch.revision).set(patch.set).commit();
      signal.throwIfAborted();
      reviewSessionCache.update(scope, (review) => ({
        ...review,
        text: review.text && { ...review.text, invalidated: true },
        seo: review.seo && { ...review.seo, invalidated: true },
      }));
      setNotice("Correction applied to this draft. Check again to review the updated content.");
    });

  return (
    <Box padding={[3, 4]}>
      <Stack gap={5}>
        <Stack gap={4}>
          <Flex align="center" justify="space-between" gap={3} wrap="wrap">
            <Stack gap={3}>
              <Heading size={2}>Content &amp; SEO</Heading>
              <Text size={1} muted>
                {section === "text"
                  ? "Review spelling, grammar and content consistency before publishing."
                  : "Check the SEO fields and structure of this document before publishing."}
              </Text>
            </Stack>
            {adapter && (
              <Button
                text={
                  section === "seo"
                    ? seoResult
                      ? "Check SEO again"
                      : "Check SEO"
                    : result || stale
                      ? "Check again"
                      : "Check text"
                }
                tone="primary"
                disabled={
                  !!busy || !connection || !document || (section === "seo" && !adapter.checkSeo)
                }
                onClick={section === "seo" ? checkSeo : check}
              />
            )}
          </Flex>
          {connection ? (
            <Flex gap={3} align="center" justify="space-between" wrap="wrap">
              <Flex gap={2} align="center" wrap="wrap">
                <Badge tone="positive" fontSize={0}>
                  Connected
                </Badge>
                <Text size={1} muted>
                  {connection.projectName} · {connection.environmentName}
                </Text>
              </Flex>
              {adapter?.manageUrl ? (
                <Button
                  as="a"
                  href={adapter.manageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  text="Manage connection"
                  mode="bleed"
                  fontSize={1}
                />
              ) : (
                <Button
                  text="Disconnect"
                  mode="bleed"
                  fontSize={1}
                  disabled={!!busy}
                  onClick={() => {
                    adapter?.disconnect();
                    reviewSessionCache.remove(scope);
                    setConnection(null);
                  }}
                />
              )}
            </Flex>
          ) : adapter ? (
            <Card border padding={4} radius={3}>
              <Stack gap={4}>
                <Text size={1}>
                  Connect this Studio to your team's SiteOS project to start checking content.
                </Text>
                <Flex>
                  <Button
                    text="Connect SiteOS"
                    disabled={!!busy}
                    onClick={() =>
                      run("Connecting", async (signal) => {
                        const connected = await adapter.connect(signal);
                        signal.throwIfAborted();
                        setConnection(connected);
                      })
                    }
                  />
                </Flex>
              </Stack>
            </Card>
          ) : (
            <Card padding={3} tone="caution" radius={2}>
              <Text size={1}>
                Open this review in Sanity Studio to connect SiteOS. Previewing content keeps it in
                your Studio.
              </Text>
            </Card>
          )}
        </Stack>
        <TabList gap={2} aria-label="Review type">
          <Tab
            id={`${tabsId}-seo`}
            aria-controls={`${tabsId}-seo-panel`}
            label="SEO"
            selected={section === "seo"}
            disabled={!!busy}
            onClick={() => {
              setSection("seo");
              setError(null);
              setNotice(null);
            }}
          />
          <Tab
            id={`${tabsId}-text`}
            aria-controls={`${tabsId}-text-panel`}
            label="Text"
            selected={section === "text"}
            disabled={!!busy}
            onClick={() => {
              setSection("text");
              setError(null);
              setNotice(null);
            }}
          />
        </TabList>
        {busy && (
          <Flex align="center" gap={3} role="status" aria-live="polite">
            <Spinner />
            <Text size={1}>{busy}…</Text>
            {operation.current && (
              <Button
                text="Cancel"
                mode="ghost"
                onClick={() => {
                  operation.current?.abort();
                  setBusy(null);
                  setNotice(
                    "Check stopped. Completed results remain visible; run the check again to finish.",
                  );
                }}
              />
            )}
          </Flex>
        )}
        {error && (
          <Card tone="critical" padding={4} radius={2} role="alert">
            <Text size={1}>{error}</Text>
          </Card>
        )}
        {notice && (
          <Card tone="positive" padding={4} radius={2} role="status">
            <Text size={1}>{notice}</Text>
          </Card>
        )}
        {checkedAt && (
          <Text size={1} muted>
            Last checked: <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time>
          </Text>
        )}
        {freshness === "checking" && (
          <Text size={1} muted>
            Checking for content changes…
          </Text>
        )}
        {freshness === "unknown" && (
          <Card tone="caution" padding={4} radius={2} role="status">
            <Text size={1}>
              The previous result is shown. Current content could not be verified; run a new check
              before using corrections.
            </Text>
          </Card>
        )}
        {((stale && section === "text") || (seoStale && section === "seo")) && (
          <Card tone="caution" padding={4} radius={2} role="status">
            <Text size={1}>
              Content changed since this check. The previous result is shown below. Run a new check
              to review the current document and related content.
            </Text>
          </Card>
        )}
        {!session.persisted && (result || seoResult) && (
          <Text size={1} muted>
            This browser could not save the result for a page reload. It remains available while
            Studio stays open.
          </Text>
        )}
        <TabPanel
          id={`${tabsId}-seo-panel`}
          aria-labelledby={`${tabsId}-seo`}
          hidden={section !== "seo"}
        >
          <SeoPanel
            result={seoResult}
            evidence={seoEvidence}
            notApplicable={seoReview?.notApplicable}
            onNavigate={navigate}
          />
        </TabPanel>
        <TabPanel
          id={`${tabsId}-text-panel`}
          aria-labelledby={`${tabsId}-text`}
          hidden={section !== "text"}
        >
          <Stack gap={4}>
            {!snapshot && !busy && (
              <Card border padding={4} radius={3}>
                <Stack gap={4}>
                  <Text size={1} muted>
                    Run a check to see suggested corrections here. You can also preview the selected
                    fields and related content first.
                  </Text>
                  <Flex>
                    <Button
                      text="Preview content"
                      mode="ghost"
                      disabled={!document}
                      onClick={prepare}
                    />
                  </Flex>
                </Stack>
              </Card>
            )}
            {snapshot && (
              <Stack gap={4}>
                <Flex gap={3} align="center" wrap="wrap">
                  <Badge fontSize={0}>
                    {snapshot.perspective === "drafts" ? "Draft content" : "Published content"}
                  </Badge>
                  <Text size={1} muted>
                    {snapshot.sources.length} text sections · {snapshot.documents.length}{" "}
                    {snapshot.documents.length === 1 ? "document" : "documents"}
                  </Text>
                </Flex>
                <TextCoverage
                  snapshot={snapshot}
                  result={result}
                  label={sourceLabel}
                  onOpen={(issue) => navigate(issue.documentId, issue.documentType, issue.path)}
                />
                {result && (
                  <Stack gap={4}>
                    <Flex gap={3} align="center">
                      <Heading size={1}>
                        {result.findings.length
                          ? "Suggested corrections"
                          : textReviewCoverage(snapshot, result).emptyMessage}
                      </Heading>
                      {!!result.findings.length && (
                        <Badge tone="caution">{result.findings.length}</Badge>
                      )}
                    </Flex>
                    {result.findings.slice(0, visibleFindings).map((finding) => {
                      const source = sourceById.get(finding.sourceId)!;
                      return (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          source={source}
                          label={sourceLabel(source)}
                          related={source.documentId !== snapshot.documentId}
                          disabled={!!busy || textFreshness !== "current" || syncState !== "synced"}
                          onOpen={() =>
                            navigate(source.documentId, source.documentType, source.path)
                          }
                          onApply={() => apply(finding)}
                        />
                      );
                    })}
                    {result.findings.length > visibleFindings && (
                      <Button
                        text={`Show more corrections (${result.findings.length - visibleFindings} remaining)`}
                        mode="ghost"
                        onClick={() => setVisibleFindings((count) => count + 50)}
                      />
                    )}
                  </Stack>
                )}
                <Card border radius={3}>
                  <details
                    open={previewOpen}
                    onToggle={(event) => setPreviewOpen(event.currentTarget.open)}
                  >
                    <Box
                      as="summary"
                      padding={4}
                      style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span aria-hidden="true">{previewOpen ? "▾" : "▸"}</span>
                      <Text as="span" size={1} weight="semibold">
                        Content included in this check
                      </Text>
                    </Box>
                    {previewOpen && (
                      <Stack paddingX={4} paddingBottom={4} gap={4}>
                        <Text size={1} muted>
                          These are the selected text sections for review. Large documents are sent
                          to SiteOS in parts when you run a check . Related content is included for
                          context.
                        </Text>
                        {snapshot.sources.slice(0, visibleSources).map((source, index) => (
                          <Card
                            key={source.id}
                            borderTop={index > 0}
                            paddingTop={index > 0 ? 4 : 0}
                          >
                            <Stack gap={3}>
                              <Flex align="center" justify="space-between" wrap="wrap" gap={3}>
                                <Flex align="center" wrap="wrap" gap={2}>
                                  <Text size={1} weight="semibold">
                                    {sourceLabel(source)}
                                  </Text>
                                  {source.documentId !== snapshot.documentId && (
                                    <Badge fontSize={0}>Related document</Badge>
                                  )}
                                </Flex>
                                <Button
                                  text="Open field"
                                  mode="bleed"
                                  fontSize={1}
                                  onClick={() =>
                                    navigate(source.documentId, source.documentType, source.path)
                                  }
                                />
                              </Flex>
                              <Text
                                size={1}
                                muted
                                style={{
                                  whiteSpace: "pre-wrap",
                                  overflowWrap: "anywhere",
                                  lineHeight: 1.6,
                                }}
                              >
                                {source.text}
                              </Text>
                            </Stack>
                          </Card>
                        ))}
                        {snapshot.sources.length > visibleSources && (
                          <Button
                            text={`Show more content (${snapshot.sources.length - visibleSources} remaining)`}
                            mode="ghost"
                            onClick={() => setVisibleSources((count) => count + 50)}
                          />
                        )}
                        {stale && !result && (
                          <Flex>
                            <Button
                              text="Refresh preview"
                              mode="ghost"
                              disabled={!!busy || !document}
                              onClick={prepare}
                            />
                          </Flex>
                        )}
                      </Stack>
                    )}
                  </details>
                </Card>
                <Text size={0} muted style={{ lineHeight: 1.6 }}>
                  Checks selected CMS content. Website rendering, indexing and HTTP metadata require
                  a website audit.
                </Text>
              </Stack>
            )}
          </Stack>
        </TabPanel>
      </Stack>
    </Box>
  );
}
