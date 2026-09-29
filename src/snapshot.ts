import { assertPath, publishedId, readPath } from "./paths.js";
import {
  isNonProse,
  portableText,
  record,
  schemaAt,
  validReference,
  walkContent,
  type StudioSchema,
} from "./content-tree.js";
import type {
  ContentSnapshot,
  DocumentMapping,
  DocumentValue,
  FieldPath,
  ReadDocuments,
  Source,
  SourceIssue,
} from "./types.js";

export function validateMappings(mappings: Record<string, DocumentMapping>): void {
  if (!Object.keys(mappings).length) throw new Error("Configure at least one document type.");
  for (const [type, mapping] of Object.entries(mappings)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(type) || !mapping.fields.length)
      throw new Error("Each document type requires at least one field.");
    const paths = new Set<string>();
    for (const field of mapping.fields) {
      assertPath(field.path);
      const key = JSON.stringify(field.path);
      if (paths.has(key)) throw new Error("Map each field only once.");
      paths.add(key);
      if (!["title", "description", "heading", "body"].includes(field.role))
        throw new Error("Invalid content role.");
      if (field.format && !["text", "portableText", "content"].includes(field.format))
        throw new Error("Invalid content format.");
    }
    for (const path of [...(mapping.references ?? []), ...(mapping.exclude ?? [])])
      assertPath(path);
    if (mapping.locale) assertPath(mapping.locale);
  }
}

/** Fingerprints local complete evidence. Only transport requests have a byte bound. */
export async function snapshotFingerprint(value: object): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function collectSnapshot(input: {
  document: DocumentValue;
  mappings: Record<string, DocumentMapping>;
  sanityProjectId: string;
  dataset: string;
  readDocuments: ReadDocuments;
  schema?: StudioSchema;
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
  const sources: Source[] = [],
    issues: SourceIssue[] = [],
    documents: ContentSnapshot["documents"] = [];
  const visited = new Set<string>(),
    attempted = new Set<string>(),
    issueKeys = new Set<string>(),
    sourceKeys = new Set<string>();
  const pending = [root];
  const issue = (
    doc: DocumentValue,
    path: FieldPath,
    code: SourceIssue["code"],
    message: string,
  ) => {
    const key = JSON.stringify([doc._id, path, code, message]);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push({ code, message, documentId: doc._id, documentType: doc._type, path });
    }
  };
  const add = (
    doc: DocumentValue,
    role: Source["role"],
    path: FieldPath,
    text: string,
    editable: boolean,
  ) => {
    if (!text.trim()) return;
    if (
      text.includes("\0") ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
    ) {
      issue(
        doc,
        path,
        "invalid-field",
        "This field contains invalid Unicode characters. Correct the source text before checking.",
      );
      return;
    }
    const key = JSON.stringify([doc._id, path, text]);
    if (sourceKeys.has(key)) return;
    sourceKeys.add(key);
    sources.push({
      id: `source-${sources.length + 1}`,
      documentId: doc._id,
      documentType: doc._type,
      revision: doc._rev,
      path,
      role,
      text,
      editable: editable && doc._id === root._id && perspective === "drafts",
    });
  };
  for (let cursor = 0; cursor < pending.length; cursor++) {
    signal.throwIfAborted();
    const doc = pending[cursor]!;
    const id = publishedId(doc._id);
    if (visited.has(id)) continue;
    visited.add(id);
    if (!doc._rev || !doc._type)
      throw new Error("Sanity returned a document without revision metadata.");
    const selected = input.mappings[doc._type];
    if (!selected) continue;
    documents.push({ id: doc._id, type: doc._type, revision: doc._rev });
    const references: { value: unknown; path: FieldPath }[] = [];
    for (const field of selected.fields) {
      const value = readPath(doc, field.path);
      if (
        value == null ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && !value.length)
      ) {
        if (field.required)
          issue(doc, field.path, "missing-field", `Add the mapped ${field.role} content.`);
        continue;
      }
      if (!field.format || field.format === "text") {
        if (typeof value !== "string")
          issue(
            doc,
            field.path,
            "invalid-field",
            "The mapped field must contain text. Use format: content for nested objects.",
          );
        else add(doc, field.role, field.path, value, true);
        continue;
      }
      if (field.format === "portableText" && !Array.isArray(value)) {
        issue(doc, field.path, "invalid-field", "The mapped field must contain Portable Text.");
        continue;
      }
      const inspect = (value: unknown, path: FieldPath) =>
        walkContent({
          value,
          path,
          schema: schemaAt(input.schema?.get(doc._type), doc, path),
          signal,
          exclude: selected.exclude,
          onIssue: (path, message) => issue(doc, path, "invalid-field", message),
          onNode(node) {
            if (isNonProse(node)) return false;
            if (record(node.value) && node.value._ref) {
              references.push({ value: node.value, path: node.path });
              return false;
            }
            if (record(node.value) && node.value._type === "block") {
              const block = portableText(node.value);
              const role = /^h[1-6]$/.test(String(node.value.style)) ? "heading" : field.role;
              const children = Array.isArray(node.value.children) ? node.value.children : [];
              const hasCode = children.some(
                (child) =>
                  record(child) && Array.isArray(child.marks) && child.marks.includes("code"),
              );
              if (block.complete && !hasCode) add(doc, role, node.path, block.text, false);
              else {
                // Keep span runs separate around dynamic inline objects; never join unrelated words.
                let run = "";
                for (const child of children) {
                  if (
                    record(child) &&
                    child._type === "span" &&
                    typeof child.text === "string" &&
                    !(Array.isArray(child.marks) && child.marks.includes("code"))
                  )
                    run += child.text;
                  else {
                    add(doc, role, node.path, run, false);
                    run = "";
                  }
                }
                add(doc, role, node.path, run, false);
                if (!block.complete) {
                  inspect(
                    children.filter((child) => record(child) && child._type !== "span"),
                    [...node.path, "children"],
                  );
                  issue(
                    doc,
                    node.path,
                    "invalid-field",
                    "This block includes dynamic inline content. Its stored text was checked separately; verify the rendered inline values and spacing.",
                  );
                }
              }
              return false;
            }
            if (typeof node.value === "string")
              add(doc, field.role, node.path, node.value, !node.readonly);
          },
        });
      inspect(value, field.path);
    }
    for (const path of selected.references ?? []) {
      const value = readPath(doc, path);
      for (const ref of value == null ? [] : Array.isArray(value) ? value : [value])
        references.push({ value: ref, path });
    }
    for (const { value: ref, path } of references) {
      signal.throwIfAborted();
      if (!validReference(ref)) {
        issue(
          doc,
          path,
          "unsupported-reference",
          "Only references within this project and dataset can be reviewed.",
        );
        continue;
      }
      const target = publishedId(ref._ref);
      if (visited.has(target) || attempted.has(target)) continue;
      attempted.add(target);
      const ids = perspective === "drafts" ? [`drafts.${target}`, target] : [target];
      const results = await input.readDocuments(ids, signal);
      signal.throwIfAborted();
      const related = ids
        .map((expected) => results.find((item) => item?._id === expected))
        .find(Boolean);
      if (!related)
        issue(
          doc,
          path,
          "unavailable-reference",
          "A related document is unavailable or you do not have access.",
        );
      else if (!input.mappings[related._type])
        issue(
          doc,
          path,
          "unsupported-reference",
          "Configure the related document type to include its content.",
        );
      else pending.push(related);
    }
  }
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
