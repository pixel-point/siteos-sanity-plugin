import { describe, expect, it } from "vitest";
import { contentTextDiff, findingContext } from "./text-diff.js";

describe("content suggestion evidence", () => {
  it("highlights changed words without turning shared context into a correction", () => {
    const result = contentTextDiff(
      "Create an acount to get started.",
      "Create an account to get started.",
    );
    expect(
      result.original
        .filter((p) => p.changed)
        .map((p) => p.text)
        .join(""),
    ).toBe("acount");
    expect(
      result.replacement
        .filter((p) => p.changed)
        .map((p) => p.text)
        .join(""),
    ).toBe("account");
    expect(
      contentTextDiff("Already correct.", "Already correct.").original.some((p) => p.changed),
    ).toBe(false);
  });
  it("preserves Unicode, line breaks and multiple independent corrections verbatim", () => {
    const before = "Él  a escrito\n«превет» 👋 y ella an leído.";
    const after = "Él  ha escrito\n«привет» 👋 y ella ha leído.";
    const diff = contentTextDiff(before, after);
    expect(diff.original.map((p) => p.text).join("")).toBe(before);
    expect(diff.replacement.map((p) => p.text).join("")).toBe(after);
    expect(diff.original.filter((p) => p.changed).map((p) => p.text)).toEqual([
      "a",
      "превет",
      "an",
    ]);
    expect(contentTextDiff("Hello!", "Hello").replacement).toEqual([
      { text: "Hello", changed: false },
    ]);
  });
  it("bounds large suggestions while retaining every source character", () => {
    const prefix = "Same context. ".repeat(500);
    const before = prefix + "old text\n";
    const after = prefix + "new text\n";
    const result = contentTextDiff(before, after);
    expect(result.original.map((p) => p.text).join("")).toBe(before);
    expect(result.replacement.map((p) => p.text).join("")).toBe(after);
    expect(
      result.original
        .filter((p) => p.changed)
        .map((p) => p.text)
        .join(""),
    ).toBe("old");
    expect(contentTextDiff("", "new").replacement).toEqual([{ text: "new", changed: true }]);
  });

  it("uses exact nearby context only when the quote identifies one occurrence", () => {
    expect(findingContext("Create an acount today.", "acount")).toEqual({
      before: "Create an ",
      after: " today.",
      unique: true,
    });
    expect(findingContext("acount or acount", "acount")).toEqual({
      before: "",
      after: "",
      unique: false,
    });
    const context = findingContext("👋".repeat(200) + "acount" + "é".repeat(200), "acount");
    expect(context.before).toBe("…" + "👋".repeat(100));
    expect(context.after).toBe("é".repeat(100) + "…");
  });
});
