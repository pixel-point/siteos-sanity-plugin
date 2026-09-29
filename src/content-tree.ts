import { assertPath, readPath } from "./paths.js";
import type { FieldPath } from "./types.js";

/** The compiled Studio schema is inspected locally; it is never sent to SiteOS. */
export type StudioSchema = { get(name: string): unknown };
type Shape = { name?: string; type?: unknown; fields?: unknown; of?: unknown; options?: unknown };
export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function schemaIs(schema: unknown, name: string): boolean {
  const seen = new Set<unknown>();
  while (record(schema) && !seen.has(schema)) {
    seen.add(schema);
    if (schema.name === name) return true;
    schema = schema.type;
  }
  return false;
}
export function schemaField(schema: unknown, name: string): unknown {
  if (!record(schema)) return undefined;
  const fields = (schema as Shape).fields;
  return Array.isArray(fields)
    ? fields.find((field) => record(field) && field.name === name)?.type
    : undefined;
}
function schemaMember(schema: unknown, value: unknown): unknown {
  if (!record(schema) || !Array.isArray(schema.of)) return undefined;
  return schema.of.find((member) => record(member) && record(value) && member.name === value._type);
}
export function schemaAt(schema: unknown, value: unknown, path: FieldPath): unknown {
  for (const part of path) {
    if (typeof part === "string") {
      schema = schemaField(schema, part);
      value = record(value) ? value[part] : undefined;
    } else {
      value = Array.isArray(value)
        ? value.find((item) => record(item) && item._key === part._key)
        : undefined;
      schema = schemaMember(schema, value);
    }
  }
  return schema;
}

const technical =
  /^(?:code|doCode|dontCode|html|css|javascript|script|query|language|locale|style|variant|theme|layout|alignment|align|color|icon|filename|sectionId|id|slug|url|href|src|target|rel|type|size|animation|className|class|trackingId)$/i;
const nonProseType = [
  "code",
  "url",
  "slug",
  "date",
  "datetime",
  "email",
  "color",
  "file",
  "geopoint",
];
export type ContentNode = {
  value: unknown;
  path: FieldPath;
  schema: unknown;
  parent: Record<string, unknown> | null;
  readonly?: boolean;
};

/** Enumerates selected JSON only. Arrays require unique keys; no numeric correction paths. */
export function walkContent(input: {
  value: unknown;
  path: FieldPath;
  schema?: unknown;
  signal: AbortSignal;
  exclude?: readonly FieldPath[];
  onNode(node: ContentNode): boolean | void;
  onIssue(path: FieldPath, message: string): void;
}) {
  const pending: ContentNode[] = [
    { value: input.value, path: input.path, schema: input.schema, parent: null },
  ];
  while (pending.length) {
    input.signal.throwIfAborted();
    const node = pending.pop()!;
    if (
      input.exclude?.some(
        (path) =>
          path.length <= node.path.length &&
          path.every((part, i) => JSON.stringify(part) === JSON.stringify(node.path[i])),
      )
    )
      continue;
    try {
      assertPath(node.path);
    } catch {
      input.onIssue(node.path.slice(0, 32), "This content has no supported stable field path.");
      continue;
    }
    if (input.onNode(node) === false) continue;
    if (Array.isArray(node.value)) {
      const counts = new Map<string, number>();
      for (const value of node.value)
        if (record(value) && typeof value._key === "string")
          counts.set(value._key, (counts.get(value._key) ?? 0) + 1);
      const children: ContentNode[] = [];
      for (const value of node.value) {
        if (typeof value === "string") {
          input.onNode({ ...node, value, readonly: true });
          continue;
        }
        if (value == null || typeof value === "number" || typeof value === "boolean") continue;
        if (
          !record(value) ||
          typeof value._key !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value._key) ||
          counts.get(value._key) !== 1
        ) {
          input.onIssue(
            node.path,
            "Some array values have no unique stable key. Map their rendered text explicitly.",
          );
          continue;
        }
        children.push({
          value,
          path: [...node.path, { _key: value._key }],
          schema: schemaMember(node.schema, value),
          parent: null,
        });
      }
      pending.push(...children.reverse());
    } else if (record(node.value)) {
      const children = Object.entries(node.value).filter(
        ([key]) =>
          !key.startsWith("_") && !["asset", "crop", "hotspot", "markDefs", "marks"].includes(key),
      );
      for (const [key, value] of children.reverse())
        pending.push({
          value,
          path: [...node.path, key],
          schema: schemaField(node.schema, key),
          parent: node.value,
        });
    }
  }
}
export function isNonProse(node: ContentNode): boolean {
  const key = node.path.at(-1);
  if (
    typeof key === "string" &&
    (technical.test(key) || /(?:Url|Href|Id|Ids|Token|Secret|Password|ApiKey)$/.test(key))
  )
    return true;
  if (nonProseType.some((name) => schemaIs(node.schema, name))) return true;
  if (record(node.schema) && record(node.schema.options) && Array.isArray(node.schema.options.list))
    return true;
  return (
    record(node.value) &&
    (node.value._type === "code" || node.value._type === "slug" || node.value._type === "file")
  );
}
export function portableText(value: Record<string, unknown>): { text: string; complete: boolean } {
  if (!Array.isArray(value.children)) return { text: "", complete: false };
  return {
    text: value.children
      .map((child) =>
        record(child) && child._type === "span" && typeof child.text === "string" ? child.text : "",
      )
      .join(""),
    complete: value.children.every(
      (child) => record(child) && child._type === "span" && typeof child.text === "string",
    ),
  };
}
export function validReference(
  value: unknown,
): value is Record<string, unknown> & { _ref: string } {
  return (
    record(value) &&
    typeof value._ref === "string" &&
    /^[A-Za-z0-9_.-]{1,200}$/.test(value._ref) &&
    !value._ref.startsWith("versions.") &&
    !value._projectId &&
    !value._dataset
  );
}
export function inheritedImageText(node: ContentNode, key: string): unknown {
  return record(node.value) && Object.hasOwn(node.value, key)
    ? readPath(node.value, [key])
    : node.parent?.[key];
}
