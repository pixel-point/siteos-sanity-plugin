import { resolveDocumentMapping, reviewLocale } from "./mappings.js";
import { assertPath, formatPath, publishedId, readPath } from "./paths.js";
import { snapshotFingerprint } from "./snapshot.js";
import { validateSeoNotApplicable } from "./seo-report.js";
import {
  inheritedImageText,
  isNonProse,
  portableText,
  record,
  schemaAt,
  schemaIs,
  validReference,
  walkContent,
  type StudioSchema,
} from "./content-tree.js";
import type { DocumentMapping, DocumentValue, FieldPath } from "./types.js";
import type { SeoEvidence, SeoMapping, SeoSectionId, SeoTextField } from "./seo-types.js";

export type SeoQuery = (
  query: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  perspective: "drafts" | "published",
) => Promise<unknown>;
export function validateSeoMapping(mapping: SeoMapping | undefined) {
  if (!mapping) return;
  validateSeoNotApplicable(mapping.notApplicable);
  for (const key of [
    "title",
    "description",
    "slug",
    "primaryHeading",
    "canonicalUrl",
    "noIndex",
    "socialImage",
    "focusKeyword",
  ] as const)
    if (mapping[key]) assertPath(mapping[key]);
  if (mapping.duplicates !== undefined && typeof mapping.duplicates !== "boolean")
    throw new Error("SEO duplicates must be a boolean.");
  for (const path of [...(mapping.portableText ?? []), ...(mapping.content ?? [])])
    assertPath(path);
  for (const fallback of [mapping.titleFallback, mapping.descriptionFallback])
    if (fallback !== undefined && typeof fallback !== "string") assertPath(fallback.path);
  for (const image of mapping.images ?? []) {
    assertPath(image.path);
    if (image.alt) assertPath(image.alt);
    if (image.decorative) assertPath(image.decorative);
  }
  for (const link of mapping.links ?? []) {
    assertPath(link.path);
    for (const key of ["href", "text", "reference"] as const) if (link[key]) assertPath(link[key]);
  }
  for (const custom of Object.values(mapping.customTypes ?? {}))
    for (const heading of custom.headings ?? []) {
      assertPath(heading.path);
      if (!Number.isInteger(heading.level) || heading.level < 1 || heading.level > 6)
        throw new Error("A custom heading needs a level from 1 to 6.");
    }
}
/** Source observations only. Verdicts remain server-owned. */
export async function collectSeoEvidence(input: {
  document: DocumentValue;
  mapping: DocumentMapping;
  sanityProjectId: string;
  dataset: string;
  query: SeoQuery;
  signal: AbortSignal;
  schema?: StudioSchema;
  locale?: string | null;
}): Promise<SeoEvidence> {
  input.signal.throwIfAborted();
  const doc = structuredClone(input.document);
  const locale = reviewLocale(doc, input.mapping, input.locale);
  const mapping = resolveDocumentMapping(input.mapping, {
    document: doc,
    rootDocument: doc,
    locale,
  });
  const config = mapping.seo ?? {};
  validateSeoMapping(config);
  if (!doc._id || !doc._rev || doc._id.startsWith("versions."))
    throw new Error(
      "Save a draft or published document before checking SEO. Release versions are not supported.",
    );
  const perspective = doc._id.startsWith("drafts.") ? "drafts" : "published";
  const limitations: SeoEvidence["limitations"] = [];
  const note = (section: SeoSectionId, message: string) => {
    if (!limitations.some((item) => item.section === section && item.message === message))
      limitations.push({ section, message });
  };
  const text = (value: unknown, section: SeoSectionId): string | null => {
    if (value == null) return null;
    if (typeof value !== "string" || value.length > 6000 || value.includes("\0")) {
      note(
        section,
        "A mapped SEO value is not text or is too large for metadata. The full field remains available in Text review.",
      );
      return null;
    }
    return value;
  };
  const field = (
    path: FieldPath | undefined,
    section: SeoSectionId,
    fallback?: string | { path: FieldPath },
  ): SeoTextField | null => {
    if (!path) return null;
    const value = text(readPath(doc, path), section);
    if (!value?.trim() && fallback !== undefined)
      return {
        path,
        value: text(
          typeof fallback === "string" ? fallback : readPath(doc, fallback.path),
          section,
        ),
        fallback: true,
      };
    return { path, value };
  };
  const titlePath = config.title ?? mapping.fields.find((f) => f.role === "title")?.path;
  const descriptionPath =
    config.description ?? mapping.fields.find((f) => f.role === "description")?.path;
  const portablePaths =
    config.portableText ??
    mapping.fields.filter((f) => f.format === "portableText").map((f) => f.path);
  const contentPaths =
    config.content ?? mapping.fields.filter((f) => f.format === "content").map((f) => f.path);
  const noIndex = config.noIndex ? readPath(doc, config.noIndex) : undefined;
  if (noIndex != null && typeof noIndex !== "boolean")
    note("indexing", "The noindex mapping must contain a boolean.");
  const social = config.socialImage ? readPath(doc, config.socialImage) : null;
  const socialRef = record(social) && record(social.asset) ? social.asset._ref : null;
  const dimensions = typeof socialRef === "string" ? /-(\d+)x(\d+)-[^-]+$/.exec(socialRef) : null;
  const fields: SeoEvidence["fields"] = {
    title: field(titlePath, "metadata", config.titleFallback),
    description: field(descriptionPath, "metadata", config.descriptionFallback),
    slug: field(config.slug, "slug"),
    canonicalUrl: field(config.canonicalUrl, "canonical"),
    focusKeyword: field(config.focusKeyword, "keyword"),
    noIndex: config.noIndex
      ? { path: config.noIndex, value: typeof noIndex === "boolean" ? noIndex : null }
      : null,
    socialImage: config.socialImage
      ? {
          path: config.socialImage,
          hasAsset: typeof socialRef === "string" && !!socialRef,
          width: dimensions ? Number(dimensions[1]) : null,
          height: dimensions ? Number(dimensions[2]) : null,
        }
      : null,
  };
  const headings = new Map<string, NonNullable<SeoEvidence["headings"]>[number]>();
  const images = new Map<string, NonNullable<SeoEvidence["images"]>[number]>();
  const links = new Map<string, NonNullable<SeoEvidence["links"]>[number]>();
  const addImage = (
    value: Record<string, unknown>,
    path: FieldPath,
    alt: unknown = value.alt,
    decorative: unknown = value.decorative,
  ) =>
    images.set(JSON.stringify(path), {
      path,
      alt: text(alt, "images"),
      decorative: decorative === true,
      hasAsset: record(value.asset) && typeof value.asset._ref === "string" && !!value.asset._ref,
    });
  const addLink = (path: FieldPath, href: unknown, label: unknown, ref?: unknown) => {
    let reference: { id: string; exists: boolean | null } | null = null;
    if (ref != null) {
      if (validReference(ref)) reference = { id: publishedId(ref._ref), exists: null };
      else
        note(
          "links",
          "A link reference could not be inspected. Cross-dataset and release references are not supported.",
        );
    }
    links.set(JSON.stringify(path), {
      path,
      href: text(href, "links"),
      text: text(label, "links"),
      reference,
    });
  };
  if (config.primaryHeading)
    headings.set(JSON.stringify(config.primaryHeading), {
      path: config.primaryHeading,
      level: 1,
      text: text(readPath(doc, config.primaryHeading), "headings") ?? "",
    });
  const inspect = (value: unknown, path: FieldPath) =>
    walkContent({
      value,
      path,
      schema: schemaAt(input.schema?.get(doc._type), doc, path),
      signal: input.signal,
      exclude: mapping.exclude,
      onIssue: (_path, message) => {
        for (const section of ["headings", "images", "links"] as const) note(section, message);
      },
      onNode(node) {
        if (record(node.value) && node.value._type === "block") {
          const block = portableText(node.value);
          if (!block.complete)
            note(
              "headings",
              "Dynamic inline content cannot be resolved from text spans alone; verify its rendered values.",
            );
          if (/^h[1-6]$/.test(String(node.value.style)))
            headings.set(JSON.stringify(node.path), {
              path: node.path,
              level: Number(String(node.value.style).slice(1)),
              text: text(block.text, "headings") ?? "",
            });
          const children = Array.isArray(node.value.children) ? node.value.children : [];
          const marks = Array.isArray(node.value.markDefs) ? node.value.markDefs : [];
          for (const mark of marks) {
            if (
              !record(mark) ||
              typeof mark._key !== "string" ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(mark._key) ||
              marks.filter((m) => record(m) && m._key === mark._key).length !== 1
            ) {
              note("links", "A link annotation has no unique stable key.");
              continue;
            }
            const label = children
              .filter(
                (child) =>
                  record(child) && Array.isArray(child.marks) && child.marks.includes(mark._key),
              )
              .map((child) => (record(child) && typeof child.text === "string" ? child.text : ""))
              .join("");
            if (
              mark._type === "link" ||
              mark._type === "internalLink" ||
              "href" in mark ||
              "reference" in mark
            )
              addLink(
                [...node.path, "markDefs", { _key: mark._key }],
                mark.href,
                label,
                mark.reference,
              );
            else if ("url" in mark)
              addLink([...node.path, "markDefs", { _key: mark._key }], mark.url, label);
          }
          const inline = children.filter((child) => record(child) && child._type !== "span");
          if (inline.length) inspect(inline, [...node.path, "children"]);
          return false;
        }
        if (
          record(node.value) &&
          (schemaIs(node.schema, "image") ||
            node.value._type === "image" ||
            (record(node.value.asset) &&
              typeof node.value.asset._ref === "string" &&
              node.value.asset._ref.startsWith("image-")))
        ) {
          addImage(
            node.value,
            node.path,
            inheritedImageText(node, "alt"),
            inheritedImageText(node, "decorative"),
          );
          return false;
        }
        if (record(node.value)) {
          if (node.value._ref) return false;
          for (const heading of config.customTypes?.[String(node.value._type)]?.headings ?? []) {
            const path = [...node.path, ...heading.path];
            assertPath(path);
            headings.set(JSON.stringify(path), {
              path,
              level: heading.level,
              text: text(readPath(node.value, heading.path), "headings") ?? "",
            });
          }
          if (
            "href" in node.value ||
            "link" in node.value ||
            node.value._type === "link" ||
            node.value._type === "internalLink"
          )
            addLink(
              node.path,
              node.value.href ?? node.value.link,
              node.value.text ?? node.value.label ?? node.value.title,
              node.value.reference,
            );
        }
        if (isNonProse(node)) return false;
      },
    });
  for (const path of portablePaths) {
    const value = readPath(doc, path);
    if (value != null && !Array.isArray(value))
      for (const section of ["headings", "images", "links"] as const)
        note(section, "A Portable Text mapping is not an array.");
    else inspect(value, path);
  }
  for (const path of contentPaths) inspect(readPath(doc, path), path);
  const entries = (value: unknown, path: FieldPath) => {
    const result: { value: Record<string, unknown>; path: FieldPath }[] = [];
    walkContent({
      value,
      path,
      signal: input.signal,
      onIssue: (_p, message) => {
        note("images", message);
        note("links", message);
      },
      onNode(node) {
        if (record(node.value)) {
          result.push({ value: node.value, path: node.path });
          return false;
        }
      },
    });
    return result;
  };
  for (const image of config.images ?? [])
    for (const entry of entries(readPath(doc, image.path), image.path))
      addImage(
        entry.value,
        entry.path,
        readPath(entry.value, image.alt ?? ["alt"]),
        readPath(entry.value, image.decorative ?? ["decorative"]),
      );
  for (const link of config.links ?? [])
    for (const entry of entries(readPath(doc, link.path), link.path))
      addLink(
        entry.path,
        readPath(entry.value, link.href ?? ["href"]),
        link.text ? readPath(entry.value, link.text) : null,
        readPath(entry.value, link.reference ?? ["reference"]),
      );
  const ids = [
    ...new Set([...links.values()].flatMap((link) => (link.reference ? [link.reference.id] : []))),
  ];
  for (let at = 0; at < ids.length; at += 100) {
    input.signal.throwIfAborted();
    const selected = ids.slice(at, at + 100);
    try {
      const response = await input.query(
        "*[_id in $ids]{_id}",
        { ids: selected },
        input.signal,
        perspective,
      );
      if (
        !Array.isArray(response) ||
        response.some((row) => !record(row) || typeof row._id !== "string")
      )
        throw new Error("Invalid reference response");
      const found = new Set(response.map((row) => publishedId(row._id)));
      for (const link of links.values())
        if (link.reference && selected.includes(link.reference.id))
          link.reference.exists = found.has(link.reference.id);
    } catch {
      input.signal.throwIfAborted();
      note("links", "Linked documents could not be read. Reference availability is unverified.");
    }
  }
  const duplicates: SeoEvidence["duplicates"] =
    config.duplicates === false || config.notApplicable?.duplicates ? null : [];
  if (duplicates)
    for (const name of ["title", "description", "slug"] as const) {
      const value = fields[name];
      if (!value?.value?.trim() || value.fallback) continue;
      if (input.mapping.locale && (typeof locale !== "string" || !locale.trim())) {
        note(
          "duplicates",
          "The mapped locale is empty or invalid. Cross-document comparison was not performed.",
        );
        continue;
      }
      try {
        const sameLocale = input.mapping.locale
          ? ` && ${formatPath(input.mapping.locale)} == $locale`
          : "";
        const matches: NonNullable<SeoEvidence["duplicates"]>[number]["matches"] = [];
        let after = "";
        for (;;) {
          input.signal.throwIfAborted();
          const response = await input.query(
            `*[_type == $type && !(_id in $self) && ${formatPath(value.path)} == $value${sameLocale} && _id > $after] | order(_id asc)[0...100]{_id, _type}`,
            {
              type: doc._type,
              self: [doc._id, publishedId(doc._id), `drafts.${publishedId(doc._id)}`],
              value: value.value,
              after,
              ...(input.mapping.locale ? { locale } : {}),
            },
            input.signal,
            perspective,
          );
          if (
            !Array.isArray(response) ||
            response.length > 100 ||
            response.some(
              (row) => !record(row) || typeof row._id !== "string" || typeof row._type !== "string",
            )
          )
            throw new Error("Invalid duplicate response");
          for (const row of response)
            if (!matches.some((match) => match.documentId === publishedId(row._id)))
              matches.push({ documentId: publishedId(row._id), documentType: row._type });
          if (response.length < 100) break;
          const next = response.at(-1)._id;
          if (next <= after) throw new Error("Duplicate pagination did not advance");
          after = next;
        }
        duplicates.push({ field: name, path: value.path, matches, more: false });
      } catch {
        input.signal.throwIfAborted();
        note(
          "duplicates",
          `The ${name} comparison could not be completed. No uniqueness claim is made.`,
        );
      }
    }
  const evidence: Omit<SeoEvidence, "fingerprint"> = {
    version: 2,
    sanityProjectId: input.sanityProjectId,
    dataset: input.dataset,
    documentId: doc._id,
    documentType: doc._type,
    revision: doc._rev,
    perspective,
    fields,
    primaryHeadingMapped: !!config.primaryHeading,
    headings:
      config.primaryHeading || portablePaths.length || contentPaths.length
        ? [...headings.values()]
        : null,
    images:
      config.images?.length || portablePaths.length || contentPaths.length
        ? [...images.values()]
        : null,
    links:
      config.links?.length || portablePaths.length || contentPaths.length
        ? [...links.values()]
        : null,
    duplicates,
    limitations,
  };
  return { ...evidence, fingerprint: await snapshotFingerprint({ evidence, mapping, locale }) };
}
