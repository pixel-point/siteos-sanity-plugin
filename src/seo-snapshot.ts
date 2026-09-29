import { assertPath, formatPath, publishedId, readPath } from "./paths.js";
import { snapshotFingerprint } from "./snapshot.js";
import type { DocumentMapping, DocumentValue, FieldPath } from "./types.js";
import type { SeoEvidence, SeoMapping, SeoSectionId, SeoTextField } from "./seo-types.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export type SeoQuery = (
  query: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  perspective: "drafts" | "published",
) => Promise<unknown>;

export function validateSeoMapping(mapping: SeoMapping | undefined) {
  if (!mapping) return;
  for (const key of ["title", "description", "slug", "primaryHeading"] as const)
    if (mapping[key]) assertPath(mapping[key]);
  if (mapping.duplicates !== undefined && typeof mapping.duplicates !== "boolean")
    throw new Error("SEO duplicates must be a boolean.");
  for (const list of [mapping.portableText, mapping.images, mapping.links])
    if ((list?.length ?? 0) > 20) throw new Error("Configure at most 20 SEO paths per section.");
  for (const path of mapping.portableText ?? []) assertPath(path);
  for (const image of mapping.images ?? []) {
    assertPath(image.path);
    if (image.alt) assertPath(image.alt);
    if (image.decorative) assertPath(image.decorative);
  }
  for (const link of mapping.links ?? []) {
    assertPath(link.path);
    for (const key of ["href", "text", "reference"] as const) if (link[key]) assertPath(link[key]);
  }
}

/** Sanity data adapter. SEO verdicts are evaluated by SiteOS, never in this collector. */
export async function collectSeoEvidence(input: {
  document: DocumentValue;
  mapping: DocumentMapping;
  sanityProjectId: string;
  dataset: string;
  query: SeoQuery;
  signal: AbortSignal;
}): Promise<SeoEvidence> {
  const doc = structuredClone(input.document),
    config = input.mapping.seo ?? {};
  validateSeoMapping(config);
  if (!doc._id || !doc._rev || doc._id.startsWith("versions."))
    throw new Error(
      "Save a draft or published document before checking SEO. Release versions are not supported.",
    );
  const perspective = doc._id.startsWith("drafts.") ? "drafts" : "published";
  const limitations: SeoEvidence["limitations"] = [];
  const note = (section: SeoSectionId, message: string) => {
    if (
      !limitations.some((item) => item.section === section && item.message === message) &&
      limitations.length < 30
    )
      limitations.push({ section, message });
  };
  const text = (value: unknown, section: SeoSectionId): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > 6000 || value.includes("\0")) {
      note(
        section,
        "Some mapped values are not text or exceed the 6,000-character field limit. Review the field mapping.",
      );
      return null;
    }
    return value;
  };
  const field = (path: FieldPath | undefined, section: SeoSectionId): SeoTextField | null =>
    path ? { path, value: text(readPath(doc, path), section) } : null;
  const titlePath = config.title ?? input.mapping.fields.find((f) => f.role === "title")?.path;
  const descriptionPath =
    config.description ?? input.mapping.fields.find((f) => f.role === "description")?.path;
  const portablePaths =
    config.portableText ??
    input.mapping.fields.filter((f) => f.format === "portableText").map((f) => f.path);
  const fields = {
    title: field(titlePath, "metadata"),
    description: field(descriptionPath, "metadata"),
    slug: field(config.slug, "slug"),
  };
  const headings: NonNullable<SeoEvidence["headings"]> = [];
  const images: NonNullable<SeoEvidence["images"]> = [];
  const links: NonNullable<SeoEvidence["links"]> = [];
  const limitedPush = <T>(list: T[], value: T, section: SeoSectionId) => {
    if (list.length < 100) list.push(value);
    else note(section, "Only the first 100 mapped entries were included.");
  };
  const entries = (
    value: unknown,
    path: FieldPath,
    sections: SeoSectionId[],
  ): { value: Record<string, unknown>; path: FieldPath }[] => {
    if (value == null) return [];
    if (record(value)) return [{ value, path }];
    if (!Array.isArray(value)) {
      for (const section of sections)
        note(section, "A mapped collection has an unsupported value. Check its field mapping.");
      return [];
    }
    if (value.length > 200)
      for (const section of sections)
        note(section, "Only the first 200 collection entries were inspected.");
    const bounded = value.slice(0, 200);
    const keys = new Set<string>();
    return bounded.flatMap((item) => {
      if (
        !record(item) ||
        typeof item._key !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(item._key) ||
        keys.has(item._key) ||
        bounded.filter((v) => record(v) && v._key === item._key).length !== 1
      ) {
        for (const section of sections)
          note(
            section,
            "Some collection entries have missing or ambiguous keys and could not be inspected.",
          );
        return [];
      }
      keys.add(item._key);
      const itemPath = [...path, { _key: item._key }];
      if (itemPath.length > 32) {
        for (const section of sections)
          note(section, "A nested field exceeded the navigation path limit.");
        return [];
      }
      return [{ value: item, path: itemPath }];
    });
  };
  const addImage = (
    value: Record<string, unknown>,
    path: FieldPath,
    alt: FieldPath = ["alt"],
    decorative: FieldPath = ["decorative"],
  ) => {
    limitedPush(
      images,
      {
        path,
        alt: text(readPath(value, alt), "images"),
        decorative: readPath(value, decorative) === true,
        hasAsset: record(value.asset) && typeof value.asset._ref === "string" && !!value.asset._ref,
      },
      "images",
    );
  };
  const addLink = (
    value: Record<string, unknown>,
    path: FieldPath,
    href: FieldPath = ["href"],
    label: string | null = null,
    reference: FieldPath = ["reference"],
  ) => {
    const ref = readPath(value, reference);
    let target: { id: string; exists: boolean | null } | null = null;
    if (ref != null) {
      if (
        record(ref) &&
        typeof ref._ref === "string" &&
        ref._ref.length <= 200 &&
        !ref._ref.startsWith("versions.") &&
        !ref._projectId &&
        !ref._dataset
      )
        target = { id: publishedId(ref._ref), exists: null };
      else
        note(
          "links",
          "A link reference could not be inspected. Cross-dataset and release references are not supported.",
        );
    }
    limitedPush(
      links,
      { path, href: text(readPath(value, href), "links"), text: label, reference: target },
      "links",
    );
  };
  if (config.primaryHeading)
    limitedPush(
      headings,
      {
        path: config.primaryHeading,
        level: 1,
        text: text(readPath(doc, config.primaryHeading), "headings") ?? "",
      },
      "headings",
    );
  for (const path of portablePaths) {
    const value = readPath(doc, path);
    if (value != null && !Array.isArray(value)) {
      for (const section of ["headings", "images", "links"] as const)
        note(section, "A Portable Text mapping is not an array.");
      continue;
    }
    for (const block of entries(value, path, ["headings", "images", "links"])) {
      if (block.value._type === "image") {
        addImage(block.value, block.path);
        continue;
      }
      if (block.value._type !== "block") {
        for (const section of ["headings", "images", "links"] as const)
          note(
            section,
            "Custom Portable Text blocks need explicit SEO mappings; only standard blocks were inspected.",
          );
        continue;
      }
      const children = block.value.children;
      if (
        !Array.isArray(children) ||
        children.some(
          (child) => !record(child) || child._type !== "span" || typeof child.text !== "string",
        )
      ) {
        note("headings", "Some Portable Text spans could not be inspected.");
        note("links", "Some Portable Text link labels could not be inspected.");
        continue;
      }
      const spans = children as { text: string; marks?: unknown }[];
      if (/^h[1-6]$/.test(String(block.value.style)))
        limitedPush(
          headings,
          {
            path: block.path,
            level: Number(String(block.value.style).slice(1)),
            text: text(spans.map((s) => s.text).join(""), "headings") ?? "",
          },
          "headings",
        );
      for (const mark of entries(block.value.markDefs, [...block.path, "markDefs"], ["links"])) {
        if (mark.value._type !== "link" && mark.value._type !== "internalLink") {
          note("links", "Custom Portable Text annotations were not inspected as links.");
          continue;
        }
        const label = text(
          spans
            .filter((s) => Array.isArray(s.marks) && s.marks.includes(mark.value._key))
            .map((s) => s.text)
            .join(""),
          "links",
        );
        addLink(mark.value, mark.path, ["href"], label);
      }
    }
  }
  for (const image of config.images ?? [])
    for (const entry of entries(readPath(doc, image.path), image.path, ["images"]))
      addImage(entry.value, entry.path, image.alt, image.decorative);
  for (const link of config.links ?? [])
    for (const entry of entries(readPath(doc, link.path), link.path, ["links"]))
      addLink(
        entry.value,
        entry.path,
        link.href,
        link.text ? text(readPath(entry.value, link.text), "links") : null,
        link.reference,
      );
  const ids = [...new Set(links.flatMap((l) => (l.reference ? [l.reference.id] : [])))];
  input.signal.throwIfAborted();
  if (ids.length) {
    try {
      const response = await input.query(
        "*[_id in $ids][0...100]{_id}",
        { ids },
        input.signal,
        perspective,
      );
      if (!Array.isArray(response) || response.some((r) => !record(r) || typeof r._id !== "string"))
        throw new Error("Invalid reference response");
      const found = new Set(response.map((r) => publishedId(r._id)));
      for (const link of links)
        if (link.reference) link.reference.exists = found.has(link.reference.id);
    } catch {
      input.signal.throwIfAborted();
      note("links", "Linked documents could not be read. Reference availability is unverified.");
    }
  }
  const duplicates: SeoEvidence["duplicates"] = config.duplicates === false ? null : [];
  const locale = input.mapping.locale ? readPath(doc, input.mapping.locale) : undefined;
  if (duplicates)
    for (const name of ["title", "description", "slug"] as const) {
      const value = fields[name];
      if (!value?.value?.trim()) continue;
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
        const query = `*[_type == $type && !(_id in $self) && ${formatPath(value.path)} == $value${sameLocale}] | order(_id asc)[0...11]{_id, _type}`;
        const response = await input.query(
          query,
          {
            type: doc._type,
            self: [doc._id, publishedId(doc._id), `drafts.${publishedId(doc._id)}`],
            value: value.value,
            ...(input.mapping.locale ? { locale } : {}),
          },
          input.signal,
          perspective,
        );
        if (
          !Array.isArray(response) ||
          response.length > 11 ||
          response.some(
            (r) => !record(r) || typeof r._id !== "string" || typeof r._type !== "string",
          )
        )
          throw new Error("Invalid duplicate response");
        duplicates.push({
          field: name,
          path: value.path,
          matches: response
            .slice(0, 10)
            .map((r) => ({ documentId: publishedId(r._id), documentType: r._type })),
          more: response.length > 10,
        });
      } catch {
        input.signal.throwIfAborted();
        note(
          "duplicates",
          `The ${name} comparison could not be completed. No uniqueness claim is made.`,
        );
      }
    }
  input.signal.throwIfAborted();
  const evidence: Omit<SeoEvidence, "fingerprint"> = {
    version: 1,
    sanityProjectId: input.sanityProjectId,
    dataset: input.dataset,
    documentId: doc._id,
    documentType: doc._type,
    revision: doc._rev,
    perspective,
    fields,
    primaryHeadingMapped: !!config.primaryHeading,
    headings: config.primaryHeading || portablePaths.length ? headings : null,
    images: config.images?.length || portablePaths.length ? images : null,
    links: config.links?.length || portablePaths.length ? links : null,
    duplicates,
    limitations,
  };
  return { ...evidence, fingerprint: await snapshotFingerprint(evidence) };
}
