import { record } from "./content-tree.js";
import type { FieldPath } from "./types.js";

const humanize = (name: string) => {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const title = (shape: unknown, fallback: string) =>
  record(shape) && typeof shape.title === "string" && shape.title.trim()
    ? shape.title
    : humanize(fallback);

/** Display schema titles; navigation continues to use the original, stable keyed path. */
export function fieldLabel(schema: unknown, value: unknown, path: FieldPath): string {
  const labels: string[] = [];
  for (const part of path) {
    if (typeof part === "string") {
      const fields = record(schema) && Array.isArray(schema.fields) ? schema.fields : [];
      const field = fields.find((item) => record(item) && item.name === part);
      schema = record(field) ? field.type : undefined;
      labels.push(title(field, title(schema, part)));
      value = record(value) ? value[part] : undefined;
    } else {
      const items = Array.isArray(value) ? value : [];
      const index = items.findIndex((item) => record(item) && item._key === part._key);
      value = index >= 0 ? items[index] : undefined;
      const members = record(schema) && Array.isArray(schema.of) ? schema.of : [];
      const memberType = record(value) ? value._type : undefined;
      schema =
        typeof memberType === "string"
          ? members.find((item) => record(item) && item.name === memberType)
          : members.length === 1
            ? members[0]
            : undefined;
      const name = record(schema) && typeof schema.name === "string" ? schema.name : "Item";
      labels.push(`${title(schema, name)}${index >= 0 ? ` (${index + 1})` : ""}`);
    }
  }
  return labels.join(" › ") || "Document";
}
