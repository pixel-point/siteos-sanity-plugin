import { assertPath, publishedId, readPath } from "./paths.js";
import type {
  ContentSnapshot,
  DocumentMapping,
  DocumentValue,
  FieldPath,
  ReadDocuments,
  Source,
  SourceIssue,
} from "./types.js";

const LIMITS = {
  documents: 20,
  depth: 3,
  sources: 100,
  characters: 24_000,
  bytes: 128_000,
  referenceItems: 100,
} as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function validateMappings(mappings: Record<string, DocumentMapping>): void {
  if (!Object.keys(mappings).length) throw new Error("Configure at least one document type.");
  for (const [type, mapping] of Object.entries(mappings)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(type) ||
      !mapping.fields.length ||
      mapping.fields.length > 50
    )
      throw new Error("Each document type requires between 1 and 50 fields.");
    const paths = new Set<string>();
    for (const field of mapping.fields) {
      assertPath(field.path);
      const key = JSON.stringify(field.path);
      if (paths.has(key)) throw new Error("Map each field only once.");
      paths.add(key);
      if (!["title", "description", "heading", "body"].includes(field.role))
        throw new Error("Invalid content role.");
      if (field.format && !["text", "portableText"].includes(field.format))
        throw new Error("Invalid content format.");
    }
    if ((mapping.references?.length ?? 0) > 20)
      throw new Error("Configure at most 20 reference fields per type.");
    for (const reference of mapping.references ?? []) assertPath(reference);
    if (mapping.locale) assertPath(mapping.locale);
  }
}

export async function snapshotFingerprint(value: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > LIMITS.bytes)
    throw new Error("Selected content exceeds the review payload limit. Reduce the mapped fields.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function collectSnapshot(input: {
  document: DocumentValue;
  mappings: Record<string, DocumentMapping>;
  sanityProjectId: string;
  dataset: string;
  readDocuments: ReadDocuments;
  signal?: AbortSignal;
}): Promise<ContentSnapshot> {
  validateMappings(input.mappings);
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const root = structuredClone(input.document);
  if (!root._id || !root._rev || root._id.startsWith("versions."))
    throw new Error(
      "Save a draft or published document before checking. Release versions are not supported yet.",
    );
  const perspective = root._id.startsWith("drafts.") ? "drafts" : "published";
  const mapping = input.mappings[root._type];
  if (!mapping) throw new Error("This document type has no content mapping.");
  const sources: Source[] = [];
  const issues: SourceIssue[] = [];
  const documents: ContentSnapshot["documents"] = [];
  const visited = new Set<string>();
  const attempted = new Set<string>();
  let characters = 0;
  const issue = (
    doc: DocumentValue,
    path: FieldPath,
    code: SourceIssue["code"],
    message: string,
  ) => {
    if (issues.length < 100)
      issues.push({ code, message, documentId: doc._id, documentType: doc._type, path });
  };
  const add = (
    doc: DocumentValue,
    field: DocumentMapping["fields"][number],
    path: FieldPath,
    text: string,
    editable: boolean,
  ) => {
    if (!text.trim()) return;
    if (sources.length >= LIMITS.sources || characters + text.length > LIMITS.characters) {
      issue(doc, path, "limit", "Some content exceeds the review limit and was not included.");
      return;
    }
    characters += text.length;
    sources.push({
      id: `source-${sources.length + 1}`,
      documentId: doc._id,
      documentType: doc._type,
      revision: doc._rev,
      path,
      role: field.role,
      text,
      editable: editable && doc._id === root._id && perspective === "drafts",
    });
  };
  const visit = async (doc: DocumentValue, depth: number): Promise<void> => {
    signal.throwIfAborted();
    const id = publishedId(doc._id);
    if (visited.has(id)) return;
    visited.add(id);
    if (!doc._rev || !doc._type)
      throw new Error("Sanity returned a document without revision metadata.");
    documents.push({ id: doc._id, type: doc._type, revision: doc._rev });
    const selected = input.mappings[doc._type];
    if (!selected) return;
    for (const field of selected.fields) {
      const value = readPath(doc, field.path);
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length)
      ) {
        if (field.required)
          issue(doc, field.path, "missing-field", `Add the mapped ${field.role} content.`);
        continue;
      }
      if (field.format !== "portableText") {
        if (typeof value !== "string")
          issue(doc, field.path, "invalid-field", "The mapped field must contain text.");
        else add(doc, field, field.path, value, true);
        continue;
      }
      if (!Array.isArray(value)) {
        issue(doc, field.path, "invalid-field", "The mapped field must contain Portable Text.");
        continue;
      }
      const keys = new Set<string>();
      for (const block of value.slice(0, LIMITS.sources + 1)) {
        if (
          !isRecord(block) ||
          block._type !== "block" ||
          typeof block._key !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(block._key) ||
          keys.has(block._key) ||
          !Array.isArray(block.children) ||
          !block.children.every(
            (child) => isRecord(child) && child._type === "span" && typeof child.text === "string",
          )
        ) {
          issue(
            doc,
            field.path,
            "invalid-field",
            "A rich-text block could not be mapped. Custom blocks need an explicit mapping.",
          );
          continue;
        }
        keys.add(block._key);
        add(
          doc,
          { ...field, role: /^h[1-6]$/.test(String(block.style)) ? "heading" : field.role },
          [...field.path, { _key: block._key }],
          block.children.map((child) => child.text).join(""),
          false,
        );
      }
      if (value.length > LIMITS.sources + 1)
        issue(doc, field.path, "limit", "Some rich-text blocks were not included.");
    }
    for (const path of selected.references ?? []) {
      const value = readPath(doc, path);
      const refs =
        value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
      if (refs.length > LIMITS.referenceItems)
        issue(doc, path, "limit", "Some references exceed the review limit.");
      for (const ref of refs.slice(0, LIMITS.referenceItems)) {
        signal.throwIfAborted();
        if (
          !isRecord(ref) ||
          typeof ref._ref !== "string" ||
          ref._projectId ||
          ref._dataset ||
          !/^[A-Za-z0-9_.-]{1,256}$/.test(ref._ref) ||
          ref._ref.startsWith("versions.")
        ) {
          issue(
            doc,
            path,
            "unsupported-reference",
            "Only references within this project and dataset can be reviewed.",
          );
          continue;
        }
        const target = publishedId(ref._ref);
        if (visited.has(target)) continue;
        if (attempted.has(target)) continue;
        if (attempted.size >= LIMITS.referenceItems) {
          issue(doc, path, "limit", "The reference lookup limit was reached.");
          continue;
        }
        if (depth >= LIMITS.depth || documents.length >= LIMITS.documents) {
          issue(doc, path, "limit", "Some related documents exceed the review limit.");
          continue;
        }
        attempted.add(target);
        const ids = perspective === "drafts" ? [`drafts.${target}`, target] : [target];
        const results = await input.readDocuments(ids, signal);
        signal.throwIfAborted();
        const related = ids
          .map((expected) => results.find((item) => item?._id === expected))
          .find(Boolean);
        if (!related) {
          issue(
            doc,
            path,
            "unavailable-reference",
            "A related document is unavailable or you do not have access.",
          );
          continue;
        }
        if (!input.mappings[related._type]) {
          issue(
            doc,
            path,
            "unsupported-reference",
            "Configure the related document type to include its content.",
          );
          continue;
        }
        await visit(related, depth + 1);
      }
    }
  };
  await visit(root, 0);
  const locale = mapping.locale ? readPath(root, mapping.locale) : null;
  const snapshot: Omit<ContentSnapshot, "fingerprint"> = {
    version: 1,
    sanityProjectId: input.sanityProjectId,
    dataset: input.dataset,
    documentId: root._id,
    perspective,
    locale: typeof locale === "string" ? locale : null,
    documents,
    sources,
    issues,
  };
  return { ...snapshot, fingerprint: await snapshotFingerprint(snapshot) };
}
