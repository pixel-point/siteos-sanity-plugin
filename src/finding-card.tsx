import { Badge, Box, Button, Card, Flex, Stack, Text } from "@sanity/ui";
import { useMemo } from "react";
import { contentTextDiff, findingContext, type TextPart } from "./text-diff.js";
import type { Finding, Source } from "./types.js";

const kinds: Record<Finding["kind"], string> = {
  metadata: "Metadata mismatch",
  heading: "Heading mismatch",
  placeholder: "Unfinished text",
  spelling: "Spelling",
  grammar: "Grammar",
};

export function sourceLabel(source: Source) {
  return source.path
    .filter((part): part is string => typeof part === "string")
    .map((part) => {
      const words = part.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" › ");
}

function HighlightedText({ parts, suggested = false }: { parts: TextPart[]; suggested?: boolean }) {
  return parts.map((part, index) =>
    part.changed && part.text.trim() ? (
      <Card
        key={index}
        as="mark"
        tone={suggested ? "positive" : "critical"}
        style={{
          display: "inline",
          padding: "1px 2px",
          borderRadius: 3,
          boxDecorationBreak: "clone",
          textDecoration: suggested ? "underline" : "underline wavy",
          textUnderlineOffset: "4px",
        }}
      >
        {part.text}
      </Card>
    ) : (
      part.text
    ),
  );
}

export function FindingCard({
  finding,
  source,
  related,
  disabled,
  onOpen,
  onApply,
}: {
  finding: Finding;
  source: Source;
  related: boolean;
  disabled: boolean;
  onOpen(): void;
  onApply(): void;
}) {
  const diff = useMemo(
    () => contentTextDiff(finding.quote, finding.replacement),
    [finding.quote, finding.replacement],
  );
  const context = useMemo(
    () => findingContext(source.text, finding.quote),
    [source.text, finding.quote],
  );
  const removal = finding.action === "remove";
  const canApply = source.editable && context.unique;
  return (
    <Card border radius={3} padding={4}>
      <Stack gap={4}>
        <Flex gap={3} align="center" wrap="wrap">
          <Badge tone="caution" fontSize={1}>
            {kinds[finding.kind]}
          </Badge>
          <Text size={1} weight="semibold">
            {sourceLabel(source)}
          </Text>
          {related && <Badge fontSize={0}>Related document</Badge>}
        </Flex>
        <Box
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: 12,
          }}
        >
          <Card muted radius={2} padding={4}>
            <Stack gap={3}>
              <Text size={0} muted>
                Original text
              </Text>
              <Text
                size={2}
                style={{ lineHeight: 1.8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {context.before}
                <HighlightedText parts={diff.original} />
                {context.after}
              </Text>
            </Stack>
          </Card>
          <Card muted radius={2} padding={4}>
            <Stack gap={3}>
              <Text size={0} muted>
                {removal ? "Suggested removal" : "Suggested change"}
              </Text>
              <Text
                size={2}
                style={{ lineHeight: 1.8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {removal ? (
                  "Remove this unfinished text."
                ) : (
                  <>
                    {context.before}
                    <HighlightedText parts={diff.replacement} suggested />
                    {context.after}
                  </>
                )}
              </Text>
            </Stack>
          </Card>
        </Box>
        <Text size={1} muted style={{ lineHeight: 1.6, overflowWrap: "anywhere" }}>
          {finding.explanation}
        </Text>
        {!canApply && (
          <Text size={1} muted>
            {!context.unique
              ? "This text appears more than once. Open the field to choose the occurrence to edit."
              : related
                ? "Open the related document to make this correction."
                : "Open the editor to make this correction in the source field."}
          </Text>
        )}
        <Flex gap={2} wrap="wrap">
          {canApply && (
            <Button text="Apply correction" tone="primary" disabled={disabled} onClick={onApply} />
          )}
          <Button text="Open field" mode="ghost" onClick={onOpen} />
        </Flex>
      </Stack>
    </Card>
  );
}
