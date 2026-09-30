import {
  localizedArrayPath,
  type DocumentMapping,
  type SiteosPluginOptions,
} from "@siteoshq/sanity";

// Adapt document type names and field paths to your existing Sanity schemas.
// The example expects page.title, page.description, page.body (Portable Text),
// page.slug, page.author (reference), author.name and author.biography.
export const siteosOptions = {
  documentTypes: {
    page: {
      fields: [
        { path: ["title"], role: "title", required: true },
        { path: ["description"], role: "description", required: true },
        { path: ["body"], role: "body", format: "portableText" },
      ],
      references: [["author"]],
      seo: {
        slug: ["slug", "current"],
        // For page builders add a field with format: "content" at the editorial root.
        // Optional schema-specific settings:
        // canonicalUrl: ["seo", "canonicalUrl"], noIndex: ["seo", "noIndex"],
        // socialImage: ["seo", "socialImage"], focusKeyword: ["seo", "focusKeyword"],
        // titleFallback: {path: ["title"]}, descriptionFallback: "Actual website default",
        // customTypes: {callout: {headings: [{path: ["title"], level: 2}]}},
        // Add primaryHeading: ["title"] only if your website renders title as its H1.
        // Add images: [{path: ["heroImage"], alt: ["alt"]}] for separate image fields.
      },
      // Add locale: ["language"] only when your schema contains this field.
    },
    author: {
      fields: [
        { path: ["name"], role: "heading" },
        { path: ["biography"], role: "body" },
      ],
    },
  },
} satisfies SiteosPluginOptions;

// Optional example for shared authors with internationalized-array fields.
// The root article maps locale: ["language"]. References inherit that article's language.
export const localizedAuthorMapping: DocumentMapping = {
  fields: [{ path: ["name"], role: "heading" }],
  reviewLocales: {
    options: [
      { id: "en", title: "English" },
      { id: "es", title: "Español" },
    ],
    default: "en",
  },
  resolve: ({ document, locale }) => ({
    fields: [
      { path: ["name"], role: "heading" },
      ...["jobTitle", "description"].map((field) => ({
        path: localizedArrayPath(document, [field], {
          locale,
          fallbackLocale: "en",
          fallbackToFirst: true,
        }),
        role: "body" as const,
      })),
    ],
  }),
};

// Use the same selection for a shared category name. Merge the project's existing
// SEO fields/settings explicitly if the website uses them for category metadata.
export const localizedCategoryMapping: DocumentMapping = {
  fields: [{ path: ["name", { _key: "en" }, "value"], role: "heading" }],
  reviewLocales: localizedAuthorMapping.reviewLocales,
  resolve: ({ document, locale }) => ({
    fields: [
      {
        path: localizedArrayPath(document, ["name"], {
          locale,
          fallbackLocale: "en",
          fallbackToFirst: true,
        }),
        role: "heading",
      },
    ],
  }),
};
