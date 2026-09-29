import type { FieldPath } from "./types.js";

export function assertPath(path: FieldPath): void {
  if (!Array.isArray(path) || !path.length || path.length > 32)
    throw new Error("Invalid field path.");
  for (const part of path) {
    if (typeof part === "string") {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(part) || ["constructor", "prototype"].includes(part))
        throw new Error("Use schema field names and stable array keys in paths.");
    } else if (
      !part ||
      typeof part._key !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(part._key)
    ) {
      throw new Error("Array paths require a stable _key.");
    }
  }
}

export function readPath(value: unknown, path: FieldPath): unknown {
  assertPath(path);
  let current = value;
  for (const part of path) {
    if (typeof part === "string") {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, part))
        return undefined;
      current = (current as Record<string, unknown>)[part];
    } else {
      if (!Array.isArray(current)) return undefined;
      const items = current.filter((item) => item && item._key === part._key);
      if (items.length !== 1) return undefined;
      current = items[0];
    }
  }
  return current;
}

export function formatPath(path: FieldPath): string {
  assertPath(path);
  return path
    .map((part, index) =>
      typeof part === "string"
        ? `${index ? "." : ""}${part}`
        : `[_key==${JSON.stringify(part._key)}]`,
    )
    .join("");
}

export function publishedId(id: string): string {
  return id.startsWith("drafts.") ? id.slice(7) : id;
}
