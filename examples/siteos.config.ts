import type { SiteosPluginOptions } from "@siteoshq/sanity";

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
