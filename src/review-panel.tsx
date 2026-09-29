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
import { useClient, useDataset, useProjectId, useDocumentSyncState, useSchema } from "sanity";
import { useRouter } from "sanity/router";
import { FindingCard, sourceLabel } from "./finding-card.js";
import { prepareCorrection, validateCheckResult } from "./corrections.js";
import { formatPath, publishedId } from "./paths.js";
import { collectSnapshot } from "./snapshot.js";
import { collectSeoEvidence } from "./seo-snapshot.js";
import { validateSeoResult } from "./seo-result.js";
import { SeoPanel } from "./seo-panel.js";
import type { SeoEvidence, SeoCheckResult } from "./seo-types.js";
import { useSiteosConnection } from "./use-connection.js";
import type {
  CheckResult,
  Connection,
  ContentSnapshot,
  DocumentValue,
  Finding,
  SiteosPluginOptions,
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
  const router = useRouter();
  const syncState = useDocumentSyncState(publishedId(document?._id ?? ""), document?._type ?? "");
  const latestSync = useRef(syncState);
  latestSync.current = syncState;
  const tabsId = useId();
  const [section, setSection] = useState<"text" | "seo">("seo");
  const [seoEvidence, setSeoEvidence] = useState<SeoEvidence | null>(null);
  const [seoResult, setSeoResult] = useState<SeoCheckResult | null>(null);
  const seoReviewedDocument = useRef<string | null>(null);
  const seoStale = !!seoEvidence && JSON.stringify(document) !== seoReviewedDocument.current;
  const [snapshot, setSnapshot] = useState<ContentSnapshot | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [connection, setConnection] = useState<Connection | null>(() => adapter?.current() ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [visibleSources, setVisibleSources] = useState(50);
  const [visibleFindings, setVisibleFindings] = useState(50);
  const sourceById = useMemo(
    () => new Map(snapshot?.sources.map((source) => [source.id, source]) ?? []),
    [snapshot],
  );
  const issueGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof snapshot>["issues"]>();
    for (const issue of snapshot?.issues ?? [])
      groups.set(issue.message, [...(groups.get(issue.message) ?? []), issue]);
    return [...groups.entries()];
  }, [snapshot]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const latest = useRef(document);
  latest.current = document;
  const reviewedDocument = useRef<string | null>(null);
  const stale = !!snapshot && JSON.stringify(document) !== reviewedDocument.current;

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
    [adapter],
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
      if (!controller.signal.aborted) setBusy(null);
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
      const before = JSON.stringify(latest.current);
      const next = await collect(signal);
      signal.throwIfAborted();
      if (before !== JSON.stringify(latest.current))
        throw new Error("The document changed while preparing. Try again.");
      reviewedDocument.current = before;
      setSnapshot(next);
      setResult(null);
      setPreviewOpen(true);
    });
  const check = () =>
    run("Checking content", async (signal) => {
      if (!connection || !adapter) return;
      const before = JSON.stringify(latest.current);
      const fresh = await collect(signal);
      signal.throwIfAborted();
      if (before !== JSON.stringify(latest.current))
        throw new Error("The document changed while preparing. Try again.");
      reviewedDocument.current = before;
      setSnapshot(fresh);
      setVisibleSources(50);
      setVisibleFindings(50);
      setResult(null);
      const checked = validateCheckResult(
        await adapter.check({
          connection,
          snapshot: fresh,
          signal,
          onProgress: ({ completed, total, result }) => {
            if (signal.aborted) return;
            setBusy(`Checking content: ${completed} of ${total} parts complete`);
            setResult(result);
          },
        }),
        fresh,
      );
      signal.throwIfAborted();
      setResult(checked);
    });
  const checkSeo = () =>
    run("Checking SEO", async (signal) => {
      if (!connection || !adapter?.checkSeo || !latest.current)
        throw new Error("SEO checks are not available in this connection adapter.");
      const before = JSON.stringify(latest.current);
      const evidence = await collectSeoEvidence({
        document: latest.current,
        mapping: options.documentTypes[latest.current._type],
        schema,
        sanityProjectId,
        dataset,
        signal,
        query: (query, params, querySignal, perspective) =>
          client
            .withConfig({ useCdn: false, perspective })
            .fetch(query, params, { signal: querySignal }),
      });
      signal.throwIfAborted();
      if (before !== JSON.stringify(latest.current))
        throw new Error("The document changed while preparing SEO evidence. Try again.");
      seoReviewedDocument.current = before;
      setSeoEvidence(evidence);
      setSeoResult(null);
      const checked = validateSeoResult(
        await adapter.checkSeo({ connection, evidence, signal }),
        evidence,
      );
      signal.throwIfAborted();
      setSeoResult(checked);
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
      setSnapshot(null);
      setResult(null);
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
                  section === "seo" ? "Check SEO" : result || stale ? "Check again" : "Check text"
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
                    setConnection(null);
                    setResult(null);
                    setSeoResult(null);
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
        {(section === "text" ? stale : seoStale) && (
          <Card tone="caution" padding={4} radius={2} role="status">
            <Text size={1}>
              This document changed. Run a new check to review its current content.
            </Text>
          </Card>
        )}
        <TabPanel
          id={`${tabsId}-seo-panel`}
          aria-labelledby={`${tabsId}-seo`}
          hidden={section !== "seo"}
        >
          <SeoPanel result={seoResult} evidence={seoEvidence} onNavigate={navigate} />
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
                {issueGroups.map(([message, issues]) => (
                  <Card key={message} padding={4} radius={2} tone="caution">
                    <Stack gap={3}>
                      <Text size={1}>
                        {message} {issues.length > 1 ? `(${issues.length} fields)` : ""}
                      </Text>
                      <details>
                        <summary>Show affected fields</summary>
                        <Stack gap={2} paddingTop={3}>
                          {issues.map((issue, index) => (
                            <Button
                              key={index}
                              mode="ghost"
                              text={`Open ${formatPath(issue.path)}`}
                              onClick={() =>
                                navigate(issue.documentId, issue.documentType, issue.path)
                              }
                            />
                          ))}
                        </Stack>
                      </details>
                    </Stack>
                  </Card>
                ))}
                {result && (
                  <Stack gap={4}>
                    <Flex gap={3} align="center">
                      <Heading size={1}>
                        {result.coverage && result.coverage.completed < result.coverage.total
                          ? `Partial results: ${result.coverage.completed} of ${result.coverage.total} parts`
                          : result.findings.length
                            ? "Suggested corrections"
                            : "No confirmed corrections"}
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
                          related={source.documentId !== snapshot.documentId}
                          disabled={!!busy || stale || syncState !== "synced"}
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
                    {result.limitations.map((limit, index) => (
                      <Text key={index} size={1} muted style={{ lineHeight: 1.6 }}>
                        {limit}
                      </Text>
                    ))}
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
                        {(section === "text" ? stale : seoStale) && (
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
