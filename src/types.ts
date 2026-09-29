import type { SeoMapping, SeoEvidence, SeoCheckResult } from "./seo-types.js";
export type FieldPath = readonly (string | { readonly _key: string })[];
export type ContentRole = "title" | "description" | "heading" | "body";
export type DocumentValue = {
  _id: string;
  _type: string;
  _rev: string;
  [key: string]: unknown;
};
export type DocumentMapping = {
  fields: readonly {
    path: FieldPath;
    role: ContentRole;
    format?: "text" | "portableText" | "content";
    required?: boolean;
  }[];
  /** Exclude non-editorial subtrees inside selected content. */
  exclude?: readonly FieldPath[];
  references?: readonly FieldPath[];
  locale?: FieldPath;
  seo?: SeoMapping;
};
export type Source = {
  id: string;
  documentId: string;
  documentType: string;
  revision: string;
  path: FieldPath;
  role: ContentRole;
  text: string;
  editable: boolean;
};
export type SourceIssue = {
  code:
    | "missing-field"
    | "invalid-field"
    | "unavailable-reference"
    | "unsupported-reference"
    | "limit";
  message: string;
  documentId: string;
  documentType: string;
  path: FieldPath;
};
export type ContentSnapshot = {
  version: 1;
  sanityProjectId: string;
  dataset: string;
  documentId: string;
  perspective: "drafts" | "published";
  locale: string | null;
  documents: { id: string; type: string; revision: string }[];
  sources: Source[];
  issues: SourceIssue[];
  /** Hash of the complete selected evidence, including related document revisions. */
  fingerprint: string;
};
export type ReadDocuments = (
  ids: string[],
  signal: AbortSignal,
) => Promise<(DocumentValue | null)[]>;

export type Connection = {
  id?: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  projectName: string;
  environmentName: string;
};
export type Finding = {
  id: string;
  sourceId: string;
  kind: "metadata" | "heading" | "placeholder" | "spelling" | "grammar";
  quote: string;
  replacement: string;
  explanation: string;
  action: "replace" | "remove";
};
export type CheckResult = {
  fingerprint: string;
  findings: Finding[];
  limitations: string[];
  coverage?: { completed: number; total: number };
  complete?: boolean;
};

/** SiteOS adapter boundary. Credentials never belong in Studio configuration. */
export interface SiteosConnectionAdapter {
  manageUrl?: string;
  load?(signal: AbortSignal): Promise<Connection | null>;
  current(): Connection | null;
  connect(signal: AbortSignal): Promise<Connection>;
  disconnect(): void;
  checkSeo?(input: {
    connection: Connection;
    evidence: SeoEvidence;
    signal: AbortSignal;
  }): Promise<SeoCheckResult>;
  check(input: {
    connection: Connection;
    snapshot: ContentSnapshot;
    signal: AbortSignal;
    onProgress?(progress: { completed: number; total: number; result: CheckResult }): void;
  }): Promise<CheckResult>;
}
export type SiteosPluginOptions = {
  /** Defaults to https://app.siteos.sh. This is public configuration, never a credential. */
  siteosUrl?: string;
  documentTypes: Record<string, DocumentMapping>;
  /** Optional override for development and synthetic previews. Production uses the shared SiteOS connection. */
  connection?: SiteosConnectionAdapter;
};
