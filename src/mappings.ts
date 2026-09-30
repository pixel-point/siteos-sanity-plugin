import { assertPath, readPath } from "./paths.js";
import type { DocumentMapping, DocumentValue, FieldPath, MappingContext } from "./types.js";

export function validateMappings(mappings: Record<string, DocumentMapping>): void {
  if (!Object.keys(mappings).length) throw new Error("Configure at least one document type.");
  for (const [type, mapping] of Object.entries(mappings)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(type) ||
      !Array.isArray(mapping.fields) ||
      !mapping.fields.length
    )
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
    if (mapping.resolve !== undefined && typeof mapping.resolve !== "function")
      throw new Error("A document mapping resolver must be a synchronous function.");
    if (mapping.reviewLocales) {
      const { options, default: defaultLocale } = mapping.reviewLocales;
      if (
        !Array.isArray(options) ||
        !options.length ||
        !options.some((item) => item.id === defaultLocale)
      )
        throw new Error("Review languages require options and a matching default language.");
      const ids = new Set<string>();
      for (const option of options) {
        if (!validLocale(option.id) || !option.title?.trim() || ids.has(option.id))
          throw new Error("Review languages require unique IDs and non-empty titles.");
        ids.add(option.id);
      }
    }
  }
}

const validLocale = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

/** Document language owns localized pages; a selection is only used for shared documents. */
export function reviewLocale(
  document: DocumentValue,
  mapping: DocumentMapping,
  selected?: string | null,
): string | null {
  if (mapping.locale) {
    const value = readPath(document, mapping.locale);
    return validLocale(value) ? value : null;
  }
  const languages = mapping.reviewLocales;
  if (!languages) return null;
  return languages.options.some((option) => option.id === selected) ? selected! : languages.default;
}

/** Resolvers select real source paths, never rewritten or synthetic document contents. */
export function resolveDocumentMapping(
  mapping: DocumentMapping,
  context: Omit<MappingContext, "locale"> & { locale: string | null },
): DocumentMapping {
  if (!mapping.resolve) return mapping;
  if (!context.locale)
    throw new Error(
      "Choose a review language or configure the document's language before checking localized content.",
    );
  const overrides = mapping.resolve({ ...structuredClone(context), locale: context.locale });
  if (
    !overrides ||
    typeof overrides !== "object" ||
    Array.isArray(overrides) ||
    "then" in overrides
  )
    throw new Error("A mapping resolver must return synchronous field settings.");
  if (
    Object.keys(overrides).some((key) => !["fields", "seo", "references", "exclude"].includes(key))
  )
    throw new Error("A mapping resolver can change fields, SEO, references and exclusions only.");
  const resolved = { ...mapping, ...overrides, resolve: undefined };
  validateMappings({ [context.document._type]: resolved });
  return resolved;
}

/** Select one internationalized-array value, retaining its actual stable key for navigation/patches. */
export function localizedArrayPath(
  document: DocumentValue,
  path: FieldPath,
  options: {
    locale: string;
    fallbackLocale?: string;
    fallbackToFirst?: boolean;
    valuePath?: FieldPath;
  },
): FieldPath {
  assertPath(path);
  const valuePath = options.valuePath ?? ["value"];
  assertPath(valuePath);
  if (
    !validLocale(options.locale) ||
    (options.fallbackLocale !== undefined && !validLocale(options.fallbackLocale))
  )
    throw new Error("Localized fields require valid language IDs.");
  const values = readPath(document, path);
  if (values != null && !Array.isArray(values))
    throw new Error("The localized field must be an array.");
  const items = (values ?? []) as unknown[];
  const keyed = items.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  const available = (item: Record<string, unknown>) => {
    const value = readPath(item, valuePath);
    // Match the website's truthy-value fallback; whitespace is still a selected translation.
    return typeof value === "string" && !!value;
  };
  const chosen =
    keyed.find((item) => item._key === options.locale && available(item)) ??
    (options.fallbackLocale
      ? keyed.find((item) => item._key === options.fallbackLocale && available(item))
      : undefined) ??
    (options.fallbackToFirst ? keyed.find(available) : undefined);
  const key = chosen?._key ?? options.locale;
  if (typeof key !== "string" || (chosen && keyed.filter((item) => item._key === key).length !== 1))
    throw new Error("The selected translation must have a unique stable key.");
  const selectedPath = [...path, { _key: key }, ...valuePath];
  assertPath(selectedPath);
  return selectedPath;
}

/** Include resolver definitions in immediate change detection; collected evidence also hashes resolved settings. */
export function serializeReviewInput(
  document: DocumentValue | null,
  mappings: Record<string, DocumentMapping>,
  locale: string | null,
): string {
  return JSON.stringify({ document, mappings, locale }, (_key, value) =>
    typeof value === "function" ? value.toString() : value,
  );
}
