import { useState } from "react";
import { Badge, Box, Button, Card, Flex, Heading, Stack, Text } from "@sanity/ui";
import type { SeoCheckResult, SeoEvidence } from "./seo-types.js";
import type { FieldPath } from "./types.js";

const labels = {
  passed: "Checked",
  attention: "Review",
  partial: "Partially checked",
  "not-configured": "Not configured",
} as const;
export function SeoPanel({
  result,
  evidence,
  onNavigate,
}: {
  result: SeoCheckResult | null;
  evidence: SeoEvidence | null;
  onNavigate(documentId: string, documentType: string, path: FieldPath): void;
}) {
  const [visible, setVisible] = useState(50);
  if (!result || !evidence)
    return (
      <Card border radius={3} padding={4}>
        <Stack gap={3}>
          <Heading size={1}>Review SEO before publishing</Heading>
          <Text size={1} muted style={{ lineHeight: 1.6 }}>
            Check mapped titles, descriptions, heading structure, image alt text, links, slugs and
            duplicate values, canonical overrides, indexing preferences, social images and focus
            keywords. This check uses rules and does not call an AI provider.
          </Text>
          <Text size={1} muted>
            Fields that are not configured are shown as not checked.
          </Text>
        </Stack>
      </Card>
    );
  const findings = result.sections.flatMap((s) => s.findings);
  const incomplete = result.sections.filter(
    (s) => s.status === "partial" || s.status === "not-configured",
  ).length;
  return (
    <Stack gap={4}>
      <Flex align="center" gap={3} wrap="wrap">
        <Badge fontSize={0}>
          {evidence.perspective === "drafts" ? "Draft content" : "Published content"}
        </Badge>
        <Text size={1}>
          {findings.length
            ? `Items to review: ${findings.length}`
            : "No issues found in checked fields"}
        </Text>
        {!!incomplete && (
          <Badge tone="caution">Sections needing configuration or review: {incomplete}</Badge>
        )}
      </Flex>
      {result.sections.map((section) => (
        <Card key={section.id} border radius={3} padding={4}>
          <Stack gap={4}>
            <Flex align="center" gap={3} justify="space-between" wrap="wrap">
              <Heading size={1}>{section.title}</Heading>
              <Badge
                tone={
                  section.status === "passed"
                    ? "positive"
                    : section.status === "not-configured"
                      ? "default"
                      : "caution"
                }
              >
                {labels[section.status]}
              </Badge>
            </Flex>
            {section.status === "not-configured" && (
              <Text size={1} muted>
                Configure this section in the plugin's document mapping to check it.
              </Text>
            )}
            {section.details.map((detail, index) => (
              <Text
                key={index}
                size={1}
                muted
                style={{ lineHeight: 1.6, overflowWrap: "anywhere" }}
              >
                {detail}
              </Text>
            ))}
            {section.findings.slice(0, visible).map((finding) => (
              <Card key={finding.id} padding={3} radius={2} muted>
                <Stack gap={3}>
                  <Flex align="center" gap={2} wrap="wrap">
                    <Badge
                      tone={finding.severity === "notice" ? "default" : "caution"}
                      fontSize={0}
                    >
                      {finding.severity === "notice" ? "Recommendation" : "Needs attention"}
                    </Badge>
                    <Text size={1} weight="semibold">
                      {finding.title}
                    </Text>
                  </Flex>
                  <Text size={1} style={{ lineHeight: 1.6 }}>
                    {finding.message}
                  </Text>
                  <Flex gap={2} wrap="wrap">
                    <Button
                      text="Open field"
                      mode="ghost"
                      fontSize={1}
                      onClick={() =>
                        onNavigate(evidence.documentId, evidence.documentType, finding.path)
                      }
                    />
                    {finding.relatedDocument && (
                      <Button
                        text="Open matching document"
                        mode="ghost"
                        fontSize={1}
                        onClick={() =>
                          onNavigate(
                            finding.relatedDocument!.id,
                            finding.relatedDocument!.type,
                            finding.path,
                          )
                        }
                      />
                    )}
                  </Flex>
                </Stack>
              </Card>
            ))}
            {section.findings.length > visible && (
              <Button
                text={`Show more findings (${section.findings.length - visible} remaining)`}
                mode="ghost"
                onClick={() => setVisible((count) => count + 50)}
              />
            )}
          </Stack>
        </Card>
      ))}
      <Box>
        <Text size={0} muted style={{ lineHeight: 1.6 }}>
          CMS fields only. Published canonical tags, robots directives, HTTP status, rendered HTML
          and Google indexing require a separate website audit. Other documents may change after
          this check; run it again before relying on duplicate results.
        </Text>
      </Box>
    </Stack>
  );
}
