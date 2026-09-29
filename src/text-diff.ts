export type TextPart = { text: string; changed: boolean };

/** Do not imply a source position when the saved quote has multiple matches. */
export function findingContext(text: string, quote: string) {
  const offset = text.indexOf(quote);
  if (!quote || offset < 0 || text.indexOf(quote, offset + 1) !== -1)
    return { before: "", after: "", unique: false };
  const before = Array.from(text.slice(0, offset));
  const after = Array.from(text.slice(offset + quote.length));
  return {
    before: (before.length > 100 ? "…" : "") + before.slice(-100).join(""),
    after: after.slice(0, 100).join("") + (after.length > 100 ? "…" : ""),
    unique: true,
  };
}

/** Presentation only: both sides reconstruct the saved evidence verbatim. */
export function contentTextDiff(before: string, after: string) {
  const tokens = (text: string) => text.match(/\s+|[\p{L}\p{N}\p{M}_]+|[^\s]/gu) ?? [];
  const left = tokens(before);
  const right = tokens(after);
  const original: TextPart[] = [];
  const replacement: TextPart[] = [];
  function append(parts: TextPart[], text: string, changed: boolean) {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.changed === changed) last.text += text;
    else parts.push({ text, changed });
  }
  // Keep unusually long saved suggestions inexpensive to render. The fallback still preserves
  // every character and only marks the unmatched middle, never invented or normalized text.
  if (left.length * right.length > 200_000) {
    let start = 0;
    let end = 0;
    while (start < Math.min(left.length, right.length) && left[start] === right[start]) start++;
    while (
      end < Math.min(left.length, right.length) - start &&
      left[left.length - end - 1] === right[right.length - end - 1]
    )
      end++;
    for (const [values, parts] of [
      [left, original],
      [right, replacement],
    ] as const) {
      append(parts, values.slice(0, start).join(""), false);
      append(parts, values.slice(start, values.length - end).join(""), true);
      append(parts, values.slice(values.length - end).join(""), false);
    }
    return { original, replacement };
  }
  const width = right.length + 1;
  const lengths = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        left[i] === right[j]
          ? 1 + lengths[(i + 1) * width + j + 1]!
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      append(original, left[i++]!, false);
      append(replacement, right[j++]!, false);
    } else if (
      i < left.length &&
      (j === right.length || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)
    ) {
      append(original, left[i++]!, true);
    } else append(replacement, right[j++]!, true);
  }
  return { original, replacement };
}
