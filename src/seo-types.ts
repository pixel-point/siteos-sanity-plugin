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
  /** Exact-value comparison within the same document type and mapped locale. Defaults to true. */
  duplicates?: boolean;
};
export type SeoSectionId = "metadata" | "headings" | "images" | "links" | "slug" | "duplicates";
export type SeoTextField = { path: FieldPath; value: string | null };
export type SeoEvidence = {
  version: 1;
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
  version: 1;
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
