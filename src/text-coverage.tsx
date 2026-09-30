import { Badge, Button, Card, Flex, Heading, Stack, Text } from "@sanity/ui";
import type { CheckResult, ContentSnapshot, SourceIssue } from "./types.js";
import { textReviewCoverage } from "./text-review.js";

export function TextCoverage({
  snapshot,
  result,
  label,
  onOpen,
}: {
  snapshot: ContentSnapshot;
  result: CheckResult | null;
  label(issue: SourceIssue): string;
  onOpen(issue: SourceIssue): void;
}) {
  const coverage = textReviewCoverage(snapshot, result);
  if (!coverage.partial && !coverage.notes.length) return null;
  return (
    <Card padding={4} radius={3} tone={coverage.partial ? "caution" : "default"} border>
      <Stack gap={4}>
        <Flex gap={3} align="center" wrap="wrap">
          <Heading size={1}>Review coverage</Heading>
          {coverage.partial && <Badge tone="caution">Incomplete</Badge>}
        </Flex>
        {!!snapshot.issues.length && (
          <Text size={1} style={{ lineHeight: 1.6 }}>
            Some selected content was not included. Text results apply only to the included content.
          </Text>
        )}
        {coverage.unfinished && (
          <Text size={1} style={{ lineHeight: 1.6 }}>
            {result?.coverage
              ? `${result.coverage.completed} of ${result.coverage.total} parts completed. Run the check again to finish reviewing the included text.`
              : "The text check did not finish. Run it again to review all included text."}
          </Text>
        )}
        {coverage.groups.map(([message, issues]) => (
          <Stack key={message} gap={3}>
            <Text size={1} style={{ lineHeight: 1.6 }}>
              {message}
            </Text>
            <details open={issues.length === 1}>
              <summary>Show affected fields ({issues.length})</summary>
              <Stack gap={2} paddingTop={3}>
                {issues.map((issue, index) => (
                  <Button
                    key={index}
                    mode="ghost"
                    text={`Open ${label(issue)}`}
                    onClick={() => onOpen(issue)}
                  />
                ))}
              </Stack>
            </details>
          </Stack>
        ))}
        {coverage.notes.map((note, index) => (
          <Text key={index} size={1} muted style={{ lineHeight: 1.6 }}>
            {note}
          </Text>
        ))}
      </Stack>
    </Card>
  );
}
