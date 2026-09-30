import type { FieldPath } from "./types.js";

export type SeoMapping = {
  title?: FieldPath;
  description?: FieldPath;
  slug?: FieldPath;
  /** Explicitly declares the field rendered as the page's primary heading. */
  primaryHeading?: FieldPath;
  /** Standard Portable Text headings, images and link annotations. */
  portableText?: readonly FieldPath[];
  images?: readonly { path: FieldPath; alt?: FieldPath; decorative?: FieldPath }[];
  links?: readonly { path: FieldPath; href?: FieldPath; text?: FieldPath; reference?: FieldPath }[];
  /** Structured content roots; defaults to mapped portableText/content fields. */
  content?: readonly FieldPath[];
  canonicalUrl?: FieldPath;
  noIndex?: FieldPath;
  socialImage?: FieldPath;
  focusKeyword?: FieldPath;
  /** Website defaults are explicit configuration, never inferred. */
  titleFallback?: string | { path: FieldPath };
  descriptionFallback?: string | { path: FieldPath };
  /** Heading semantics for custom blocks are chosen by the website renderer. */
  customTypes?: Record<string, { headings?: readonly { path: FieldPath; level: number }[] }>;
  /** Exact-value comparison within the same document type and mapped locale. Defaults to true. */
  duplicates?: boolean;
  /** Sections outside this document type's audit scope, with a reader-facing reason. */
  notApplicable?: SeoNotApplicable;
};
export type SeoSectionId =
  | "metadata"
  | "headings"
  | "images"
  | "links"
  | "slug"
  | "duplicates"
  | "canonical"
  | "indexing"
  | "social"
  | "keyword";
export type SeoNotApplicable = Partial<Record<SeoSectionId, string>>;
export type SeoTextField = { path: FieldPath; value: string | null; fallback?: boolean };
export type SeoEvidence = {
  version: 1 | 2;
  sanityProjectId: string;
  dataset: string;
  documentId: string;
  documentType: string;
  revision: string;
  perspective: "drafts" | "published";
  fields: {
    title: SeoTextField | null;
    description: SeoTextField | null;
    slug: SeoTextField | null;
    canonicalUrl?: SeoTextField | null;
    focusKeyword?: SeoTextField | null;
    noIndex?: { path: FieldPath; value: boolean | null } | null;
    socialImage?: {
      path: FieldPath;
      hasAsset: boolean;
      width: number | null;
      height: number | null;
    } | null;
  };
  primaryHeadingMapped: boolean;
  headings: { path: FieldPath; level: number; text: string }[] | null;
  images: { path: FieldPath; alt: string | null; decorative: boolean; hasAsset: boolean }[] | null;
  links:
    | {
        path: FieldPath;
        href: string | null;
        text: string | null;
        reference: { id: string; exists: boolean | null } | null;
      }[]
    | null;
  duplicates:
    | {
        field: "title" | "description" | "slug";
        path: FieldPath;
        matches: { documentId: string; documentType: string }[];
        more: boolean;
      }[]
    | null;
  limitations: { section: SeoSectionId; message: string }[];
  batch?: {
    index: number;
    total: number;
    previousHeadingLevel: number;
    primaryHeadingsBefore: number;
    counts: { headings: number; images: number; links: number; duplicates: number };
  };
  fingerprint: string;
};
export type SeoFinding = {
  id: string;
  severity: "warning" | "notice";
  title: string;
  message: string;
  path: FieldPath;
  relatedDocument?: { id: string; type: string };
};
export type SeoCheckResult = {
  version: 1 | 2;
  rulesVersion: string;
  fingerprint: string;
  sections: {
    id: SeoSectionId;
    title: string;
    status: "passed" | "attention" | "partial" | "not-configured";
    details: string[];
    findings: SeoFinding[];
  }[];
};
